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
- **Native vs remote is just a badge — every MCP server is instanceable.** A native plugin is **not** a
  singleton: it can be added **N times**, each instance a distinct `servers` row with its own
  `secret`-encrypted config in `servers.plugin_config` (migration 019, additive/nullable — a null column means
  "use the plugin-type default config", so pre-existing single-instance natives keep working with no re-config).
  Create an instance via `POST /api/servers/plugin-instance` (`registry.createPluginInstance(typeId, name,
  config)`); read/edit its config via `GET`/`PATCH /api/servers/:id/plugin-config` — all behind the
  `servers.write` console gate. `resolveConfig(record, instanceServerId?)` reads the instance's own config
  (falling back to the type default), and `pluginShim(pluginId, instanceId)` threads the instance id through
  `serverCallTool`, so two instances of the same plugin (two Azure subscriptions / two Outlook accounts, each
  with different credentials and access) **never cross-read** and compose into different MCP endpoints.
  `createPluginInstance` validates against the **known** plugin-type set (`mcpServerTypeIds()`), not just
  *enabled* types (a credential-bearing native seeds disabled), and `syncPluginServers` GC only reaps
  default/known-type rows — never a user-created instance. **Consequence for the UI:** the user sees one unified
  "MCP Servers" surface with a native/remote badge; do **not** re-introduce a separate screen or a
  "can only add once" gate for native plugins.
- Provider tool-calling (OpenAI / Anthropic / Gemini function-calling) is a **separate layer**: making a
  tool "available to a model" means wiring that provider's tool-calling, regardless of where the tool
  lives. Don't conflate "is it a plugin" (tool source) with "can this model call it" (provider wiring).
- A **hook** plugin that is stateless/dependency-free lives in `plugins/native-hooks.ts` (the redactor / DLP /
  prompt-injection-guard family). One that needs a DB or a service (e.g. the **Human Approval Gate** needs
  `ApprovalService`) goes in its **own file** with a `factory(deps)` and is wired through `nativePlugins(deps)`
  in `plugins/native.ts` — never reach for repos inside `native-hooks.ts`. A **security-critical** `onToolCall`
  pre-hook must **fail CLOSED**: `applyPre` treats a THROW as fail-**open** (skipped), so wrap the body and call
  `ctx.deny(...)` on any error — only `ctx.deny` blocks; a thrown error does not.

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

Two invariants surfaced by the governance review, easy to reintroduce:
- **Tamper / pinning fingerprints are full-width hashes, never a truncated `shortHash`.** A 48-bit digest of
  attacker-controlled content (e.g. a tool description a malicious upstream fully controls) is
  second-preimage-feasible in GPU-hours — defeating the detection. Use the full SHA-256; `shortHash(x, 64)`.
- **A per-endpoint pipeline control must be enforced on BOTH planes.** Every `registry.invokeTool` caller must
  pass `mcpEndpointId` — the MCP data plane (`mcp/downstream.ts`) **and** the built-in chat (`chat/chat.service.ts`) —
  or a per-VS overlay (the approval gate, per-endpoint usage metering) silently no-ops on whichever path forgets it.

### 6. Live updates via SSE, never front-end polling
When the operator (or any UI) needs to reflect server-side changes, push them over **Server-Sent Events**,
don't poll an API on a timer. The mechanism is already built: the gateway has an in-process `EventBus`
(`events/bus.ts`) exposed on `Services.events`; fire a named event where state changes (e.g.
`this.d.events.fire('registry')` on server status / catalog / plugin changes) and it streams to connected
clients via `GET /api/events` (`routes/events.routes.ts`, auth-gated, hijacked SSE stream + heartbeat). The
operator subscribes with the `useEventStream(onEvent)` composable (`lib/events.ts`) — a fetch-based reader so
the Bearer token rides the `Authorization` header (native `EventSource` can't), auto-reconnecting and
auto-unsubscribing on unmount. To add a new live signal: add an event name to `KravnEvent`, `fire()` it at
the mutation site, and handle it in the view's `useEventStream` callback. Do NOT introduce `setInterval`
polling of `/api/*` for freshness.

### 7. Every integration ships a brand icon AND is documented on the public site
Each catalog server and native `mcp-server` plugin shows a **brand logo** in the operator so users can
tell products apart at a glance (unified catalog cards, detail modal, installed list — reused anywhere a
tool's origin is shown, e.g. the grouped Tools/Resources/Prompts lists — and on the public website's
integrations gallery). Logos are baked (build-time devDependencies only, nothing imported at runtime; the
operator CSP blocks remote images so icons must stay inlined) into `packages/contracts/src/brand-icons.ts`
from **three** sources, in priority order: (1) **simple-icons** as a monochrome `{ path, hex }` (24×24);
(2) **Iconify** (`@iconify-json/{logos,mdi,cib}`) for brands simple-icons dropped/lacks — Microsoft/Amazon
were removed from simple-icons — baked as a full-SVG `{ body, viewBox }` (logos = full colour; mdi/cib =
monochrome tinted by `hex` via `currentColor`); and (3) **Logo.dev** as a last resort for real companies no
icon set has — fetched at build time and baked as a base64-PNG data URI `{ src }` (the operator CSP allows
`img-src data:`). All three render from one source — the operator (`IntegrationIcon.vue`) and the website
(`IntegrationsGallery.vue`) each branch on `icon.src` (`<img>`) / `icon.body` (v-html of build-baked, trusted
markup) / `icon.path`. Missing brand in **all** sources → a deterministic coloured **monogram** fallback (a
wrong/unrelated icon is worse than initials — some niche MCP servers genuinely have no brand logo anywhere).

**When you add a new integration, do ALL of the following:**
1. **Icon** — regenerate the shared map: `node apps/operator/scripts/gen-brand-icons.mjs`, then rebuild
   `@kravn/contracts` (the operator/website typecheck against its `dist`, not the source). If the logo
   doesn't match (id doesn't normalise to the simple-icons slug), add an entry to `OVERRIDE` (catalog) or
   `NATIVE`/`DERIVED` (plugin/shared-glyph). If simple-icons lacks the brand, add it to the **`ICONIFY`** map
   (id → `'set:name'`, plus a tint hex for a monochrome mdi/cib icon) — browse `logos`/`mdi`/`cib` (or the
   whole collection at icon-sets.iconify.design) for the right one; add the set as a build-time devDep if
   it's not `logos`/`mdi`/`cib`. If **no** icon set has it but it's a real company, add it to the **`LOGODEV`**
   map (id → domain; resolve the canonical domain via Logo.dev's search API) and regen **with a token**:
   `LOGODEV_TOKEN=pk_… node apps/operator/scripts/gen-brand-icons.mjs` — it bakes the PNG as a data URI and
   the `fallback=404` probe drops anything Logo.dev has no real logo for (those stay monogram). The token is
   build-time only — never commit it; the generator preserves already-baked Logo.dev logos when run without
   it. Note: Logo.dev's free tier expects attribution. Only if the brand exists in **no** source is the
   monogram fallback correct — leave it (do not force an unrelated icon).
2. **Public website** — a new integration is user-facing, so it MUST appear on the site. The integrations
   gallery (`apps/website/.vitepress/integrations.data.ts` + `theme/IntegrationsGallery.vue`, shown on the
   landing page and `/integrations`) is **generated from the shared catalog**, so:
   - **Catalog server** (`MCP_SERVER_CATALOG` entry) → it appears in the gallery automatically. Nothing else
     to write (do NOT hand-add a per-integration page).
   - **Native mcp-server plugin** → add it to `NATIVE_INTEGRATIONS` in `packages/contracts/src/server-catalog.ts`
     (so the gallery + landing list it) **and** add a row to the built-in table in `apps/website/guide/plugins.md`.
   Keep the "100+" count phrasing in `guide/what-is-kravn.md` roughly current if the catalog grows a lot.
   **Scope boundary:** the public site says *what* an integration is and *that* it exists — it is NOT where
   operational / field-level / troubleshooting detail lives (how to find a value, per-field gotchas, error
   fixes). That belongs **in the plugin config where the user actually sets it up**: the `configSchema` field
   `description`s and the manifest `setup` text (rendered as Markdown in the operator). Don't duplicate config
   help into `guide/plugins.md`.

## Development, validation & release workflow

This is the loop every change goes through. The **durable record** of what shipped and why lives in **git
history + tags** (`git log`, `git tag`), the user-facing **CHANGELOG.md**, the **SECURITY.md change log**, and
**BUILD_PROGRESS.md** — not in any chat session. Keep those current so the project is fully reconstructable
from the repo alone.

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
   `ci.yml` runs build + typecheck + `helm lint` on every push/PR.
7. **Update the records — [`CHANGELOG.md`](./CHANGELOG.md) is mandatory for EVERY versioned release.** Add an
   entry under a `## [0.1.x] — <date>` heading: a benefit-first, user-facing line saying *what you can now do*
   (not the internal mechanic), tagged with the marker legend (📣 announce-worthy · 🔒 security · ⚡ perf ·
   🧩 integration · 🐛 fix). This is the user-facing history and the source for release notes/announcements, so
   it is never skipped — even a fix gets a 🐛 line. Also add a **SECURITY.md** change-log row if the release
   touched security, and a **BUILD_PROGRESS.md** entry for any substantial feature.
8. **Update the public website when a change is USER-FACING.** If a release adds or changes a capability a
   user would configure or rely on (a new integration/plugin, an auth/SSO/KMS/audit capability, a config
   surface, an install/deploy step), update the marketing/docs site in [`apps/website`](./apps/website) —
   the relevant guide page, the **Installation Manual**, and/or **Get Started** — so the public docs never
   lag the product. Explain *what it is* and *how to implement it* (config/env, prerequisites, steps).
   Follow [`apps/website/SEO.md`](./apps/website/SEO.md) for any title/description/OG changes, and register
   new pages in the VitePress nav/sidebar. Purely internal changes (refactors, internal fixes) need no site
   update. When in doubt, if it earned a 📣 in the CHANGELOG, it needs a website update.
   **Architecture diagram:** if a change alters the *shape* of the platform — a new plane/layer, a
   policy-pipeline stage, how consumers or upstreams connect, the registry/endpoint model, an identity/egress
   boundary — update the diagram component [`apps/website/.vitepress/theme/ArchitectureDiagram.vue`](./apps/website/.vitepress/theme/ArchitectureDiagram.vue)
   (rendered in `guide/concepts.md`) so it stays accurate. It's theme-aware and pulls **live integration
   counts** from the shared catalog, so those self-update; the nodes/layers/labels are hand-authored and must
   be kept in sync by hand.

Only true infra is env (`DATABASE_URL`, secret key, `PORT`, `KRAVN_PUBLIC_URL`/`KRAVN_CLIENT_URL`,
`KRAVN_ROLE`, `KRAVN_DB_SCHEMA`, `KRAVN_TRUST_PROXY`, `KRAVN_METRICS_TOKEN`, `KRAVN_ALLOW_STDIO`); everything
else is runtime DB-backed settings. Never commit `data/` (the SQLite DB + `secret.key`).
