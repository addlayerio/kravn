# Kravn end-user client SPA — a small nginx image that serves the chat client and reverse-proxies /api to
# the gateway. The SPA calls SAME-ORIGIN relative /api paths, so it must share an origin with the API: in
# Kubernetes the Helm chart mounts an nginx.conf ConfigMap that points /api at the gateway Service. This is
# a SEPARATE deployable from the gateway image on purpose (its own domain / scaling / lifecycle).
ARG NGINX_BASE=docker.io/nginxinc/nginx-unprivileged:1.27-alpine

# ── Build stage (toolchain) ─────────────────────────────────────────────────────────────────────────
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
RUN apk update && apk upgrade && rm -rf /var/cache/apk/* \
 && npm install -g pnpm@9.15.0
# Manifests first for layer caching — only the client subtree's workspace packages.
COPY package.json pnpm-workspace.yaml .npmrc nx.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/ui/package.json packages/ui/
COPY apps/client/package.json apps/client/
RUN pnpm install
COPY . .
# contracts must build before the client (which imports its types); @kravn/ui is consumed from source by vite.
RUN pnpm --filter @kravn/contracts --filter @kravn/client build

# ── Runtime stage (rootless nginx) ──────────────────────────────────────────────────────────────────
FROM ${NGINX_BASE} AS runtime
# Patch OS CVEs the base image ships with.
USER root
RUN apk update && apk upgrade && rm -rf /var/cache/apk/*
# A sane default for standalone `docker run` (SPA history fallback, no API proxy). In Kubernetes the Helm
# ConfigMap overrides /etc/nginx/conf.d/default.conf with one that also reverse-proxies /api to the gateway.
COPY apps/client/nginx.default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/client/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
