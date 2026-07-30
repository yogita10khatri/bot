/**
 * Geo preflight
 *
 * Confirms, before the bot risks any capital, that outbound traffic is actually
 * leaving from a permitted country and that Polymarket's CLOB is reachable and
 * not serving a geoblock.
 *
 * This matters most for the failure mode that costs money: a VPN or proxy that
 * silently drops mid-session. Without a check, the bot keeps running, every
 * order gets rejected, and a strategy holding an open position cannot exit.
 * `assertTradingRegion()` turns that into a loud error at startup, and
 * `startGeoWatchdog()` keeps checking while the bot runs.
 *
 * Note that the check reflects the *exit IP*, which is not the same thing as
 * being eligible to trade. Polymarket's Terms of Service restrict access from
 * certain jurisdictions, and using a tunnel to get around that is a breach of
 * those terms that can lead to a locked account and frozen funds regardless of
 * what this file reports. Read `docs/VPN_SETUP.md` before you enable trading.
 */

import { getInstalledProxy } from './proxy.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * ISO 3166-1 alpha-2 codes Polymarket restricts. Not exhaustive and not legal
 * advice — Polymarket changes this list, so treat it as a tripwire rather than
 * a source of truth. Override with `BLOCKED_COUNTRIES`.
 */
export const DEFAULT_BLOCKED_COUNTRIES = [
  'US', // United States (CFTC settlement)
  'IN', // India
  'FR', // France
  'BE', // Belgium
  'PL', // Poland
  'TH', // Thailand
  'SG', // Singapore
  'GB', // United Kingdom
  'AU', // Australia
  'CA', // Ontario, Canada
  'IR',
  'KP',
  'SY',
  'CU',
  'RU',
];

const CLOB_HEALTH_URL = 'https://clob.polymarket.com/ok';

/**
 * Two independent lookups. If they disagree we surface it rather than trusting
 * one — a mismatch usually means only part of the traffic is being tunnelled.
 */
const IP_LOOKUPS: Array<{ name: string; url: string; parse: (body: any) => ExitIp }> = [
  {
    name: 'ipwho.is',
    url: 'https://ipwho.is/',
    parse: body => ({ ip: body.ip, country: body.country, countryCode: body.country_code }),
  },
  {
    name: 'ipapi.co',
    url: 'https://ipapi.co/json/',
    parse: body => ({ ip: body.ip, country: body.country_name, countryCode: body.country_code }),
  },
];

// ============================================================================
// Types
// ============================================================================

export interface ExitIp {
  ip: string;
  country: string;
  /** ISO 3166-1 alpha-2, uppercase. */
  countryCode: string;
}

export interface GeoCheckResult {
  /** True when the exit country is not on the blocked list and the CLOB responded. */
  ok: boolean;
  exitIp: ExitIp | null;
  /** Which lookup service answered. */
  source: string | null;
  /** True when two lookups reported different exit IPs — a partial-tunnel symptom. */
  inconsistent: boolean;
  /** True when the exit country is on the blocked list. */
  blocked: boolean;
  /** True when https://clob.polymarket.com/ok answered 200. */
  clobReachable: boolean;
  /** Redacted proxy URL, or null when running direct / on a full-tunnel VPN. */
  proxy: string | null;
  /** Human-readable problems, empty when `ok`. */
  problems: string[];
}

export interface GeoCheckOptions {
  /** Override the blocked country list. Defaults to `BLOCKED_COUNTRIES` env, else `DEFAULT_BLOCKED_COUNTRIES`. */
  blockedCountries?: string[];
  /** Per-request timeout in ms (default 10000). */
  timeoutMs?: number;
  /** Query both lookup services and compare (default true). */
  crossCheck?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

function resolveBlockedCountries(override?: string[]): string[] {
  if (override) return override.map(c => c.trim().toUpperCase()).filter(Boolean);

  const fromEnv = process.env.BLOCKED_COUNTRIES;
  if (fromEnv !== undefined) {
    // An explicitly empty value disables the country check entirely.
    return fromEnv
      .split(',')
      .map(c => c.trim().toUpperCase())
      .filter(Boolean);
  }

  return DEFAULT_BLOCKED_COUNTRIES;
}

/**
 * Node's `fetch` throws a bare `TypeError: fetch failed` and hides the real
 * reason on `.cause`. Unwrap it — over a proxy the cause is the whole
 * diagnosis ("Request was cancelled" for a refused CONNECT, ECONNREFUSED for a
 * dead proxy, a TLS error for a broken cert chain).
 */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts: string[] = [error.message];
  let cause: unknown = (error as Error & { cause?: unknown }).cause;
  const seen = new Set<unknown>([error]);

  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    const code = (cause as Error & { code?: string }).code;
    parts.push(code ? `${cause.message} (${code})` : cause.message);
    cause = (cause as Error & { cause?: unknown }).cause;
  }

  return parts.join(' → ');
}

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Look up the exit IP as the outside world sees it. Goes through whatever
 * transport `installProxy()` configured, so this is the bot's real exit point
 * and not the host's.
 */
export async function getExitIp(timeoutMs = 10_000): Promise<{ exitIp: ExitIp; source: string }> {
  const errors: string[] = [];

  for (const lookup of IP_LOOKUPS) {
    try {
      const body = await fetchJson(lookup.url, timeoutMs);
      const parsed = lookup.parse(body);
      if (parsed.ip && parsed.countryCode) {
        return {
          exitIp: { ...parsed, countryCode: parsed.countryCode.toUpperCase() },
          source: lookup.name,
        };
      }
      errors.push(`${lookup.name}: unexpected response shape`);
    } catch (error) {
      errors.push(`${lookup.name}: ${describeFetchError(error)}`);
    }
  }

  throw new Error(`Could not determine exit IP. ${errors.join('; ')}`);
}

/** True when https://clob.polymarket.com/ok answers 200 through the current transport. */
export async function isClobReachable(timeoutMs = 10_000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(CLOB_HEALTH_URL, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the full preflight: exit IP, country, cross-check between two lookup
 * services, and CLOB reachability. Never throws — inspect `result.ok`.
 */
export async function checkGeo(options: GeoCheckOptions = {}): Promise<GeoCheckResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const blockedCountries = resolveBlockedCountries(options.blockedCountries);
  const crossCheck = options.crossCheck ?? true;
  const proxy = getInstalledProxy();

  const result: GeoCheckResult = {
    ok: false,
    exitIp: null,
    source: null,
    inconsistent: false,
    blocked: false,
    clobReachable: false,
    proxy: proxy?.url ?? null,
    problems: [],
  };

  try {
    const { exitIp, source } = await getExitIp(timeoutMs);
    result.exitIp = exitIp;
    result.source = source;
  } catch (error) {
    result.problems.push(
      `Exit IP lookup failed: ${describeFetchError(error)}. ` +
        (proxy
          ? `The proxy at ${proxy.host}:${proxy.port} may be down or unreachable.`
          : 'Check your network or VPN connection.')
    );
    return result;
  }

  if (crossCheck) {
    // Ask the *other* service and compare. Two different exit IPs means some
    // traffic is escaping the tunnel.
    const other = IP_LOOKUPS.find(l => l.name !== result.source);
    if (other) {
      try {
        const body = await fetchJson(other.url, timeoutMs);
        const parsed = other.parse(body);
        if (parsed.ip && parsed.ip !== result.exitIp?.ip) {
          result.inconsistent = true;
          result.problems.push(
            `Two lookups disagree on the exit IP (${result.source}: ${result.exitIp?.ip}, ` +
              `${other.name}: ${parsed.ip}). Traffic may only be partially tunnelled.`
          );
        }
      } catch {
        // A single lookup is enough to proceed; the cross-check is a bonus.
      }
    }
  }

  const countryCode = result.exitIp?.countryCode ?? '';
  if (blockedCountries.includes(countryCode)) {
    result.blocked = true;
    result.problems.push(
      `Exit IP is in ${result.exitIp?.country} (${countryCode}), which Polymarket restricts. ` +
        `Connect your VPN/proxy to a permitted country before trading.`
    );
  }

  result.clobReachable = await isClobReachable(timeoutMs);
  if (!result.clobReachable) {
    result.problems.push(
      `Polymarket CLOB (${CLOB_HEALTH_URL}) did not respond. It may be blocking this exit IP.`
    );
  }

  result.ok = result.problems.length === 0;
  return result;
}

/**
 * Preflight that throws when it is not safe to trade. Call this from any entry
 * point that can place an order.
 *
 * Set `SKIP_GEO_CHECK=true` to bypass (useful in CI and for dry runs).
 */
export async function assertTradingRegion(options: GeoCheckOptions = {}): Promise<GeoCheckResult> {
  const result = await checkGeo(options);

  if (process.env.SKIP_GEO_CHECK === 'true') {
    return result;
  }

  if (!result.ok) {
    throw new Error(
      `Geo preflight failed — refusing to trade.\n` +
        result.problems.map(p => `  • ${p}`).join('\n') +
        `\n\nSee docs/VPN_SETUP.md. Set SKIP_GEO_CHECK=true to bypass this check.`
    );
  }

  return result;
}

/** One-line summary suitable for a startup log. */
export function formatGeoResult(result: GeoCheckResult): string {
  const where = result.exitIp
    ? `${result.exitIp.ip} (${result.exitIp.country} / ${result.exitIp.countryCode})`
    : 'unknown';
  const via = result.proxy ? `via proxy ${result.proxy}` : 'direct (no proxy configured)';
  const clob = result.clobReachable ? 'CLOB reachable' : 'CLOB UNREACHABLE';
  return `${result.ok ? '✓' : '✗'} exit ${where} — ${via} — ${clob}`;
}

/**
 * Re-check the exit country on an interval while the bot runs, so a VPN that
 * drops mid-session is caught rather than discovered through rejected orders.
 * Returns a function that stops the watchdog.
 */
export function startGeoWatchdog(
  onFailure: (result: GeoCheckResult) => void,
  options: GeoCheckOptions & { intervalMs?: number } = {}
): () => void {
  const intervalMs = options.intervalMs ?? 5 * 60_000;

  const timer = setInterval(() => {
    void checkGeo(options).then(result => {
      if (!result.ok) onFailure(result);
    });
  }, intervalMs);

  // Do not hold the event loop open on the watchdog alone.
  timer.unref?.();

  return () => clearInterval(timer);
}
