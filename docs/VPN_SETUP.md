# Running the bot from a geo-restricted country

## Read this first

Polymarket's Terms of Service restrict access from a number of jurisdictions,
**India among them**. Using a VPN or proxy to trade from a restricted country is
a breach of those terms. Polymarket can and does close accounts for it, and a
closed account can leave funds stuck in positions you can no longer manage. Your
own local rules on offshore derivatives, crypto, and remittance may also apply.

Nothing in this repository changes that. What follows is the technical
configuration; whether to use it is your call, and the consequences are yours.

Concretely, the risk is not "the bot won't connect". It is:

- an account frozen with open positions on it,
- deposits that cannot be withdrawn,
- an exit IP that changes mid-session and gets flagged.

If you go ahead, **use a small amount of capital you can afford to lose entirely,
and keep `DRY_RUN=true` until the preflight is consistently green.**

---

## How the tunnel is wired

The bot talks to the network over four different transports, and each one has to
be routed separately — patching just one of them leaks the others:

| Transport         | Used by                                          |
|-------------------|--------------------------------------------------|
| `http` / `https`  | ethers v5 JSON-RPC (Polygon), `ws` WebSockets    |
| `axios`           | `@polymarket/clob-client-v2` (orders, CLOB data) |
| `undici`          | global `fetch` — Gamma API, Data API, subgraph   |

`src/core/proxy.ts` patches all of them from a single `PROXY_URL`, and
`src/bootstrap.ts` runs that patch before any other module can open a socket.

---

## Option A — full-tunnel VPN on the host (simplest)

Run WireGuard, OpenVPN, or a desktop VPN app on the machine, connected to an
exit in a permitted country. The OS routes everything, so the bot needs no
configuration at all.

Leave `PROXY_URL` unset in `.env`, then verify:

```bash
npm run check:vpn
```

**Turn on the VPN's kill switch.** Without one, a dropped tunnel silently falls
back to your real IP — which is exactly the case the geo watchdog exists to
catch, but a kill switch catches it a layer lower and never sends the packet.

---

## Option B — per-process proxy (recommended on a laptop)

Only the bot's traffic is tunnelled, and if the proxy dies the bot gets a
connection error rather than quietly leaking. Most commercial VPN providers hand
out SOCKS5 endpoints alongside their app.

```bash
# .env
PROXY_URL=socks5://username:password@proxy-host:1080
REQUIRE_PROXY=true
```

`REQUIRE_PROXY=true` makes the bot refuse to start if `PROXY_URL` is missing, so
a forgotten config line can't turn into an order placed from your real IP.

Supported schemes: `socks5://`, `socks5h://`, `socks4://`, `socks://`, `http://`,
`https://`. A bare `host:port` is treated as SOCKS5.

### Using your own VPS as the exit

If you have a server in a permitted region, an SSH tunnel is a free SOCKS5 proxy:

```bash
ssh -D 1080 -N -C user@your-vps
```

```bash
# .env
PROXY_URL=socks5://127.0.0.1:1080
```

Loopback is on the bypass list by default, but only for *destination* hosts —
the proxy itself being on `127.0.0.1` is fine, since the tunnel's far end is the
VPS.

---

## Option C — Docker with a VPN sidecar

`docker-compose.vpn.yml` runs the bot inside
[gluetun](https://github.com/qdm12/gluetun)'s network namespace. The container
has no route to the internet except through the VPN, which is the strongest
leak protection of the three — there is no fallback path for traffic to take.

```bash
cp .env.example .env      # fill in POLYMARKET_PRIVATE_KEY and the VPN vars
docker compose -f docker-compose.vpn.yml up -d
docker compose -f docker-compose.vpn.yml logs -f bot
```

Gluetun supports most major providers; set `VPN_SERVICE_PROVIDER` and the
matching credentials. See its documentation for provider-specific variables.

---

## Verifying before you trade

```bash
npm run check:vpn
```

```
Polymarket VPN / proxy preflight
────────────────────────────────────────────────────────────
Transport   : proxy socks5://user:****@proxy-host:1080 (socks)
Bypassing   : localhost, 127.0.0.1, ::1, 0.0.0.0

Exit IP     : 203.0.113.42
Exit country: Netherlands (NL)  [via ipwho.is]

Endpoint reachability
────────────────────────────────────────────────────────────
  ✓ CLOB           412ms  HTTP 200
  ✓ Gamma API      388ms  HTTP 200
  ✓ Data API       401ms  HTTP 200
  ✓ Polygon RPC    355ms  HTTP 405

Verdict
────────────────────────────────────────────────────────────
  ✓ Safe to trade — exit IP is outside the restricted list and
    every Polymarket endpoint answered.
```

The check verifies four things:

1. **Exit IP and country** — where the outside world sees your traffic coming
   from, measured through the same transport the bot uses.
2. **Cross-check** — two independent lookup services. Different answers mean the
   tunnel is only carrying part of your traffic.
3. **Restricted country** — the exit country against `BLOCKED_COUNTRIES`.
4. **Endpoint reachability** — CLOB, Gamma, Data API and Polygon RPC.

Exit code is 0 when it is safe to trade, 1 otherwise, so it composes with a
launcher script:

```bash
npm run check:vpn && npm run bot
```

### The same check runs at startup

`bot-config.ts` and `bot-with-dashboard.ts` call `assertTradingRegion()` before
touching any strategy, and start a watchdog that re-checks every five minutes.
A tunnel that drops mid-session is reported immediately, rather than showing up
as an unexplained wall of rejected orders while you are holding a position.

Set `SKIP_GEO_CHECK=true` to bypass it — for CI and offline dry runs only.

---

## Troubleshooting

**`Exit IP lookup failed` / everything times out**
The proxy is down or the credentials are wrong. Test it independently:

```bash
curl --socks5-hostname user:pass@proxy-host:1080 https://ipwho.is/
```

**Two lookups disagree on the exit IP**
Something is escaping the tunnel. Usually one of: the VPN app is in split-tunnel
mode, IPv6 is routing around an IPv4-only tunnel, or `PROXY_URL` was set after
the process had already opened connections. If you added your own entry point,
make sure `import './src/bootstrap.js'` is its **first** import.

**CLOB unreachable but the other endpoints work**
The exit IP itself is blocked — commercial VPN ranges get flagged. Try a
different server, ideally a residential or datacentre IP that is not shared.

**Orders rejected with an auth error while the preflight is green**
The exit IP changed between deriving your API key and placing the order. Some
providers rotate IPs on reconnect. Pin to a single static exit if your provider
offers one.

**`REQUIRE_PROXY=true but no proxy is configured`**
Either set `PROXY_URL`, or remove `REQUIRE_PROXY` if you are on a full-tunnel VPN
(option A), where the bot is correct to see no proxy.

---

## What the bot does *not* protect you against

- **DNS leaks outside the process.** SOCKS5 proxying sends DNS through the
  tunnel; a host-level VPN may not, depending on configuration.
- **Browser traffic.** The dashboard runs on `localhost` and is deliberately
  bypassed, but if you open Polymarket's website in a browser, that is a
  separate connection from a separate IP.
- **On-chain analysis.** Your Polygon address and its transaction history are
  public regardless of how the API requests are routed.
- **KYC.** Deposits and withdrawals go through channels that see far more than
  an IP address.
