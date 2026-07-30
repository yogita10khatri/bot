# Image for the bot, intended to run inside gluetun's network namespace.
# See docker-compose.vpn.yml and docs/VPN_SETUP.md.

FROM node:20-slim

WORKDIR /app

# Dependencies first so the layer caches across source edits. devDependencies
# are kept because the entry points are run through `tsx`, the same way they
# are locally — no separate build step to drift out of sync.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY bot-config.ts bot-with-dashboard.ts ./

# Fails the container health check when the tunnel is down or is exiting from a
# restricted country, so a dead VPN shows up in `docker ps` rather than as a
# stream of rejected orders.
HEALTHCHECK --interval=5m --timeout=45s --start-period=1m --retries=2 \
  CMD npx tsx scripts/check-vpn.ts || exit 1

# The plain bot. For the dashboard variant, build dashboard/ first and override
# with: command: ["npx", "tsx", "bot-with-dashboard.ts"]
CMD ["npx", "tsx", "bot-config.ts"]
