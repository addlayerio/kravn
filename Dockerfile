# Kravn gateway image — the control-plane backend serving the operator SPA.
# (The client app is a separate deployable with its own Dockerfile.)
#
# Hardened, self-contained two-stage build: an Alpine base, security-patched with `apk upgrade`, and a runtime
# that strips the package managers + docs so their bundled transitive deps (pnpm/npm → tar, glob, minimatch,
# cross-spawn, sigstore, …) aren't shipped as CVE surface. The runtime only runs `node`.

# ── Build stage (has the toolchain) ───────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
# Security patches + the native toolchain for better-sqlite3 (compiled from source if no musl prebuilt binary
# is fetched). py3-setuptools/linux-headers are what node-gyp needs on modern Alpine.
RUN apk update && apk upgrade \
 && apk add --no-cache python3 py3-setuptools make g++ linux-headers \
 && rm -rf /var/cache/apk/*
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

# ── Runtime stage (hardened + stripped, package-manager-free) ─────────────────
FROM node:22-alpine AS runtime
# The release version (git tag / chart appVersion) is injected here so the app reports it (dashboard,
# MCP serverInfo) instead of a hardcoded constant. Defaults to a dev marker for local `docker build`.
ARG VERSION=0.1.0-dev
ENV NODE_ENV=production \
    KRAVN_DATA_DIR=/data \
    KRAVN_VERSION=${VERSION} \
    PORT=8080
WORKDIR /app
# Force the latest security-patched OS packages (zlib/musl/libssl CVEs the base image ships with).
RUN apk update && apk upgrade && rm -rf /var/cache/apk/*

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

# Production deps only. Install a THROWAWAY toolchain + pnpm just long enough to resolve prod deps (and build
# better-sqlite3 if no musl prebuilt binary is fetched), then remove ALL of it — the package managers and
# their bundled deps have no business in the runtime and are pure CVE surface. This is where the /usr/ Trivy
# findings came from.
RUN apk add --no-cache --virtual .build python3 py3-setuptools make g++ linux-headers \
 && npm install -g pnpm@9.15.0 \
 && pnpm install --prod --filter @kravn/gateway... \
 && pnpm store prune \
 && apk del .build \
 && rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx \
           /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
           /root/.local/share/pnpm /root/.npm /root/.cache \
           /usr/share/man /usr/share/doc /usr/share/info /var/cache/apk/* /tmp/* /var/tmp/*

RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
VOLUME ["/data"]

CMD ["node", "apps/gateway/dist/main.js"]
