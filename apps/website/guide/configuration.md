# Configuration

Kravn draws a deliberate line between **infrastructure config** and **application config**:

- **Environment variables** cover only what has to exist before the app can boot — the database, the
  signing secret, the port, the data directory.
- **Everything else** — SSRF policy, CSRF, rate limits, transports, federation, authentication providers,
  observability — is edited at runtime from the **Settings** page in the console and applied **without a
  redeploy**.

That means you configure Kravn the way you operate it: infra as code, policy in the product.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | *(empty → SQLite)* | Database DSN. `postgres://`, `mysql://`/`mariadb://`, `sqlserver://`/`mssql://`, or a SQLite file path. Empty → embedded SQLite at `<data dir>/kravn.sqlite`. |
| `KRAVN_SECRET` | *(auto-generated)* | Signing key for tokens. **Pin this in production** so tokens survive restarts and are shared across replicas. |
| `KRAVN_DATA_DIR` | `./data` | Where the embedded SQLite DB and uploads live. Back this with a volume/PVC. |
| `KRAVN_PUBLIC_URL` | *(derived)* | Public base URL (e.g. `https://kravn.example.com`). Derived from the request if unset; set it explicitly behind some proxies. |
| `KRAVN_DB_SCHEMA` | *(default schema)* | Build all tables inside this schema (PostgreSQL + SQL Server). |
| `KRAVN_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers (enable when behind a load balancer/ingress). |
| `KRAVN_ADMIN_EMAIL` / `KRAVN_ADMIN_PASSWORD` | — | Optionally seed the first admin non-interactively (otherwise use the setup wizard). |
| `KRAVN_CLIENT_URL` | — | Base URL of the separate end-user chat app, used as an SSO return target. |
| `KRAVN_METRICS_TOKEN` | — | Bearer token required to scrape `/metrics`. |
| `KRAVN_ALLOW_STDIO` | `false` | Allow `stdio`-transport upstream MCP servers (they run local processes — off by default). |
| `KRAVN_REDIS_URL` | — | Shared-store endpoint (`redis://` / `rediss://`) for multi-replica state. On the chart, `redis.enabled: true` provisions Dragonfly and sets this for you. |

> **Production checklist:** pin `KRAVN_SECRET`, set `DATABASE_URL` to a networked database, persist
> `KRAVN_DATA_DIR`, enable `KRAVN_TRUST_PROXY` behind your ingress, and — if you run more than one replica
> — set `KRAVN_REDIS_URL` (or `redis.enabled: true`).

## In-app settings

Once running, open **Settings** in the console. Highlights:

- **Authentication** — configure **SAML** and **OAuth2/OIDC** single sign-on, and issue **SCIM 2.0**
  tokens for automated user provisioning. Map SSO identities to roles and teams.
- **Access & networking** — the **SSRF policy** (which hosts/ranges upstreams may reach; cloud metadata
  IPs stay blocked regardless), **CSRF**, **rate limits**, and allowed **transports**.
- **Federation** — how Kravn presents itself as an MCP server and derives its public URL.
- **Observability** — logs (a live viewer in the console) and Prometheus **metrics** at `/metrics`.

Because these live in the database, they apply immediately and travel with your environment — no image
rebuild, no rolling restart.

## Authentication & provisioning

Kravn is designed to plug into the identity you already run:

- **SSO** — SAML or OIDC. Users sign in with corporate credentials; no separate password store required.
- **SCIM 2.0** — your IdP provisions and de-provisions users automatically. SCIM `userName` maps to the
  user's email; provisioned users are clamped to a safe role and an admin is never auto-deactivated.
- **RBAC + teams** — roles gate the control plane; **teams** gate the data plane (which endpoints and
  tools a user can consume). See [Core concepts](/guide/concepts).

## Persistence & backups

- **SQLite** — everything is in `KRAVN_DATA_DIR` (the `kravn.sqlite` file and uploads). Back up the
  directory / snapshot the volume.
- **External database** — back up with your database's normal tooling. Migrations are versioned and run
  automatically on upgrade.

---

Next: [Plugins & integrations](/guide/plugins) — extend the catalog and govern every call.
