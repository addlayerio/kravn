# AGENTS.md — Kravn (MCP gateway + operator + client)

Operating guide for agents/developers working in this repo. Read this before adding features.

## What Kravn is
A seamless, self-configuring **MCP gateway / registry / proxy** (Node + Vue), plus an operator console
and an end-user chat client. Monorepo: pnpm + Nx. `apps/gateway` (Fastify backend), `apps/operator`
(admin+gateway SPA), `apps/client` (end-user chat), `packages/{contracts,plugin-sdk,ui}`.
DB layer = Knex migrations over SQLite/Postgres/MySQL/SQL Server.

## Core principles (do not violate)

### 1. Tools are plugins — never hardcode a tool into app code
**Every tool/capability must be a plugin, not a built-in baked into a service.** Kravn is an MCP gateway;
the extension model is the plugin system (`@kravn/plugin-sdk`: `hook` and `mcp-server` plugins). A
capability the platform ships itself is a **native plugin**: it lives as a seeded, pre-loaded plugin
(like **Tool Guard**) so it appears in the Plugins screen, is enable/disable-able, is composable into
virtual servers, and is reusable by any model and by external MCP clients — instead of being a
hardcoded tool special-cased inside a service.

- New capability for the chat/registry → ship it as a **native seeded plugin** (see `plugins/examples.ts`
  + the native-plugin registry), not as a `const SOME_TOOL = {...}` wired straight into `ChatService`.
- Native plugins that need privileged runtime (e.g. the code interpreter needs the Pyodide executor +
  attachment files) get that via the plugin's native context — they are still managed as plugins.
- A native plugin that integrates an external service (e.g. **SharePoint** via Microsoft Graph) is just an
  `mcp-server` native plugin with a `configSchema`. Credential fields are marked `secret: true` in the schema:
  the PluginManager encrypts them at rest (via `Encryptor`), masks them in the API/UI (write-only — blank
  preserves), and decrypts only when handing config to the plugin at runtime. A native plugin whose
  `configSchema.required` is non-empty is seeded **disabled** (it needs config first). This is the pattern for
  every credential-bearing catalog plugin.
- Provider tool-calling (OpenAI / Anthropic / Gemini function-calling) is a **separate layer**: making a
  tool "available to a model" means wiring that provider's tool-calling, regardless of where the tool
  lives. Don't conflate "is it a plugin" (tool source) with "can this model call it" (provider wiring).

### 2. Multi-tenant scoping on every per-user data path
Chat conversations, projects, documents and attachments are per-user. Every repo query and route must be
scoped by `user_id` (and conversation/project ownership). Never pair a stored secret with a
caller-supplied URL; never derive a token-redirect origin from request headers.

### 3. Cross-dialect SQL only (Knex), schema-aware
Schema changes go through versioned migrations in `db/migrations.ts` (append, never edit a shipped one).
PK/unique/indexed columns are `varchar(n)`; large/JSON columns are `text` (no DB default — MySQL forbids
it); booleans are `integer` 0/1. Use `longtext` for big payloads so they fit on MySQL.

**Always reference tables UNQUALIFIED** (`users`, never `public.users` / `<schema>.users`). The DB schema is
operator-configured via `KRAVN_DB_SCHEMA` (**PostgreSQL + SQL Server**) and applied centrally so any new
migration / repo SQL is schema-correct automatically — never hardcode a schema name, never assume `public`,
and don't qualify identifiers. How it's applied per dialect (all in db/knex.ts + `runMigrations` in db/migrations.ts):
- **PostgreSQL**: Knex `searchPath` + `migrations.schemaName`; `runMigrations` creates the schema only if it
  is genuinely missing (it looks it up in `information_schema.schemata` first — `CREATE SCHEMA IF NOT EXISTS`
  checks the CREATE-on-database privilege *before* the existence check, so an unconditional create breaks a
  least-privilege user that already owns its schema). On PG 15+/Azure `public` is not writable by a non-owner,
  so operators give the app user its own schema (pre-created `AUTHORIZATION <user>`, or grant CREATE on the DB).
- **SQL Server**: there is no per-session search_path — unqualified names resolve through the connecting
  login's `DEFAULT_SCHEMA`. So `runMigrations` does `CREATE SCHEMA` + `ALTER USER ... WITH DEFAULT_SCHEMA`
  (best-effort) and verifies via `SCHEMA_NAME()`. Verified live: a non-sysadmin login gets repointed in-session
  and ALL tables (incl. `knex_migrations`) land in the schema; a **sysadmin login (e.g. `sa`) always maps to
  `dbo`** and cannot be repointed — the schema is ignored *consistently* (everything in `dbo`) with a warning.
  Do NOT set Knex `searchPath`/`migrations.schemaName` for mssql (it splits the migration table from the rest).
- **MySQL**: schema == database, set it in `DATABASE_URL`. **SQLite**: N/A. Both warn if `KRAVN_DB_SCHEMA` is set.

### 4. Config lives in the app, secrets are fail-closed
Only true infra is env (DB, secret, port, public URL, role). Everything else is runtime DB-backed
settings. Credentials are encrypted at rest and write-only (never read back to clients).

### 5. Validate + adversarially review substantial changes
Typecheck + build + a smoke test for new surfaces; for anything security-sensitive run an adversarial
review and fix confirmed findings before declaring done.

**Security is re-validated on EVERY change — see [`SECURITY.md`](./SECURITY.md) (mandatory).** It holds the
trust boundaries, the invariants that must never break (tokens Bearer-only & never in URLs; atomic
fail-closed single-use codes/tickets; authorize + ownership on every route; scope confinement; stdio/plugins
admin-only; secrets encrypted/write-only; security headers/CORS/`trustProxy` in-app; no leaky errors), the
inventory of controls, the accepted residual risk (top open item: **per-MCP entitlements are opt-in — mark
sensitive virtual servers `restricted`**), and the per-change checklist + review process. Before calling any
change done, run the SECURITY.md §6 checklist against your diff; if it touches auth, tokens, routes, MCP,
OAuth, SSO, plugins, DB or headers (§5), run the adversarial review and fix confirmed findings first. Add a
row to the SECURITY.md change log for any release that touches security.

## Development, validation & release workflow

This is the loop every change goes through. The **durable record** of what shipped and why lives in **git
history + tags** (`git log`, `git tag`), the **SECURITY.md change log**, and **BUILD_PROGRESS.md** — not in
any chat session. Keep those current so the project is fully reconstructable from the repo alone.

1. **Implement** the change (code + contracts + migration if schema changes — append-only in `db/migrations.ts`).
2. **Build + typecheck**: `pnpm build` and `pnpm typecheck` (Nx over all 5 projects). The operator SPA builds
   into `apps/gateway/public` and ships inside the gateway image, so a UI change needs a new image/chart bump.
3. **Runtime-validate the actual behavior** (not just types): boot the gateway against a throwaway data dir
   and exercise the new surface end-to-end — e.g.
   `KRAVN_DATA_DIR=<tmp> PORT=<p> NODE_ENV=development node apps/gateway/dist/main.js`, then drive it with
   `curl`/small Node scripts (setup → login → the new endpoints), asserting both the happy path AND the
   negative/guard cases. These scratchpad scripts are throwaway — never commit them. Native plugins with
   credentials can be unit-exercised by importing the built plugin and calling `server.callTool(...)`.
4. **Security-review security-sensitive changes** (auth, tokens, routes, MCP, OAuth, SSO, SCIM, plugins, DB,
   headers) — the adversarial review from **SECURITY.md §5–§7**: fan out finder lenses → adversarially
   verify each candidate against the code (default to *refuted* unless a concrete exploit is traced; reject
   fixes that would break a legitimate machine/consumer flow) → fix only what survives. External probes stay
   read-only/non-intrusive. Fix confirmed findings before release.
5. **Version = single source**: `charts/kravn/Chart.yaml` `version` **and** `appVersion` are bumped together
   to the new `0.1.x`. That is the release version; the app reports it and the image/chart are tagged with it.
6. **Release**: commit (imperative subject + a body explaining what/why + the `Co-Authored-By` trailer), then
   `git tag v0.1.x` and push both `main` and the tag. Pushing the tag triggers the GitHub Actions release
   workflow, which builds the gateway image and publishes the image + Helm chart (OCI) to the owner's GHCR.
   `ci.yml` runs build + typecheck + `helm lint` on every push/PR. Add a **SECURITY.md** change-log row if the
   release touched security, and a **BUILD_PROGRESS.md** entry for any substantial feature.

Only true infra is env (`DATABASE_URL`, secret key, `PORT`, `KRAVN_PUBLIC_URL`/`KRAVN_CLIENT_URL`,
`KRAVN_ROLE`, `KRAVN_DB_SCHEMA`, `KRAVN_TRUST_PROXY`, `KRAVN_METRICS_TOKEN`, `KRAVN_ALLOW_STDIO`); everything
else is runtime DB-backed settings. Never commit `data/` (the SQLite DB + `secret.key`).
