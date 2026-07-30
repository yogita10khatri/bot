/**
 * Proxy / VPN transport
 *
 * Polymarket geo-restricts a number of jurisdictions (India among them). The
 * bot therefore has to be able to send *every* outbound request through a
 * tunnel that exits in a permitted country.
 *
 * There are two ways to do that:
 *
 *  1. A full-tunnel VPN on the host (WireGuard / OpenVPN / a desktop VPN app,
 *     or the `gluetun` container in `docker-compose.vpn.yml`). Nothing in this
 *     file is needed for that case — the OS routes everything for us.
 *
 *  2. A per-process proxy (`PROXY_URL`). That is what this module implements.
 *     It is the safer option on a laptop, because only the bot is tunnelled
 *     and a proxy dropping out produces a connection error rather than a
 *     silent leak to the local exit IP.
 *
 * The bot talks to the network through four different transports, and each one
 * has to be patched separately:
 *
 *   | transport        | used by                                    |
 *   |------------------|--------------------------------------------|
 *   | `http`/`https`   | ethers v5 JSON-RPC, `ws` (WebSocket)       |
 *   | `axios`          | @polymarket/clob-client-v2                 |
 *   | `undici`         | global `fetch` (Gamma, Data API, subgraph) |
 *
 * `installProxy()` patches all of them from a single `PROXY_URL`.
 *
 * Supported proxy URLs:
 *   socks5://user:pass@host:1080     (also socks5h://, socks4://, socks://)
 *   http://user:pass@host:8080       (also https://)
 */

import http from 'http';
import https from 'https';
import net from 'net';
import { createRequire } from 'module';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { SocksClient, type SocksProxy } from 'socks';
import { Agent as BaseAgent, type AgentConnectOpts } from 'agent-base';
import {
  Agent as UndiciAgent,
  ProxyAgent as UndiciProxyAgent,
  buildConnector,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import type { Duplex } from 'stream';

// ============================================================================
// Types
// ============================================================================

export type ProxyKind = 'socks' | 'http';

export interface ProxyInfo {
  /** Proxy URL with any password redacted — safe to log. */
  url: string;
  kind: ProxyKind;
  host: string;
  port: number;
  /** Hosts that bypass the proxy and connect directly. */
  bypass: string[];
}

export interface InstallProxyOptions {
  /**
   * Proxy URL. Defaults to `PROXY_URL`, then `ALL_PROXY`, `HTTPS_PROXY`,
   * `https_proxy`, `HTTP_PROXY`, `http_proxy`.
   */
  url?: string;
  /**
   * Hosts to connect to directly instead of through the proxy. Defaults to
   * `NO_PROXY` (comma separated), plus localhost/loopback which are always
   * bypassed so the local dashboard keeps working.
   */
  bypass?: string[];
}

// ============================================================================
// Module state
// ============================================================================

/** Captured before we patch anything, so bypassed hosts get a real direct agent. */
const DIRECT_HTTP_AGENT = http.globalAgent;
const DIRECT_HTTPS_AGENT = https.globalAgent;

/** Always bypassed — these never leave the machine. */
const ALWAYS_BYPASS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];

let installed: ProxyInfo | null = null;

// ============================================================================
// URL parsing
// ============================================================================

const PROXY_ENV_VARS = [
  'PROXY_URL',
  'ALL_PROXY',
  'all_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
];

/**
 * Read a proxy URL out of the environment. Returns undefined when no proxy is
 * configured (i.e. the user is on a full-tunnel VPN, or not tunnelling at all).
 */
export function getProxyUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of PROXY_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseProxyUrl(raw: string): { url: URL; kind: ProxyKind } {
  // Tolerate `host:port` without a scheme — assume SOCKS5, which is what
  // commercial VPN providers hand out most often.
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : `socks5://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(
      `Invalid proxy URL: ${redact(raw)}. Expected something like ` +
        `socks5://user:pass@host:1080 or http://host:8080`
    );
  }

  const scheme = url.protocol.replace(':', '').toLowerCase();
  let kind: ProxyKind;
  if (scheme.startsWith('socks')) {
    kind = 'socks';
  } else if (scheme === 'http' || scheme === 'https') {
    kind = 'http';
  } else {
    throw new Error(
      `Unsupported proxy scheme "${scheme}". Use socks5://, socks4://, http:// or https://`
    );
  }

  if (!url.port) {
    url.port = kind === 'socks' ? '1080' : scheme === 'https' ? '443' : '8080';
  }

  return { url, kind };
}

/** Strip the password from a proxy URL so it can be logged. */
export function redact(raw: string): string {
  return raw.replace(/(\/\/[^:/@]*):([^@]*)@/, '$1:****@');
}

function socksVersionFromScheme(scheme: string): 4 | 5 {
  return scheme === 'socks4' || scheme === 'socks4a' ? 4 : 5;
}

// ============================================================================
// Bypass handling
// ============================================================================

/** `*.example.com`, `.example.com` and `example.com` all mean the same thing. */
function normalizeBypassEntry(entry: string): string {
  return entry.trim().toLowerCase().replace(/^\*?\./, '');
}

function shouldBypass(hostname: string | undefined, bypass: string[]): boolean {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  if (net.isIP(host) && (host === '127.0.0.1' || host === '::1')) return true;
  return bypass.some(entry => host === entry || host.endsWith(`.${entry}`));
}

/**
 * An agent that sends most traffic through `proxyAgent` but connects directly
 * for bypassed hosts. `agent-base` lets `connect()` return another agent, which
 * it then delegates the request to — that is how the direct path is wired.
 */
class BypassProxyAgent extends BaseAgent {
  constructor(
    private readonly proxyAgent: http.Agent,
    private readonly bypass: string[]
  ) {
    super();
  }

  connect(req: http.ClientRequest, opts: AgentConnectOpts): Promise<Duplex | http.Agent> | Duplex | http.Agent {
    if (shouldBypass(opts.host, this.bypass)) {
      return opts.secureEndpoint ? DIRECT_HTTPS_AGENT : DIRECT_HTTP_AGENT;
    }
    return this.proxyAgent;
  }
}

// ============================================================================
// undici (global fetch) connectors
// ============================================================================

/**
 * undici has no SOCKS support of its own, so we hand it a `connect` function
 * that opens the TCP tunnel via SOCKS and then, for https targets, upgrades the
 * resulting socket to TLS using undici's own connector.
 */
function buildSocksConnector(proxy: SocksProxy): buildConnector.connector {
  const tlsUpgrade = buildConnector({});

  return (options, callback) => {
    const port = Number(options.port) || (options.protocol === 'https:' ? 443 : 80);

    SocksClient.createConnection({
      proxy,
      command: 'connect',
      destination: { host: options.hostname, port },
    })
      .then(({ socket }) => {
        if (options.protocol === 'https:') {
          tlsUpgrade({ ...options, httpSocket: socket }, callback);
          return;
        }
        callback(null, socket.setNoDelay());
      })
      .catch(err => callback(err as Error, null));
  };
}

/**
 * undici dispatcher that routes through the proxy but keeps a direct dispatcher
 * for bypassed origins.
 */
function installUndiciDispatcher(
  proxyUrl: URL,
  kind: ProxyKind,
  bypass: string[]
): void {
  const direct = new UndiciAgent();

  const proxied =
    kind === 'socks'
      ? new UndiciAgent({
          connect: buildSocksConnector({
            host: proxyUrl.hostname,
            port: Number(proxyUrl.port),
            type: socksVersionFromScheme(proxyUrl.protocol.replace(':', '').toLowerCase()),
            ...(proxyUrl.username ? { userId: decodeURIComponent(proxyUrl.username) } : {}),
            ...(proxyUrl.password ? { password: decodeURIComponent(proxyUrl.password) } : {}),
          }),
        })
      : new UndiciProxyAgent({
          uri: `${proxyUrl.protocol}//${proxyUrl.host}`,
          ...(proxyUrl.username
            ? {
                token: `Basic ${Buffer.from(
                  `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
                ).toString('base64')}`,
              }
            : {}),
        });

  // A tiny router dispatcher: bypassed origins go direct, everything else is
  // proxied. `dispatch` is the only method undici requires of a dispatcher for
  // fetch, but we forward close/destroy so the process can exit cleanly.
  const router = {
    dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
      const origin = typeof opts.origin === 'string' ? new URL(opts.origin) : opts.origin;
      const target = shouldBypass(origin?.hostname, bypass) ? direct : proxied;
      return target.dispatch(opts, handler);
    },
    async close() {
      await Promise.all([direct.close(), proxied.close()]);
    },
    async destroy(err?: Error | null) {
      await Promise.all([direct.destroy(err ?? null), proxied.destroy(err ?? null)]);
    },
  };

  setGlobalDispatcher(router as unknown as Dispatcher);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Route all of the bot's outbound traffic through a proxy.
 *
 * Safe to call more than once; the first call wins. Returns `null` when no
 * proxy is configured, which is the correct state when the host itself is on a
 * full-tunnel VPN.
 *
 * Call this **before** anything constructs an HTTP client, an ethers provider
 * or a WebSocket — `src/bootstrap.ts` does that for you.
 */
export function installProxy(options: InstallProxyOptions = {}): ProxyInfo | null {
  if (installed) return installed;

  const raw = options.url ?? getProxyUrlFromEnv();
  if (!raw) return null;

  const { url, kind } = parseProxyUrl(raw);

  const bypass = [
    ...new Set([
      ...ALWAYS_BYPASS,
      ...(process.env.NO_PROXY ?? process.env.no_proxy ?? '')
        .split(',')
        .map(normalizeBypassEntry)
        .filter(Boolean),
      ...(options.bypass ?? []).map(normalizeBypassEntry),
    ]),
  ];

  const proxyAgent: http.Agent =
    kind === 'socks'
      ? new SocksProxyAgent(url.href, { keepAlive: true })
      : new HttpsProxyAgent(url.href, { keepAlive: true });

  const agent = new BypassProxyAgent(proxyAgent, bypass);

  // 1. Node's http/https global agents. Covers ethers v5 JSON-RPC (which calls
  //    https.request without an explicit agent) and the `ws` WebSocket client
  //    used by @polymarket/real-time-data-client.
  http.globalAgent = agent;
  https.globalAgent = agent;

  // 2. axios, used by @polymarket/clob-client-v2. `proxy: false` stops axios
  //    from *also* applying its own env-var proxy handling on top of the agent.
  installAxiosProxy(agent);

  // 3. undici, which backs the global `fetch` used by the Gamma/Data/subgraph
  //    clients. It ignores https.globalAgent entirely.
  installUndiciDispatcher(url, kind, bypass);

  installed = {
    url: redact(url.href),
    kind,
    host: url.hostname,
    port: Number(url.port),
    bypass,
  };

  return installed;
}

/**
 * Patch axios' defaults. This has to happen synchronously — the CLOB client can
 * fire its first request immediately after `installProxy()` returns, and an
 * `await import('axios')` would lose that race and leak the request to the
 * local exit IP. `createRequire` gives us a synchronous load of axios' CJS
 * build. axios ships as a transitive dependency of clob-client-v2.
 */
function installAxiosProxy(agent: http.Agent): void {
  try {
    const require = createRequire(import.meta.url);
    const axios = require('axios');
    const defaults = axios.default?.defaults ?? axios.defaults;
    defaults.httpAgent = agent;
    defaults.httpsAgent = agent;
    defaults.proxy = false;
  } catch {
    /* axios not installed — nothing using it, nothing to patch */
  }
}

/** The proxy currently in force, or null when running direct / full-tunnel VPN. */
export function getInstalledProxy(): ProxyInfo | null {
  return installed;
}

/** Test hook: forget the installed proxy without restoring the patched globals. */
export function resetProxyStateForTests(): void {
  installed = null;
}
