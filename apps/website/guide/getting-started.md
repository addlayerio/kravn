# Quickstart

Get Kravn running and serving its first MCP endpoint in a few minutes. For production installs (Helm,
external databases, TLS, HA) see the [Installation Manual](/guide/installation).

## Prerequisites

- **Docker** (for the quickest start), or **Node 22+ and pnpm 9** (to run from source), or a
  **Kubernetes** cluster with Helm 3 (for a cluster install).
- Nothing else — Kravn ships with an embedded SQLite database and generates its own signing key on first
  boot.

## 1. Start Kravn

::: code-group

```bash [Docker]
docker compose up            # → http://localhost:8080
```

```bash [Helm]
helm install kravn ./charts/kravn
kubectl port-forward svc/kravn 8080:80
# → http://localhost:8080
```

```bash [From source]
pnpm install
pnpm build                   # operator UI builds into the gateway
pnpm start                   # → http://localhost:8080
```

:::

Open **http://localhost:8080**.

## 2. Complete the setup wizard

On first boot Kravn shows a one-time **setup wizard**. Create the first administrator account. That's it —
you're in the operator console.

> The signing key is auto-generated on first run. For production, pin it explicitly (`KRAVN_SECRET`) so
> tokens survive restarts and are shared across replicas — see [Configuration](/guide/configuration).

## 3. Connect your first MCP Server

In the console, go to **MCP Servers → Add**, and point Kravn at an upstream MCP server:

- **Transport** — streamable-HTTP, SSE or stdio.
- **URL / command** — where the server lives.

Kravn connects and **syncs its catalog** — the tools, resources and prompts it advertises now appear under
**Tools**, **Resources** and **Prompts**.

Prefer a corporate system? Enable a **native integration** instead (SharePoint, Microsoft Teams, Jira,
Confluence) from **Plugins** — configure its credentials and its tools appear in the catalog just the
same. See [Plugins & integrations](/guide/plugins).

## 4. Publish an MCP Endpoint

Raw upstreams aren't exposed directly — you publish a curated **MCP Endpoint**:

1. Go to **MCP Endpoints → New**.
2. Pick the tools/resources/prompts from the catalog it should expose.
3. Choose an **access policy**: `public`, `authenticated`, or `restricted` to specific **teams**.
4. *(Optional)* add a **pipeline** overlay — e.g. a Secrets Redactor or PII Tokenizer — on top of the
   global pipeline.

Your endpoint is now live at `/servers/<slug>/mcp`.

## 5. Connect a client

Point any MCP client at the endpoint URL:

```
https://<your-kravn-host>/servers/<slug>/mcp
```

For anything but a `public` endpoint the client authenticates via Kravn (OAuth), and access is decided by
**team membership** — so a client only ever sees the tools its user's teams are entitled to.

## What's next

- [Installation Manual](/guide/installation) — Helm values, external databases, TLS/ingress, HA.
- [Configuration](/guide/configuration) — environment vs in-app settings, SSO, SCIM.
- [Core concepts](/guide/concepts) — servers vs endpoints, control vs data plane, pipelines.
- [Security & compliance](/guide/security) — the posture that makes Kravn safe inside a regulated network.
