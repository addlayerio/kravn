# Kravn gateway image — the control-plane backend serving the operator SPA.
# (The client app is a separate deployable with its own Dockerfile.)

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain for native modules (better-sqlite3) in case no prebuilt binary is available.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9.15.0

# Manifests first for better layer caching.
COPY package.json pnpm-workspace.yaml .npmrc nx.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/ui/package.json packages/ui/
COPY apps/gateway/package.json apps/gateway/
COPY apps/operator/package.json apps/operator/
RUN pnpm install

# Build contracts + plugin-sdk, the operator SPA (-> apps/gateway/public), and the gateway.
COPY . .
RUN pnpm --filter @kravn/contracts --filter @kravn/plugin-sdk --filter @kravn/operator --filter @kravn/gateway build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
# The release version (git tag / chart appVersion) is injected here so the app reports it (dashboard,
# MCP serverInfo) instead of a hardcoded constant. Defaults to a dev marker for local `docker build`.
ARG VERSION=0.1.0-dev
ENV NODE_ENV=production \
    KRAVN_DATA_DIR=/data \
    KRAVN_VERSION=${VERSION} \
    PORT=8080
WORKDIR /app
RUN npm install -g pnpm@9.15.0

COPY package.json pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY apps/gateway/package.json apps/gateway/
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /app/apps/gateway/public ./apps/gateway/public
# Bundled Python wheels (openpyxl, et_xmlfile) for the offline Pyodide code interpreter.
COPY --from=build /app/apps/gateway/assets ./apps/gateway/assets
# Production deps only (gateway + its workspace deps). Install the native toolchain just long enough
# to build better-sqlite3 if no prebuilt binary is fetched, then purge it to keep the runtime slim.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && pnpm install --prod --filter @kravn/gateway... \
 && pnpm store prune \
 && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]

CMD ["node", "apps/gateway/dist/main.js"]
