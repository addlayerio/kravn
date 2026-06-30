# Kravn

A **seamless, self-configuring MCP gateway, registry and proxy** — built in Node.js + Vue,
inspired by IBM/mcp-context-forge but designed to **boot first try** and keep its configuration
**inside the app** instead of in a wall of environment variables.

- **Boots of one.** `docker compose up` or `helm install` with zero overrides → it's running.
  Embedded SQLite, auto-generated signing key, first-run setup wizard.
- **Config lives in the app.** SSRF policy, CSRF, rate limits, transports, federation, auth and
  observability are edited at runtime from the **Settings** page and applied without a redeploy.
  Only true infrastructure (DB, secret, port) is environment config.
- **Real MCP gateway.** Connects to upstream MCP servers (streamable-HTTP / SSE / stdio), imports
  their tools / resources / prompts, and re-exposes them — globally or as composed **virtual
  servers** — over a single MCP endpoint.

## Architecture

A TypeScript monorepo (**pnpm + Nx**):

| Package | What |
|---|---|
| `apps/gateway` | Fastify control-plane backend: MCP core (upstream client + downstream JSON-RPC), registry, settings, auth/RBAC, SSO, teams, plugins, LLM providers, chat runtime, SSRF-safe HTTP, metrics, logs. Portable store over **SQLite / PostgreSQL / MySQL · MariaDB / SQL Server** with versioned migrations (Knex). Serves the operator SPA. |
| `apps/operator` | Vue 3 operator console (admin + gateway sections). Built into `apps/gateway/public` → one container serves API + operator UI. |
| `apps/client` | Vue 3 end-user app (chat + conversations) — a separate deployable (its own port/pod). |
| `packages/contracts` | Shared zod schemas (settings, entities, DTOs, permissions). |
| `packages/plugin-sdk` | The plugin contract (`definePlugin`, hook/mcp-server types). See [PLUGINS.md](PLUGINS.md). |
| `packages/ui` | Shared design system (tokens/style + raven logo). |

## Run it locally

Requires Node 22+ and pnpm 9 (`npm i -g pnpm@9`).

```bash
pnpm install
pnpm build             # nx run-many -t build (operator builds into apps/gateway/public)
pnpm start             # gateway on http://localhost:8080  → operator + setup wizard
```

Dev mode with hot reload (separate terminals):

```bash
pnpm --filter @kravn/contracts build   # once (the others import it)
pnpm dev:gateway                        # backend on :8080
pnpm dev:operator                       # operator UI on :5173 (proxies /api to :8080)
pnpm dev:client                         # end-user chat UI on :5174 (proxies /api to :8080)
```

## Run with Docker

```bash
docker compose up --build            # http://localhost:8080
```

## Deploy to Kubernetes

```bash
helm install kravn ./charts/kravn
kubectl port-forward svc/kravn 8080:80
# open http://localhost:8080
```

See [charts/kravn/README.md](charts/kravn/README.md) for Ingress, Postgres and scaling.

## Configuration

**Tier 1 — bootstrap (env, minimal):** see [.env.example](.env.example). Everything is optional;
unset means SQLite + auto-generated key.

**Tier 2 — application (runtime, in the UI):** the Settings page. Stored in the DB, hot-reloaded.

### Database

The schema is built from zero and evolved through **versioned, cross-dialect migrations** (Knex) — no
manual DDL. Pick the engine with `DATABASE_URL`; the same migrations run on all of them:

| Engine | `DATABASE_URL` |
|---|---|
| SQLite (default) | *(unset)* → `<dataDir>/kravn.sqlite`, or `sqlite:///abs/path.sqlite` |
| PostgreSQL | `postgres://user:pass@host:5432/kravn` |
| MySQL / MariaDB | `mysql://user:pass@host:3306/kravn` |
| SQL Server | `sqlserver://user:pass@host:1433/kravn?encrypt=true` |

Migrations run automatically on boot; the platform creates/updates every table itself. Knex serializes
concurrent runs with a lock, so multiple replicas booting at once won't corrupt the schema. For a cleaner
multi-replica rollout you can instead migrate **once** in a dedicated step via `KRAVN_MIGRATE`:

| `KRAVN_MIGRATE` | Behavior |
|---|---|
| `on` (default) | Run migrations on boot, then serve. Simplest; single-replica. |
| `only` | Run migrations and exit 0 — a dedicated migration Job before the rollout. |
| `skip` | Don't migrate, just serve — the app pods once the Job has migrated (fails fast if it hasn't). |

The Helm chart wires this up for you: set `migrations.job.enabled=true` and it runs a `pre-install`/`pre-upgrade`
hook Job (`KRAVN_MIGRATE=only`) that Helm waits on before the Deployment rolls, while the app pods start with
`KRAVN_MIGRATE=skip`. Requires an external database.

Set `KRAVN_DB_SCHEMA` to build all tables inside a specific schema (**PostgreSQL + SQL Server**) — it's
auto-created if missing. Empty means the default schema. On PostgreSQL it's applied via `searchPath`; on
SQL Server Kravn repoints the connecting login's `DEFAULT_SCHEMA` to it, so **connect with a non-sysadmin
login** (a sysadmin login like `sa` always maps to `dbo` and the schema is ignored with a warning).
Not applicable to SQLite; on MySQL the schema is the database (set it in `DATABASE_URL`).

### Roles (one image, separate pods)

`KRAVN_ROLE` selects which slice of the backend a process serves, so the **same image** can scale as
independent pods sharing one database:

| `KRAVN_ROLE` | Serves |
|---|---|
| `all` (default) | Everything — single-pod. |
| `gateway` | Control-plane API + MCP endpoint + operator SPA. |
| `chat` | End-user chat API only (the dedicated chat backend). |

Shared routes (auth, SSO, first-run setup, `/api/bootstrap`, `/healthz`, `/metrics`) are always on.

### Single sign-on on the end-user client

SSO (OIDC + SAML) works from both the operator console and the `apps/client` chat app. Set
`KRAVN_CLIENT_URL` (e.g. `http://localhost:5174` in dev) so the gateway returns the session to the client
app when login starts there. The return target is allowlisted (operator | client) — never an arbitrary URL.

### Projects (chat)

The chat client supports **Projects**: a project carries system **instructions** and attached **documents**
whose text is injected as reference context into every chat started in the project (Claude-Projects-style).

## Using the gateway

1. **Servers** → add an upstream MCP server. Kravn connects and imports its catalog.
2. **Tools / Resources / Prompts** → browse the imported catalog; test tools in the playground.
3. **Virtual servers** → compose a curated slice and expose it at `/servers/<slug>/mcp`.
4. Point an MCP client at `POST /mcp` (global) or `POST /servers/<slug>/mcp`, with a Kravn bearer token.

## Status

This is a focused MVP that is genuinely end-to-end (boot → register → sync → proxy → admin UI).
Deliberately deferred to later phases: multi-replica session affinity & durable event store,
the plugin framework, gRPC-to-MCP reflection, OAuth/SSO providers, and OpenTelemetry export.
See [BUILD_PROGRESS.md](BUILD_PROGRESS.md).

## License

Apache-2.0.
