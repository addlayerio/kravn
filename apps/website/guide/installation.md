# Installation Manual

This is the complete guide to installing and operating Kravn — from a laptop to a production
Kubernetes cluster. For a two-minute taste, see the [Quickstart](/guide/getting-started) instead.

[[toc]]

## Requirements

| To run… | You need |
|---|---|
| From source | Node **22+** and pnpm **9** (`npm i -g pnpm@9`) |
| With Docker | Docker (and Docker Compose for the compose flow) |
| On Kubernetes | A cluster + **Helm 3** |

Kravn is self-contained: an **embedded SQLite** database and an **auto-generated signing key** mean it
boots with zero external dependencies. You add a real database and a pinned secret when you go to
production.

## Option A — Docker (single container)

The published image lives on the repo owner's GitHub Container Registry:

```bash
docker run -p 8080:80 \
  -v kravn-data:/app/data \
  ghcr.io/addlayerio/kravn:latest
# → http://localhost:8080
```

- Port **80** inside the container (map it wherever you like).
- The `-v kravn-data:/app/data` volume persists the SQLite database and uploads across restarts.

### Docker Compose

From a checkout of the repository:

```bash
docker compose up            # → http://localhost:8080
```

Compose is the easiest way to run Kravn alongside a database container for a realistic local environment.

## Option B — Kubernetes with Helm

The chart is designed to install with **zero overrides**:

```bash
helm install kravn ./charts/kravn
kubectl port-forward svc/kravn 8080:80
# → http://localhost:8080
```

Or install the packaged chart straight from the registry (no checkout needed):

```bash
helm install kravn oci://ghcr.io/addlayerio/charts/kravn --version 0.1.42
```

> If the GHCR packages are private, either make them public from the repo's *Packages* page or pull with
> an `imagePullSecret`.

### Common values

Override with `--set` or a `values.yaml`. The defaults are production-sane; the knobs you'll reach for
first:

```yaml
# values.yaml
image:
  repository: ghcr.io/addlayerio/kravn
  tag: ""            # defaults to the chart's appVersion
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 80

# Expose it
ingress:
  enabled: true
  hosts:
    - host: kravn.example.com

# Pin the signing secret (KRAVN_SECRET) from an existing Kubernetes secret
existingSecret: kravn-secrets        # a secret containing key KRAVN_SECRET

# Point at an external database (see below)
database:
  enabled: true
  url: "postgres://user:pass@db-host:5432/kravn?sslmode=require"
  # …or reference a secret instead of an inline URL:
  # existingSecret: kravn-secrets    # a secret containing key DATABASE_URL
```

```bash
helm install kravn ./charts/kravn -f values.yaml
```

## Choosing a database

Kravn's store is portable across engines with versioned migrations. SQLite is perfect for evaluation and
small single-node deployments; move to a networked database for anything shared or highly available.

| Engine | When |
|---|---|
| **SQLite** (default) | Evaluation, single node — no setup, data in `/app/data` |
| **PostgreSQL** | Recommended for production |
| **MySQL / MariaDB** | Supported |
| **SQL Server** | Supported |

Point Kravn at an external database with the `DATABASE_URL` connection string (on the chart, the
`database` block above sets it for you):

```bash
# examples — the scheme selects the driver
DATABASE_URL=postgres://user:pass@db-host:5432/kravn?sslmode=require
DATABASE_URL=mysql://user:pass@db-host:3306/kravn
DATABASE_URL=sqlserver://user:pass@db-host:1433/kravn?encrypt=true
# unset → embedded SQLite under KRAVN_DATA_DIR
```

Migrations run automatically on boot. See [Configuration](/guide/configuration) for the full environment
reference.

## High availability (multi-replica)

Kravn runs behind more than one replica. Cross-pod state (rate-limit counters, in-flight SSO login state)
is kept in a shared store so every pod agrees.

Enable it in the chart — this deploys a **Dragonfly** instance (a fast, Redis-protocol-compatible store)
and wires the app to it automatically:

```yaml
redis:
  enabled: true      # deploys Dragonfly, NOT Redis, and points Kravn at it
```

You can also bring your own Redis-protocol endpoint (`redis://` / `rediss://`). When you run more than one
replica, **pin `KRAVN_SECRET`** so all pods sign and verify tokens with the same key.

## TLS & ingress

Terminate TLS at your ingress controller or load balancer and route to the Kravn service on port 80.
`ingress.enabled: true` with your host (and your cluster's TLS annotations/secret) is the usual path.
Kravn can derive its public base URL from the request, or you can set it explicitly — see
[Configuration](/guide/configuration).

## From source (development)

```bash
pnpm install
pnpm build                 # operator UI builds into the gateway
pnpm start                 # gateway on http://localhost:8080
```

Hot-reload dev mode, in separate terminals:

```bash
pnpm --filter @kravn/contracts build   # once — the others import it
pnpm dev:gateway                        # backend on :8080
pnpm dev:operator                       # operator UI on :5173 (proxies /api → :8080)
pnpm dev:client                         # end-user chat UI on :5174
```

## Verify the install

1. **http://localhost:8080** loads the console and shows the first-run **setup wizard**.
2. Create the admin account.
3. **MCP Servers → Add** an upstream; its catalog appears under **Tools/Resources/Prompts**.
4. **MCP Endpoints → New**, expose a tool, connect a client — see the [Quickstart](/guide/getting-started).

## Upgrading

```bash
# Helm
helm upgrade kravn ./charts/kravn        # or: oci://ghcr.io/addlayerio/charts/kravn --version <new>

# Docker
docker pull ghcr.io/addlayerio/kravn:latest && docker compose up -d
```

Database migrations are applied automatically on the new version's first boot. Every release is recorded
in the [changelog](https://github.com/addlayerio/kravn/blob/main/SECURITY.md).

---

Next: [Configuration](/guide/configuration) — what's environment config vs in-app settings, and how to
wire up SSO and SCIM.
