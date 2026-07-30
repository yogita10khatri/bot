/**
 * VPN / proxy preflight
 *
 *   npm run check:vpn
 *
 * Run this before you enable live trading, and any time the bot starts
 * rejecting orders. It reports where the bot's traffic actually exits, whether
 * that exit is in a country Polymarket restricts, and whether the CLOB, Gamma
 * and Data APIs answer over the same transport.
 *
 * Exit code 0 = safe to trade, 1 = not.
 */

import '../src/bootstrap.js';
import {
  checkGeo,
  getInstalledProxy,
  describeFetchError,
  DEFAULT_BLOCKED_COUNTRIES,
} from '../src/index.js';

const ENDPOINTS = [
  { name: 'CLOB', url: 'https://clob.polymarket.com/ok' },
  { name: 'Gamma API', url: 'https://gamma-api.polymarket.com/markets?limit=1' },
  { name: 'Data API', url: 'https://data-api.polymarket.com/positions?limit=1&user=0x0000000000000000000000000000000000000000' },
  { name: 'Polygon RPC', url: 'https://polygon-rpc.com' },
];

async function timedProbe(url: string, timeoutMs = 12_000): Promise<{ ok: boolean; ms: number; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok, ms: Date.now() - started, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, detail: describeFetchError(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  console.log('');
  console.log('Polymarket VPN / proxy preflight');
  console.log('─'.repeat(60));

  // ── Transport ────────────────────────────────────────────────────────────
  const proxy = getInstalledProxy();
  if (proxy) {
    console.log(`Transport   : proxy ${proxy.url} (${proxy.kind})`);
    console.log(`Bypassing   : ${proxy.bypass.join(', ')}`);
  } else {
    console.log('Transport   : direct — no PROXY_URL set.');
    console.log('              This is correct if the host is on a full-tunnel VPN');
    console.log('              (WireGuard / OpenVPN / a desktop VPN app / gluetun).');
    console.log('              It is NOT correct if you meant to use a SOCKS/HTTP proxy.');
  }
  console.log('');

  // ── Exit IP and country ──────────────────────────────────────────────────
  const geo = await checkGeo();

  if (geo.exitIp) {
    console.log(`Exit IP     : ${geo.exitIp.ip}`);
    console.log(`Exit country: ${geo.exitIp.country} (${geo.exitIp.countryCode})  [via ${geo.source}]`);
  } else {
    console.log('Exit IP     : could not be determined');
  }
  console.log('');

  // ── Endpoint reachability ────────────────────────────────────────────────
  console.log('Endpoint reachability');
  console.log('─'.repeat(60));
  const probes = await Promise.all(ENDPOINTS.map(e => timedProbe(e.url)));
  let unreachable = 0;
  ENDPOINTS.forEach((endpoint, i) => {
    const probe = probes[i]!;
    // The Polygon RPC returns 405 to a bare GET; reaching it at all is the point.
    const reachable = probe.ok || /^HTTP 4\d\d$/.test(probe.detail);
    if (!reachable) unreachable++;
    console.log(
      `${reachable ? '  ✓' : '  ✗'} ${endpoint.name.padEnd(12)} ${String(probe.ms + 'ms').padStart(7)}  ${probe.detail}`
    );
  });
  console.log('');

  // ── Verdict ──────────────────────────────────────────────────────────────
  console.log('Verdict');
  console.log('─'.repeat(60));

  const problems = [...geo.problems];
  if (unreachable > 0) {
    problems.push(`${unreachable} Polymarket endpoint(s) unreachable over this transport.`);
  }

  if (problems.length === 0) {
    console.log('  ✓ Safe to trade — exit IP is outside the restricted list and');
    console.log('    every Polymarket endpoint answered.');
    console.log('');
    process.exit(0);
  }

  for (const problem of problems) {
    console.log(`  ✗ ${problem}`);
  }

  console.log('');
  console.log('Next steps');
  console.log('─'.repeat(60));
  if (geo.blocked) {
    console.log('  • Your traffic is exiting from a country Polymarket restricts.');
    console.log('    Live trading (DRY_RUN=false) will refuse to start. Note that');
    console.log('    tunnelling around the restriction breaches Polymarket\'s Terms');
    console.log('    of Service and risks a locked account — see docs/VPN_SETUP.md.');
    console.log('  • A dry run (DRY_RUN=true, the default) is unaffected and still');
    console.log('    starts: it reads market data and simulates fills without');
    console.log('    placing orders. Use it for strategy work and backtesting.');
  }
  if (geo.inconsistent) {
    console.log('  • Two lookups disagreed on your exit IP — the tunnel is leaking.');
    console.log('    With a SOCKS/HTTP proxy, confirm PROXY_URL is set and reachable.');
    console.log('    With a full-tunnel VPN, enable its kill switch.');
  }
  if (!proxy) {
    console.log('  • No PROXY_URL is set. If you intended per-process tunnelling,');
    console.log('    add it to .env — e.g. PROXY_URL=socks5://user:pass@host:1080');
  }
  console.log(`  • Restricted list in use: ${DEFAULT_BLOCKED_COUNTRIES.join(', ')}`);
  console.log('    Override with BLOCKED_COUNTRIES in .env if it is out of date.');
  console.log('  • Full walkthrough: docs/VPN_SETUP.md');
  console.log('');
  process.exit(1);
}

main().catch(error => {
  console.error('Preflight crashed:', error);
  process.exit(1);
});
