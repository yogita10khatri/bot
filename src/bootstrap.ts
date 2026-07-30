/**
 * Bootstrap — import this first, before anything else.
 *
 *   import './src/bootstrap.js';   // or '../src/bootstrap.js' from scripts/
 *
 * Loads `.env` and installs the proxy transport. Order matters: the proxy has
 * to be in place before any module constructs an HTTP client, an ethers
 * provider or a WebSocket, otherwise those connections are made directly and
 * leak the real IP.
 *
 * Importing this module has side effects by design — that is the whole point.
 */

import 'dotenv/config';
import { installProxy, getInstalledProxy } from './core/proxy.js';

const proxy = installProxy();

if (proxy) {
  console.log(`[net] Proxying all outbound traffic via ${proxy.url} (${proxy.kind})`);
} else if (process.env.REQUIRE_PROXY === 'true') {
  console.error(
    '[net] REQUIRE_PROXY=true but no proxy is configured.\n' +
      '      Set PROXY_URL (e.g. socks5://user:pass@host:1080), or unset REQUIRE_PROXY\n' +
      '      if the host is on a full-tunnel VPN. See docs/VPN_SETUP.md.'
  );
  process.exit(1);
}

export { proxy, getInstalledProxy };
