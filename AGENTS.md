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

**Always reference tables UNQUALIFIED** (`users`, never `public.users` / `dbo.users` / `<schema>.users`).
The DB schema is operator-configured via `KRAVN_DB_SCHEMA` and applied centrally: Knex `searchPath` +
`migrations.schemaName` (db/knex.ts) and a `CREATE SCHEMA IF NOT EXISTS` in `runMigrations` (db/migrations.ts).
So any new migration / repo SQL is schema-correct automatically — never hardcode a schema name, never assume
`public`/`dbo`, and don't qualify identifiers. (MySQL: schema == database, set in `DATABASE_URL`; SQLite: N/A.)

### 4. Config lives in the app, secrets are fail-closed
Only true infra is env (DB, secret, port, public URL, role). Everything else is runtime DB-backed
settings. Credentials are encrypted at rest and write-only (never read back to clients).

### 5. Validate + adversarially review substantial changes
Typecheck + build + a smoke test for new surfaces; for anything security-sensitive run an adversarial
review and fix confirmed findings before declaring done.
