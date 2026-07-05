# Kravn — Build Progress (durable resume anchor)

> This file is the source of truth for the autonomous end-to-end build.
> If session context is lost, RE-READ this file and continue from the first unchecked item.
> Update the checkboxes as files are completed.

## Product
**Kravn**: a seamless, self-configuring MCP gateway / registry / proxy. A simpler, Node+Vue
reimplementation inspired by IBM/mcp-context-forge. Core principles:
- **Boots first try** (`helm install` with zero values; SQLite + auto-generated key; first-run setup wizard).
- **Config lives in the app** (runtime, DB-backed, hot-reloaded, edited in the admin UI). Only true infra
  (DB, secret, port, public URL) is deploy-time env.
- **Flexibility kept, delivered in phases** (registry, virtual servers, multi-transport, federation, RBAC).

## Stack (decided)
- Monorepo: **npm workspaces** (no pnpm available). TypeScript ESM. Node >=22 (env has v25).
- Backend: **Fastify 5** (not NestJS — simpler/seamless), `@modelcontextprotocol/sdk`, **Drizzle ORM**
  (better-sqlite3 default, pg optional), **zod**, **jose** (JWT), **node:crypto scrypt** (passwords, no native dep),
  **undici** (custom SSRF dispatcher), **pino**, **prom-client**, **@casl/ability**.
- Frontend: **Vue 3 + Vite + Pinia + vue-router + @tanstack/vue-query + @casl/vue + vee-validate + zod**.
  Built static, served by Fastify (@fastify/static) → single container.
- Names/namespaces: app = `kravn`; packages = `@kravn/contracts`, `@kravn/server`, `@kravn/admin`.

## File checklist

### Root
- [x] package.json (workspaces)
- [x] tsconfig.base.json
- [x] .gitignore
- [x] .env.example
- [x] BUILD_PROGRESS.md (this file)
- [ ] README.md

### packages/contracts (@kravn/contracts)
- [x] package.json
- [x] tsconfig.json
- [x] src/index.ts
- [x] src/permissions.ts
- [x] src/settings.ts  (two-tier settings zod schema + defaults + UI metadata)
- [x] src/entities.ts  (servers/gateways, tools, resources, prompts, virtual servers, users, roles)
- [x] src/dtos.ts      (auth/setup/login + create/update DTOs + API envelopes)

### apps/server (@kravn/server)
- [ ] package.json
- [ ] tsconfig.json
- [ ] src/config/env.ts          (tier-1 bootstrap config via zod)
- [ ] src/config/secret.ts       (load-or-generate KRAVN_SECRET)
- [ ] src/logger.ts              (pino)
- [ ] src/db/schema.ts           (drizzle tables)
- [ ] src/db/index.ts            (driver selection sqlite/pg + bootstrap/migrate)
- [ ] src/db/migrate.ts          (idempotent schema create)
- [ ] src/crypto.ts              (scrypt password hash + AES-256-GCM credential encryption, fail-closed)
- [ ] src/settings/settings.service.ts  (tier-2, DB-backed, hot-reload via EventEmitter)
- [ ] src/auth/jwt.ts            (jose sign/verify, JTI)
- [ ] src/auth/auth.service.ts   (users, setup wizard, login)
- [ ] src/auth/rbac.ts           (casl ability from role+permissions)
- [ ] src/auth/plugin.ts         (fastify auth decorator + guards + CSRF)
- [ ] src/http/ssrf.ts           (DNS-pinning undici dispatcher + IP classification)
- [ ] src/http/client.ts         (outbound fetch wrapper using ssrf dispatcher)
- [ ] src/mcp/upstream.ts        (upstream MCP client manager: connect/import/call)
- [ ] src/mcp/registry.service.ts(tools/resources/prompts/servers/virtual servers CRUD + sync)
- [ ] src/mcp/downstream.ts      (expose Kravn as MCP server: streamable-HTTP + SSE)
- [ ] src/logstore.ts            (in-memory ring buffer + SSE fan-out for log viewer)
- [ ] src/metrics.ts             (prom-client registry)
- [ ] src/routes/auth.routes.ts
- [ ] src/routes/setup.routes.ts
- [ ] src/routes/settings.routes.ts
- [ ] src/routes/servers.routes.ts
- [ ] src/routes/registry.routes.ts (tools/resources/prompts/virtual servers)
- [ ] src/routes/logs.routes.ts   (SSE)
- [ ] src/routes/system.routes.ts (health, version, /metrics, bootstrap state)
- [ ] src/routes/mcp.routes.ts    (downstream MCP endpoints)
- [ ] src/app.ts                 (build Fastify app, register plugins/routes/static)
- [ ] src/main.ts                (entrypoint)
- [ ] drizzle.config.ts

### apps/admin (@kravn/admin)
- [ ] package.json
- [ ] tsconfig.json / tsconfig.node.json
- [ ] vite.config.ts
- [ ] index.html
- [ ] src/main.ts
- [ ] src/App.vue
- [ ] src/router.ts
- [ ] src/api/client.ts          (fetch wrapper w/ auth + CSRF)
- [ ] src/stores/auth.ts
- [ ] src/stores/bootstrap.ts    (setup-needed? / instance info)
- [ ] src/lib/ability.ts         (casl/vue)
- [ ] src/components/* (AppShell, DataTable, Field, etc.)
- [ ] src/views/SetupView.vue
- [ ] src/views/LoginView.vue
- [ ] src/views/DashboardView.vue
- [ ] src/views/ServersView.vue
- [ ] src/views/ToolsView.vue
- [ ] src/views/ResourcesView.vue
- [ ] src/views/PromptsView.vue
- [ ] src/views/VirtualServersView.vue
- [ ] src/views/SettingsView.vue  (driven by settings UI metadata)
- [ ] src/views/LogsView.vue      (EventSource)
- [ ] src/style.css

### deploy
- [ ] Dockerfile (multi-stage, single container)
- [ ] .dockerignore
- [ ] docker-compose.yml
- [ ] charts/kravn/Chart.yaml
- [ ] charts/kravn/values.yaml  (boots with ZERO overrides)
- [ ] charts/kravn/templates/* (deployment, service, pvc, secret, configmap, ingress-optional, servicemonitor-optional, _helpers)
- [ ] charts/kravn/README.md

### finalize
- [ ] README.md (run instructions)
- [ ] npm install + typecheck (best-effort; network may be unavailable)
- [ ] update memory notes

## Notes / decisions log
- 2026-06-27: Fastify chosen over NestJS for the hand-built MVP (simplicity/seamless boot). Memory updated.
- SSRF default: allow private networks (in-cluster MCP servers) but always block cloud metadata IPs.
- CSRF: double-submit cookie, on by default, works with the SPA (no need to disable).
- Passwords: node:crypto scrypt (no native dep). Credentials at rest: AES-256-GCM, fail-closed.
- DB: portable SQL store over better-sqlite3 (default) + pg (optional), NOT Drizzle (dual-dialect was too fragile to hand-generate; fewer deps = more seamless).
- Frontend deps kept minimal: Vue + Pinia + vue-router only (no PrimeVue/Tailwind/TanStack/casl), plain CSS.

## ✅ BUILD COMPLETE & VALIDATED (2026-06-27)
All checklist items implemented. Validation run:
- `npm install` ✓ (282 pkgs)
- `npm run build` ✓ (contracts → admin SPA into apps/server/public → server tsc)
- `npm run typecheck -w @kravn/server` ✓ clean
- `npm run typecheck -w @kravn/admin` (vue-tsc) ✓ clean
- Live smoke test (SQLite, zero config): boot ✓ · /healthz ✓ · /api/bootstrap setupRequired:true ✓ ·
  setup wizard creates admin + returns JWT ✓ · auth/me ✓ · 401 without token ✓ · settings GET/PUT (runtime) ✓ ·
  registered a real stdio upstream (@modelcontextprotocol/server-everything) → status online, **synced 13 tools** ✓ ·
  downstream `POST /mcp` tools/list ✓ · **tools/call echo round-tripped through the gateway** ✓ · /metrics ✓

### To run
- Local: `npm install && npm run build && npm start` → http://localhost:8080 (setup wizard)
- Dev: `npm run build -w @kravn/contracts` then `npm run dev` (8080) + `npm run dev:admin` (5173)
- Docker: `docker compose up --build`
- K8s: `helm install kravn ./charts/kravn` + `kubectl port-forward svc/kravn 8080:80`

## ✅ POST-MVP PASS 2 (2026-06-28)
- Fixed "Copy URL" on virtual servers: robust `copyText()` (navigator.clipboard + textarea/execCommand
  fallback for non-secure contexts) + visual feedback. Root cause: no feedback + clipboard undefined off-localhost.
- Added a global **toast** system (`stores/toast.ts` + `ToastHost.vue` in App.vue) and wired feedback into
  server sync/save/delete, tool toggle, virtual-server save/delete/copy.
- Added **User management**: `routes/users.routes.ts` (GET/POST/DELETE /api/users, self-delete guard) +
  `UsersView.vue` + nav/route. RBAC verified live: editor gets 403 on /api/users.
- Note: resources & prompts are intentionally read-only catalogs (discovered from upstream via MCP; composed
  via virtual servers) — not a missing feature.
- Re-validated: server+admin typecheck clean, full build clean, live smoke test (login, users CRUD,
  vserver create, self-delete 400, editor 403) all pass.

## ✅ PASS 3 — Kravn-native prompts (2026-06-28, ContextForge-style)
Authored prompt templates (not just discovered): Jinja2-compatible via **nunjucks**, arguments,
version counter, preview, exposed over MCP and composable into virtual servers.
- contracts: `localPromptSchema` + `localPromptArgumentSchema` + `upsertLocalPromptSchema` + `previewLocalPromptSchema`.
- DB: `local_prompts` table + `LocalPromptsRepo` (version bumped on update).
- `src/prompts/render.ts` (nunjucks, autoescape off) + `missingRequiredArgs`.
- `routes/local-prompts.routes.ts`: GET/POST/PATCH/DELETE `/api/local-prompts` + POST `/api/local-prompts/preview`.
- downstream MCP: local prompts merged into `prompts/list`; `prompts/get` renders the template (required-arg validation → -32602).
- UI: PromptsView now has a "Kravn prompts" CRUD section (template editor + args + live preview) above the read-only discovered list; VirtualServers prompt selector includes local prompts.
- Smoke-tested live: preview ✓, create ✓, MCP prompts/list shows local+discovered ✓, prompts/get renders ✓, missing-required → -32602 ✓. Server+admin typecheck + full build clean.

## ✅ PASS 4 — SSO (global) + per-VirtualServer access policy (2026-06-28)
Architecture correction applied: identity/login is GLOBAL; per-VS is ACCESS CONTROL (not a second login);
upstream service auth stays at the server level.
- **Global SSO** (Settings → Authentication): OAuth2/**OIDC** via `openid-client` (discovery URL; Entra/Okta/Google/
  Keycloak/Auth0) and **SAML** via `@node-saml/node-saml`. Config stored in `auth_config` (settings row id='auth'),
  secrets (clientSecret, idpCert) AES-GCM encrypted, never returned (set-flags only). Auto-provision + default role.
  Flows: `/api/auth/sso/oauth/:id/start|callback`, `/api/auth/sso/saml/start` + ACS `/saml/callback` → find-or-create
  user → Kravn JWT → redirect SPA `/login?token=`. Login page renders SSO buttons from `/api/bootstrap`.
- **Per-VirtualServer access policy**: `access` = public | authenticated | restricted(+allowedRoles), enforced on
  `POST /servers/:slug/mcp` (manual bearer verify; global `/mcp` still requires mcp.invoke). Columns added via
  idempotent ALTER migration.
- Files: contracts (oauth/saml/updateAuthConfig schemas, AuthConfigView, SsoMethod, vsAccess); server
  `auth/sso.service.ts`, `routes/sso.routes.ts`, `http/baseurl.ts`, `auth/plugin.ts` (authenticateToken/bearerToken),
  `AuthConfigRepo`, mcp.routes per-VS gate; admin `AuthenticationView.vue` + nav/route, LoginView SSO buttons + token
  capture, VirtualServers access fields.
- Validated live: config save (secret-safe) ✓, bootstrap ssoMethods ✓, **OIDC start → 302 to Google w/ PKCE+state** ✓,
  per-VS: no-token→401, editor→403, admin→200, public→200 ✓, ALTER migration on existing DB ✓. typecheck+build clean.
- SAML caveat: implemented + wired + typechecked, but the assertion-validation path needs a REAL IdP to validate
  end-to-end (no SAMLResponse to test here). OIDC is fully proven.
- Roadmap (still deferred): per-user on-behalf-of OAuth to upstreams (e.g. each user links their own GitHub) — the
  user-linked external-identity token vault. Distinct from login SSO.

## ✅ PASS 5 — Brand & design system (2026-06-28)
Ported the visual identity from the user's original Kravn project (/home/mpanichella/TeamProjects/addlayer/kravn).
- Design tokens (light default + `html.dark`): warm off-white page, white surfaces, warm sidebar; **brand = raven
  black #0F1115**, **accent = amber #C9892C**; full radius/spacing/semantic scales. Ported into admin `style.css`,
  with every existing component class (.btn/.card/table/.badge→pill/.alert/.modal/inputs/.toast/.log-line) re-skinned
  to the tokens so all views inherit the look without per-view edits.
- **RavenLogo.vue** (two-path raven silhouette, currentColor) copied from the brand; favicons + webmanifest copied to
  admin/public; index.html updated (title "Kravn", favicon/theme-color).
- Fonts: **Inter** + **JetBrains Mono** via @fontsource (bundled/offline-friendly, 65 font files in build).
- **Theme store** (light/dark + sidebar collapse, persisted to localStorage `kravn.theme`, prefers-color-scheme
  default); dark class applied pre-mount.
- **AppShell** rewritten to the Kravn sidebar: raven logo + name, lucide-vue-next icons, Workspace section, footer with
  light/dark toggle + sign out + collapse. Login/Setup screens use the branded login-card + logo.
- Validated: admin typecheck + full build clean; tokens, fonts, favicons confirmed in build output. (Visual render not
  screenshot here — run `npm run build && PORT=8098 npm start` to view.)

## ✅ PASS 6 — SAML federation-metadata import (2026-06-28)
"Import from metadata URL" for SAML (Azure/Entra federation metadata XML), alongside manual config.
- Parser `auth/saml-metadata.ts` (fast-xml-parser, removeNSPrefix) extracts entityID, SSO redirect entryPoint,
  and signing X509 cert (PEM-armor + whitespace stripped).
- Route `POST /api/auth/sso/saml/import-metadata` accepts `{url}` (fetched SSRF-safe via safeFetch, 5MB cap) OR
  pasted `{xml}`; returns `{entityId, entryPoint, idpCert}`. UI fills the SAML fields for review before Save.
- Added optional `saml.idpIssuer` (from metadata entityID) → passed to @node-saml as `idpIssuer` to validate the
  assertion source. New `IdP issuer` field in AuthenticationView.
- Validated live: pasted XML parsed ✓; **real Azure federation metadata URL fetched + parsed** (entityId, entryPoint
  .../saml2, 1008-char cert) ✓. typecheck server+admin + build clean.

## ✅ PASS 7 — Plugin system (2026-06-28, ContextForge/Apigee-inspired)
A standard, documented plugin contract — anyone can build & import one.
- New workspace **`@kravn/plugin-sdk`** (`packages/plugin-sdk`): the public contract — `pluginManifestSchema`,
  hook/mcp-server types, `definePlugin`, `textResult`. Plugins are plain ES modules (default export); the SDK is
  types-only at runtime (examples import nothing → load anywhere incl. Docker).
- **Two plugin types, one contract:**
  - `hook` (Apigee-style): `onListTools` (filter/annotate), `onToolCall` (mutate args / `ctx.deny`), `onToolResult`
    (mutate result). Run in `priority` order; fail-open on unexpected throw, explicit deny blocks. Wired into the
    single choke point `RegistryService.invokeTool` (so downstream `/mcp` AND the UI playground get hooks) + `onListTools`
    in downstream `tools/list`.
  - `mcp-server`: in-process MCP server (`server.listTools/callTool/...`). Enabling one auto-registers a
    `transport:'plugin'` server (id `plg_<id>`) via `RegistryService.syncPluginServers`; UpstreamManager delegates the
    `plugin` transport to the PluginManager shim → flows through the normal registry/virtual-server/downstream code.
- **PluginManager** (`plugins/manager.ts`): discovers `.mjs`/folder plugins in `KRAVN_PLUGINS_DIR` (default
  `<dataDir>/plugins`), validates manifest, enable/disable + per-plugin config persisted (`plugins` table + PluginsRepo),
  cache-busted dynamic import (reload on rescan), seeds 2 example plugins (disabled) into an empty dir.
- Routes `plugins.routes.ts`: GET list (+loadErrors), rescan, import (paste source → file → scan), PATCH enable/config,
  DELETE. Admin **PluginsView** (list/type/enable/config JSON/import/rescan/delete + trust-model banner) + nav/route.
- Trust model documented (in-process, full privileges). **PLUGINS.md** = full developer guide; `examples/plugins/`
  (tool-guard hook + hello-server mcp-server).
- Validated live: seeded plugins discovered ✓; enable mcp-server plugin → server online + `say_hello` tool synced ✓;
  `tools/call` through `/mcp` returns plugin output ✓; config hot-applied (greeting) ✓; hook denies + hides a tool ✓;
  import-by-paste registers a new plugin ✓. typecheck (sdk/contracts/server/admin) + build clean.
- **Persistence (PASS 7b):** plugin source is stored IN THE DB (`plugins.code`); loaded at runtime via an
  in-process `data:` URL import — nothing written to the pod filesystem. Survives pod restarts and is shared across
  replicas (Postgres). The plugins dir is only an optional dev "inbox" (single-file → ingested to DB on scan).
  Constraint: plugins must be self-contained (node: builtins OK, external npm not resolvable). Proven live: imported
  + enabled a plugin, **wiped the plugins dir, restarted** → plugin still loaded from DB and callable (`pong-from-db`).
- **Config UX (PASS 7c):** the plugin Config modal now renders a **form generated from the plugin's `configSchema`**
  (string/number/boolean/enum/array/object), instead of a raw `{}` JSON box; raw-JSON fallback remains (+ "Edit as JSON"
  toggle) and a hint shows when a plugin declares no schema. Added the **`x-kravn-source`** schema extension
  (`tools`/`resources`/`prompts`/`servers`): array fields → live multi-select picker, string fields → single-select,
  populated from the registry. tool-guard example updated to use it; documented in PLUGINS.md. Verified backend serves
  the hint; admin typecheck + build clean.
- **Expanded hook points (PASS 7d) — ContextForge parity:** hooks now cover the full MCP flow, not just tools.
  SDK `HOOK_POINTS` + contexts for: `onListTools`/`onToolCall`/`onToolResult`, `onListResources`/`onResourceRead`
  (pre-fetch, deny)/`onResourceResult` (post-fetch), `onListPrompts`/`onPromptGet` (pre-fetch, deny)/`onPromptResult`
  (post-fetch), and `onResolveUser` (post-auth, mutate/deny). Wired: tool hooks in `invokeTool`; resource hooks in
  `readResourceFrom`; prompt hooks in `getPromptFrom` + local prompt rendering; list hooks in downstream
  list methods; `onResolveUser` in the auth `authenticate` decorator (gated by `hasResolveUser()`).
  Admin Plugins page now shows each plugin's implemented hook points (badges) + a "Hook points" summary card.
  Example refresh: seeded example plugins now re-ingest on scan so their manifests stay current (without resurrecting
  deleted ones) — fixes stale schemas. Validated live: prompt pre-fetch deny (-32000) ✓, resources/list ✓,
  hookPoints labels ✓, tool-guard schema refreshed to include `x-kravn-source` ✓.
- **Config UX picker (PASS 7e):** plugin config fields can declare `x-kravn-source: 'tools'|'resources'|'prompts'|'servers'`
  to render a live picker (array→multi-select, string→single-select) instead of free text. tool-guard updated to use it.
- Roadmap: sandboxed/WASM plugin isolation; a marketplace catalog feeding the Import flow.

## ✅ PASS 8 — LLM Models (providers / models / test) (2026-06-28)
The ContextForge-style "Model Configs" screen.
- `llm_providers` table + `LlmProvidersRepo`; contracts `LlmProvider` + create/update/test DTOs + `LlmTestResult`.
- `llm/llm.service.ts`: CRUD + a real connectivity **test** that runs a 1-token completion against the provider.
  Types: openai, anthropic, azure-openai, ollama, openai-compatible (per-type URL/auth: Bearer / `api-key` / `x-api-key`).
  API key AES-GCM encrypted at rest, never returned (apiKeySet flag only). Calls go through the SSRF-safe dispatcher.
  Status (ok/error/lastError/lastTestedAt) persisted from tests.
- `routes/llm.routes.ts` (GET/POST/PATCH/DELETE `/api/llm/providers` + `/:id/test`) + app wiring.
- Admin **LlmModelsView** (providers + models list + Test button + add/edit modal) + nav "LLM Models" + route.
- Validated live: create (secret-safe) ✓; list never returns the key ✓; **test → real OpenAI call → "HTTP 401 Incorrect
  API key"** ✓; ollama localhost test → "fetch failed" (SSRF allows private) ✓; update default model + delete ✓.
- Note: this is the config/registry + connectivity test surface (parity with ContextForge Model Configs). Wiring it to a
  runtime consumer (MCP `sampling/createMessage`, or A2A agents) is a natural follow-up.

## ✅ PASS 9 — Teams (2026-06-28, ContextForge-style)
- `teams` + `team_members` tables + `TeamsRepo` (CRUD + membership + `teamIdsForUser`). Contracts: `Team`,
  `TeamMember`, team DTOs, `teams.read`/`teams.write` perms.
- `AuthUser.teams` now populated (authenticate + authenticateToken + login/register responses + /me).
- Virtual servers gain `allowedTeams`; per-VS access `restricted` now allows by **role OR team membership**,
  enforced on `POST /servers/:slug/mcp`.
- Routes `teams.routes.ts` (CRUD + members add/remove). Admin **TeamsView** (teams + member management) + nav/route,
  and a team picker in the Virtual Servers access section.
- Validated live: create team + add member ✓; VS restricted to team → member 200, non-member 403, no-token 401 ✓;
  /me returns the user's teams ✓. typecheck + build clean.
- Note: team-scoping is applied to virtual servers (the user-facing MCP endpoints). Broader per-entity ownership/
  visibility (every resource scoped to a team like ContextForge) is a future extension.

## ✅ PASS 10 — Monorepo (pnpm + Nx) + multi-app + end-user client (2026-06-28)
Restructured into a polyglot-ready monorepo with three audiences (decisions: one modular backend; operator =
admin+gateway; separate client; include client port now).
- **Tooling:** npm workspaces → **pnpm 9 + Nx 20**. `pnpm-workspace.yaml`, `.npmrc` (node-linker=hoisted), `nx.json`
  (build dependsOn ^build). Workspace deps now `workspace:*`. Root scripts use `nx run-many`. Dockerfile + ignores
  updated to pnpm + new paths. Validated: `nx run-many -t build` builds all packages; gateway boots + serves operator.
- **Layout:** `apps/gateway` (the Fastify control-plane backend, renamed from apps/server), `apps/operator` (operator
  SPA = admin+gateway sections, renamed from apps/admin, builds into apps/gateway/public), `apps/client` (NEW end-user
  chat SPA), `packages/{contracts,plugin-sdk,ui}`. `@kravn/ui` shares the design (style.css + raven paths).
- **Chat runtime (gateway):** `chat_projects`/`chat_conversations`/`chat_messages` tables + `ChatRepo` (per-user) +
  `ChatService` — LLM completion via the configured providers (OpenAI-compatible w/ a tool-calling loop; Anthropic plain),
  tools sourced from the conversation's **team-scoped virtual server** (registry.invokeTool → plugin hooks apply),
  persistence. Routes `/api/chat/{options,projects,conversations,...}`.
- **Client app (apps/client):** Vue 3 SPA (own port 5174, proxies /api), password login, conversation list, new-chat
  picker (provider/model/optional virtual-server), chat thread + composer. Reuses `@kravn/ui` + RavenLogo.
- Validated live: nx build (5 build targets) ✓; chat options/create/send/persist end-to-end (LLM called, graceful
  error on bogus key, user msg persisted, title set) ✓; gateway + client typecheck clean.
- Notes: SSO on the client = password for now (SSO callback returns to the gateway/operator); client is a separate
  deployable (its own Dockerfile/serve TBD); the chat data currently lives in the gateway DB (extract to its own
  backend when warranted).

## ✅ PASS 11 — Multi-dialect DB + versioned migration framework (2026-06-28)
Replaced the hand-rolled `CREATE TABLE IF NOT EXISTS` + ad-hoc `ALTER` bootstrap (which only handled
sqlite+pg and was not a real migration system) with **Knex** as the query/migration layer over four engines.
- **Engines:** SQLite (default), **PostgreSQL, MySQL/MariaDB, SQL Server** — selected via `DATABASE_URL`
  (`postgres://`, `mysql://`/`mariadb://`, `sqlserver://`/`mssql://`, `sqlite://`/path, empty→embedded sqlite).
  `resolveDb()` maps each to a Knex `{client, connection}` (mssql DSN parsed into a tedious config).
- **Migrations:** `db/migrations.ts` — versioned, in-code Knex `MigrationSource` (ships inside the bundle, no
  loose .js files). Migration `001_initial_schema` builds the **whole** schema from zero via the schema builder
  (dialect-correct DDL); `hasTable`/`hasColumn` guards make it idempotent + bridge DBs from the old bootstrap.
  Future changes = append `002_…`; tracked in `knex_migrations`. Runs automatically on boot (`runMigrations`).
- **Cross-dialect schema rules** (so it's valid on MySQL/MSSQL too): PK/unique/indexed cols are `varchar(n)`
  (TEXT can't be a key there); large/JSON cols are `text` with **no** DB default (MySQL forbids TEXT defaults);
  booleans are `integer` 0/1; timestamps `varchar(40)`. `TABLES` exported for offline DDL validation.
- **Store:** `db/store.ts` rewritten as a thin Knex wrapper — same `run/get/all(?)` interface, so **all repos are
  unchanged** (knex.raw translates `?` per dialect); `rowsOf()` normalizes pg/mysql2/sqlite/mssql result shapes.
  `db/knex.ts` builds the instance (sqlite dir mkdir + WAL/busy_timeout/FK pragmas via pool.afterCreate).
- Validated: **SQLite live** — migrations build all 16 tables from zero, idempotent re-open, repo round-trips
  (users/teams/virtual-servers incl. bool+JSON mapping) ✓; full gateway boots on fresh sqlite + HTTP setup-admin →
  login round-trip ✓. **pg / mysql2 / mssql** — DDL compiled offline for all three, dialect-correct & clean
  (varchar keys, no TEXT defaults on MySQL, nvarchar/nvarchar(max) + named defaults on MSSQL) ✓. No live pg/mysql/
  mssql server was available here, so those need a smoke against a real instance to fully certify the runtime path.
- typecheck clean; `pnpm build` (nx, all projects) green. Deps added: knex, mysql2, tedious (pg/better-sqlite3 kept).

## ✅ PASS 12 — Client SSO + dedicated chat pod (role boot) + Projects with documents (2026-06-28)
Advanced the three items named after the DB framework. Understand + adversarial-review workflows bracketed the work.
- **(1) SSO on the end-user client.** The SSO redirect now returns the token to the SPA that *started* login.
  Added an allowlisted `returnTo` enum ('operator'|'client'): OAuth carries it in the SERVER-stored state map
  (untamperable); SAML carries it via RelayState (untrusted → allowlisted on return). `resolveReturnTo()` only ever
  yields operator|client (no raw URLs → no open-redirect); `spaBase()` maps 'client'→`KRAVN_CLIENT_URL` (new env),
  else the gateway origin. Error paths (OAuth + SAML) thread returnTo too. Client `LoginView.vue` now renders SSO
  buttons (`?returnTo=client`) and captures `?token=`/`?sso_error=` exactly like the operator. Files: sso.service.ts
  (PendingOAuth.returnTo, SsoLoginResult.returnTo, oauthStart/samlStart/issue signatures), sso.routes.ts
  (resolveReturnTo/spaBase/redirectWithToken/ssoError), env.ts (clientUrl), client LoginView.
- **(2) Dedicated chat backend as a pod (same image).** `KRAVN_ROLE=all|gateway|chat` gates HTTP route
  registration in app.ts: shared always (auth, sso, setup, bootstrap, health/metrics); gateway = control-plane +
  MCP + operator SPA; chat = end-user chat API only. A chat pod shares the DB and still reuses registry/LLM/plugins
  in-process for tool calls. Validated: chat role → /api/chat/*=401(registered) /api/servers=404; gateway role → the
  inverse; shared routes 200/302 in both.
- **(3) Projects with documents (Claude-Projects-style, push/upload — not the old kravn's pull/connectors+Qdrant
  RAG, which has no "project" concept).** New migration **002** (proves evolutionary migrations): adds
  `chat_projects.instructions` (nullable text, ALTER-safe on populated tables) + `chat_project_documents` table
  (cross-dialect). ChatRepo: getProject/updateProject + documents CRUD (ownership-scoped). chat.service
  `buildSystemPrompt` injects project instructions + documents (60k-char budget) as system context when a
  conversation has a projectId. Routes: project CRUD + `/documents`. Client ChatView: sidebar Projects section,
  project panel (editable instructions + document add/remove), new-chat-in-project + project picker.
- Validated: contracts+gateway+client typecheck clean; `pnpm build` (nx, all) green; migration-002 smoke (both
  migrations apply, new table+column, project/doc CRUD, conversation scoping, cascade-on-delete, idempotent);
  role-boot smoke (route presence per role).
- **Adversarial review workflow (4 dimensions → skeptic-verified) found 7 real defects — ALL FIXED + re-tested:**
  · CHAT-1 (critical) cross-user doc leak: buildSystemPrompt loaded docs for a foreign projectId → now ownership-gated.
  · CHAT-2 (critical) conversation create didn't verify project ownership → now 404s on foreign projectId (HTTP-tested).
  · CHAT-3 (high) deleteConversation wiped messages unscoped → now scoped via `WHERE conversation_id IN (SELECT ... AND user_id=?)`.
  · SSO-1 (high) JWT exfil via Host/X-Forwarded-Host: operator redirect now SAME-ORIGIN RELATIVE (`/login?...`, no header trust); client uses validated absolute KRAVN_CLIENT_URL.
  · KRAVN-ROLE-1 (medium) chat pod w/o KRAVN_CLIENT_URL silently broke SSO → explicit 500 on the SSO path + startup warn.
  · ORD-001 (medium) non-deterministic `ORDER BY created_at` (affected doc-context truncation) → added `, id` tiebreaker on all chat list queries.
  · SSO-2 (low) KRAVN_CLIENT_URL unvalidated → now must be an absolute http(s) URL at boot (refuses '//evil.com'). 2 false positives correctly refuted.
- Security re-validation: repo smoke (B can't read A's project; B's delete leaves A's messages intact; owner delete works; stable ordering) + HTTP smoke (B binding A's project → 404, own chat → 201) + clientUrl-validation boot refusal.
- Notes / still-open: SSO token is delivered in the URL (existing mechanism; cross-origin to the client widens
  Referer/history exposure — a one-time-code exchange is the future hardening); chat pod data still lives in the
  shared gateway DB; project documents are raw-text context (no embeddings/RAG — that's the KB future).

## ✅ PASS 13 — LLM model discovery (multiselect) + Google Gemini provider (2026-06-29)
Replaced the free-text "models (one per line)" box with a curated multiselect + live discovery, and added Gemini.
- **Gemini end-to-end**: new `gemini` provider type (contracts LLM_PROVIDER_TYPES). chat.service `complete()` gains a
  Google Generative Language `generateContent` branch (systemInstruction + contents with user/model roles; gemini
  excluded from the OpenAI tool-loop for now). llm.service: gemini connectivity test (`:generateContent`), default
  base `https://generativelanguage.googleapis.com`.
- **Model catalog**: `LLM_MODEL_CATALOG` in contracts — curated current model ids per provider (openai/anthropic/
  gemini/azure/ollama), shown as an offline multiselect so users don't research model codes.
- **Live discovery**: `POST /api/llm/discover` (settings.write) → `LlmService.discoverModels` calls the provider's
  list API via SSRF-safe fetch — OpenAI/compatible/Ollama `GET /models`, Anthropic `GET /v1/models`, Gemini
  `GET /v1beta/models` (strips `models/`, filters generateContent). Resolves the key from a saved provider (by id)
  or an ad-hoc apiKey used only for the call (never stored). Azure/no-key/no-base/failure → graceful catalog fallback
  with a message. Returns `{models, source:'live'|'catalog', message}`.
- **Operator UI**: LlmModelsView now has a checkbox multiselect (catalog ∪ discovered ∪ custom), a "↻ Fetch from
  provider" button, a custom-model-id add, and a default-model picker constrained to the selected set. Gemini added.
- Validated: contracts+gateway+operator typecheck clean; `pnpm build` green; HTTP smoke of /api/llm/discover across
  all types — catalog fallbacks correct, and the **live path provably reached OpenAI** (bad key returned OpenAI's real
  401, then fell back).
- **Adversarial review found 4 real defects — ALL FIXED** (1 false positive refuted): LLM-DISCOVER-001 (credential
  exfiltration — a stored provider key could be sent to a caller-supplied baseUrl; now: with providerId and no caller
  key, baseUrl+key come ONLY from the saved provider); gemini empty-output (maxOutputTokens 1024→8192 + MAX_TOKENS
  message for 2.5 thinking models); operator default-model select desync on deselect; save allowed zero models (guard + disabled button).
- Also fixed this session: client/operator Vite proxies now target `127.0.0.1:8080` (not `localhost`) — on dual-stack
  hosts `localhost`→`::1` could hit a different process (e.g. a `kubectl port-forward` of the old gateway) instead of
  Kravn on IPv4, which broke client login.

## ✅ PASS 14 — Chat file attachments → model context (2026-06-29) [Part 1 of the file feature]
Users can upload files in the client chat; their text is extracted server-side and injected into the model context
(ChatGPT-style "attach a file and ask about it"). File types: PDF, Word (.docx), Excel/CSV, plain text/code.
- **Deps**: @fastify/multipart (10MB/file limit) + extractors unpdf (PDF), mammoth (docx), xlsx (SheetJS, xlsx/csv).
- **Migration 003**: `chat_attachments` (id, conversation_id, message_id nullable, user_id, name, mime, size, kind,
  extracted_text, data_b64 — both `longtext` so big files fit on MySQL). Original bytes kept (base64) for re-download
  + the future code-interpreter.
- **Extract** (chat/extract.ts): PDF→text, docx→raw text, xlsx/csv→per-sheet CSV, text/code→utf-8; 200k-char cap;
  binary files (NUL byte) skipped. Returns {kind, text}.
- **Backend**: `POST /api/chat/conversations/:id/attachments` (multipart, ownership-checked) → extract + store →
  returns metadata only. `postChatMessageSchema` gained `attachmentIds`; `send()` links them to the user message and
  `buildSystemPrompt` injects all of the conversation's (owner-scoped) attachment text under a 120k budget. Repo
  methods are user+conversation scoped; deleteConversation cascades attachments.
- **Client**: composer 📎 button + hidden multi-file input, an upload tray with removable chips, attachments rendered
  under each message; can send with files (default prompt if no text). `api.upload()` (FormData).
- Validated: typecheck (all) + `pnpm build` green; HTTP smoke (CSV→spreadsheet/58 chars, TXT→text, foreign
  conversation→404, migration 003 applied, bytes+text stored); repo smoke (link, owner-only context, B can't read or
  hijack A's attachments, cascade-on-delete).
- **Adversarial review: security dimension found NOTHING (multi-tenant scoping solid); 5 robustness/UX defects found
  + ALL FIXED** (3 false positives refuted): F1 NUL bytes from UTF-16 files crashed Postgres INSERT (now stripped in
  extract cap()); attach-2/3 in-flight upload racing a conversation switch orphaned the file / unsafe `!` (now capture
  conv + discard stale results); attach-1 mid-send conversation switch pushed the reply into the wrong thread (now
  guard UI updates by conv id); F2 large base64 INSERT could exceed MySQL packet → opaque 500 (addAttachment now
  wrapped with a clear error). Re-validated: typecheck/build green + NUL-strip unit check (UTF-16 csv → no NUL).
- **Part 2 (the "complete this Excel and get it back" code-interpreter) NOT yet built** — user chose a sandboxed
  Python interpreter. Plan: do it as **Pyodide (CPython-in-WASM)** in a worker (real Python incl. pandas/openpyxl, but
  WASM-sandboxed: no host FS/network, no system Python to deploy → respects the hard "no Python / seamless" constraint)
  exposed to the chat as a tool that reads an attachment's bytes (data_b64), runs model-generated code, and returns an
  output file for download. This is the next chunk.

## ✅ PASS 15 — Code interpreter (Pyodide/WASM sandbox) [Part 2 of the file feature] (2026-06-29)
"Completá este Excel y devolvémelo" — the model runs Python in a sandbox to transform the user's attached files and
returns a downloadable result. Done with **Pyodide (CPython→WASM)** to honor "no system Python / seamless deploy":
real Python, but WASM-sandboxed (no host filesystem/network), no Python to install, just an npm dep.
- **Decision** (user, 2026-06-29): wanted a real Python code interpreter but dislikes Python + values seamless deploy;
  and for the modest "complete an excel" use case a separate pod isn't worth it. Resolution: Pyodide in a worker
  thread, in-process, behind a pluggable `CodeExecutor` interface (swap to a container/microVM pod later w/o rewrite).
- **Offline libs**: bundled openpyxl + et_xmlfile wheels (~270KB) in apps/gateway/assets/pyodide-wheels; the worker
  extracts the .whl (a zip) onto sys.path via stdlib zipfile — NO micropip, NO network. pandas/numpy deliberately not
  bundled (heavier); openpyxl + stdlib (csv/json/etc.) covers spreadsheet completion. Dockerfile copies the assets.
- **Executor** (interpreter/executor.ts + worker.ts): Pyodide lazy-loads on first run (boot stays fast); files passed
  in/out as base64; a hard **timeout terminates the worker** (only reliable way to stop sync WASM) and it respawns;
  executions **serialized via a promise-chain queue**; worker `unref`'d so it doesn't hold the process open.
- **Chat integration**: built-in tool `kravn_run_python` (reserved name) added to the tool-loop; the loop routes that
  name to `runInterpreter`, which feeds the conversation's attachment bytes (owner-scoped `getAttachmentFiles`) to the
  sandbox, persists output files as new attachments, links them to the assistant message, and returns stdout/stderr.
  System prompt tells the model the file names + how to produce a download.
- **Anthropic tool-calling wired (2026-06-29)**: discovered the user's only provider is Anthropic (claude-sonnet-4-5),
  so the interpreter never engaged ("I can't create Excel files"). Added Anthropic Messages tool support: complete()
  now sends `tools` (name/description/input_schema), parses `tool_use` blocks → normalized tool_calls, and
  `toAnthropicMessages()` translates the internal OpenAI-shaped history (incl. tool_use/tool_result, grouped) to
  Anthropic blocks. Tool loop now runs for OpenAI-family AND Anthropic; **Gemini still plain (no tools yet)**.
- **Download**: `GET /api/chat/attachments/:id/download` (auth, owner-scoped) streams the bytes; client renders
  attachment chips as download buttons (auth fetch → blob → save).
- Validated: typecheck (all) + `pnpm build` green. **Executor proven standalone**: real Excel completion
  (total=price×qty → valid xlsx), error→traceback, stdout capture, infinite-loop→terminated at timeout, recovery after
  kill. **Download HTTP round-trip** (md5 identical, 401 without auth). Gateway boots fine (interpreter lazy). The only
  link not live-tested is the model *deciding* to call the tool (needs a real provider key); the tool-loop itself is
  proven and every deterministic step (sandbox, persistence, download, Anthropic msg translation) is tested.
- **Adversarial review: 2 confirmed (7 refuted incl. sandbox-escape/traversal) — BOTH FIXED + validated**: (high)
  WASM linear memory was uncapped → a giant Python allocation could OOM the gateway process; fixed by capping the
  worker's WASM heap to 768MB via `v8.setFlagsFromString('--wasm-max-mem-pages=12288')` inside the worker (execArgv
  rejects V8 flags) — re-tested: a 2GB alloc now fails with MemoryError, the process survives, Excel still works.
  (low) final tool round executed + persisted outputs then discarded the result as "limit reached" → now the loop
  detects the limit BEFORE running that round's tools.
- Notes/limits: interpreter wired for OpenAI-family + Anthropic (Gemini still plain); pandas/numpy not bundled
  (openpyxl + stdlib only); WASM heap capped at 768MB/worker.

## ✅ PASS 16 — Tools-are-plugins: code interpreter → native plugin; AGENTS.md; removed Hello (2026-06-29)
User direction: keep it ordered — every tool must be a plugin (native, pre-loaded like Tool Guard), not hardcoded.
- **AGENTS.md** (new, repo root): codifies the principle as Core principle #1 (+ multi-tenant scoping, cross-dialect
  SQL, app-config/secrets, validate+review). This is the recurrence guard.
- **Native plugin registry** (`plugins/native.ts` + PluginManager): a native (built-in) plugin is seeded as a DB
  record (appears in the Plugins screen, enable/disable, config), **enabled by default on first install**, re-seeded
  if removed, and skipped by the code-loader (it's in-code, with privileged runtime a sandboxed user plugin can't
  have). `manager.isEnabled(id)` added; `setEnabled` allows native ids.
- **Code interpreter is now `kravn-code-interpreter` native plugin** (type mcp-server, the `run_python` tool def lives
  in native.ts). ChatService no longer hardcodes the tool — it offers it only when `plugins.isEnabled(CODE_INTERPRETER_ID)`
  && the provider supports tool-calling. Execution stays native (Pyodide + attachment files) — the distinction the
  AGENTS.md rule draws between native and user plugins. Toggle it off in the Plugins UI → the tool disappears from chat.
- **Removed the "Hello MCP Server" example** (seed const, examples/plugins/hello-server.mjs, seeded copy, and the row
  in the running DB). Tool Guard remains as the canonical example.
- Validated: typecheck + build green; fresh-DB boot shows `kravn-code-interpreter` (source native, enabled) +
  `tool-guard` (disabled), no hello-server. Existing DBs get the native plugin seeded on next restart.

## ✅ PASS 17 — Code interpreter is a first-class plugin + plugin file-workspace context (2026-06-29)
User direction: make the interpreter 100% a plugin with the same management as any plugin, and extend the plugin
system if needed (welcomed — future clients can write advanced plugins). Done (parts A+B; ZIP bundles = part C, next).
- **A) Native plugins are first-class mcp-server plugins.** native.ts is now a FACTORY (`nativePlugins(deps)`) that
  builds a real `McpServerPlugin` (with `server.listTools/callTool`) for the code interpreter, with the Pyodide
  executor injected (privileged in-code runtime a sandboxed user plugin can't have). PluginManager takes the native
  plugins in its constructor, keeps a `native` map, seeds+enables them, and `mcpPlugin`/`enabledMcpServers`/`serverCallTool`
  now resolve native ids → so they flow through the EXACT same pipeline as imported plugins: `syncPluginServers` →
  `plg_<id>` server + registry Tool rows → appear in the Tools screen, composable into virtual servers, executed via
  `registry.invokeTool` → upstream plugin shim → `serverCallTool` → native `server.callTool`. No more hardcoded tool
  or special-case in ChatService.
- **B) File-workspace context for tool calls (general capability).** SDK: `McpToolFile`, `McpCallContext {files,actor}`,
  optional 4th `ctx` arg on `McpServerHandlers.callTool`, and `McpToolResult.files`. Threaded `invokeTool(…, ctx)` →
  `upstream.callTool(…, ctx)` → (only the in-process plugin shim via `PluginClientLike.callToolCtx`; real MCP clients
  never get it) → `serverCallTool(…, ctx)` → `server.callTool(…, ctx)`. Chat passes the conversation's attachments as
  the workspace and persists any `result.files` as downloadable attachments (replacing the old runInterpreter bypass).
- **Chat**: auto-offers the interpreter's registry tools when the plugin is enabled (also composable into vservers);
  all tools (incl. interpreter) dispatch through `registry.invokeTool` with the file workspace; `persistToolFiles`
  saves output files + strips bytes before feeding the result back to the model.
- Validated: plugin-sdk + gateway typecheck + `pnpm build` green. **End-to-end smoke via the registry**: the
  interpreter appears as a registry tool under `plg_kravn-code-interpreter`, shows in the global Tools list, and
  `registry.invokeTool(toolId, {code}, actor, {files:[xlsx]})` completed the Excel (totals 6,10) and returned the
  output file — proving the file-ctx-in / files-out path through the normal plugin pipeline.
- **Adversarial review: 3 confirmed (2 refuted) — ALL FIXED + re-validated**: (F1) tool-result `files` were persisted
  as user attachments with no cap and from ANY upstream → now only honored from trusted in-process plugin tools
  (toolId `tl_plg_…`) with 10-file/15MB caps + shape validation; (native-delete) deleting a native plugin re-seeded it
  enabled → `remove()` now rejects native ids + the operator hides Delete for built-ins; (canRunCode) the run_python
  prompt hint used a generic "any tool" flag → now keyed to the interpreter's actual availability. Re-validated:
  trusted interpreter still returns files; remove(native) rejected.
- AGENTS.md principle #1 already codifies "tools are plugins"; this makes the interpreter actually obey it.

## ✅ PASS 18 — Deploy: Helm chart current + GitHub Actions publishing to the owner's GHCR (2026-06-29)
Goal: the MCP gateway installable on Worldsys's cluster from the USER's own registry (not Worldsys's org).
- **Helm chart (charts/kravn) updated**: added `role` (all|gateway|chat, default all), `publicUrl`, `clientUrl`; a
  generic `database` block (Postgres/MySQL/SQL Server via DATABASE_URL, supersedes the Postgres-only block, back-compat
  kept); bumped memory limit to 1280Mi (the Pyodide interpreter caps WASM at ~768MB) with a note to drop to 512Mi for
  role=gateway; default image → `ghcr.io/OWNER/kravn` (CI rewrites OWNER at package time). Still zero-override install
  (SQLite PVC + auto-gen secret). Validated: `helm lint` clean; `helm template` renders defaults + overrides
  (role=gateway, external mysql, ingress, 2 replicas, shared secret).
- **.github/workflows/release.yml**: on tag `v*.*.*` (or manual) → build the gateway image (root Dockerfile) and push
  image + Helm chart (OCI) to **ghcr.io/<repo-owner>** using the built-in GITHUB_TOKEN (no extra secrets). Uses
  `${GITHUB_REPOSITORY_OWNER,,}` so it publishes under the user's account by construction — never Worldsys's org.
- **.github/workflows/ci.yml**: push/PR → pnpm install + `pnpm build` + `pnpm typecheck` + `helm lint`.
- **Dockerfile**: added the native toolchain (python3/make/g++) to the build stage and (temporarily, then purged) to
  the runtime stage so better-sqlite3 always builds even if no prebuilt binary is fetched.
- NOT yet done by the user (manual, outward-facing — left for them): `git init` + create a GitHub repo under THEIR
  account + push + `git tag v0.1.0 && git push --tags` to trigger the release. Then on Worldsys:
  `helm install kravn oci://ghcr.io/<owner>/charts/kravn --version 0.1.0` (make the GHCR packages public or add an
  imagePullSecret). Docker build not locally verifiable here (no Docker in this env); the CI runs it.

## ✅ PASS 19 — DB portability & first-deploy fixes (v0.1.2–v0.1.8)
- SQLAlchemy-style `DATABASE_URL` schemes (`postgresql+psycopg://`, etc.) normalized; unknown scheme throws early.
- PG 15+/Azure: create the app schema only if genuinely missing (checks `information_schema.schemata` first,
  since `CREATE SCHEMA IF NOT EXISTS` needs CREATE-on-DB); documented the least-privilege grants.
- `value too long for varchar(64)`: registry composite ids bounded ≤64 w/ hash suffix; DB errors sanitized
  (`describeSyncError`); zod + maxlength form validation so the UI shows handled errors, not raw DB errors.
- Replaced a `KRAVN_MIGRATE` env with a `migrate` CLI subcommand + an automatic Helm pre-install/upgrade Job.

## ✅ PASS 20 — Local-auth hardening, SSO-only, EntraID admin, SAML fixes (v0.1.10–v0.1.13)
- Login rate-limit + progressive lockout; ability to disable local password login (SSO-only); designate an
  EntraID user as admin (`adminEmails`, promotes/creates on SSO login). 12-finding review fixed.
- SAML: `@fastify/formbody` for the POST binding (415 fix); real signature fix = `wantAuthnResponseSigned:false`
  keeping `wantAssertionsSigned:true` (EntraID signs the assertion, not the response).

## ✅ PASS 21 — OAuth 2.1 Authorization Server (v0.1.14–v0.1.15)
- Kravn is an OAuth AS so Claude connectors connect: DCR (RFC 7591), PKCE S256, atomic single-use auth codes +
  rotating hashed refresh tokens, consent screen with an anti-fixation binding cookie, `/.well-known/*`. Review
  fixed 7 findings. Consent-page-404 fixed (`/oauth` is an SPA route, not an API prefix).

## ✅ PASS 22 — Change user role + SharePoint native plugin (v0.1.16–v0.1.19)
- Change an existing user's role. SharePoint native mcp-server plugin (Microsoft Graph app-only): search /
  list-sites / list-documents / read-document with docx/pdf/xlsx text extraction; `region` for Sites.Selected;
  `secret:true` client secret encrypted at rest.

## ✅ PASS 23 — App-level security hardening + the SECURITY.md contract (v0.1.20–v0.1.21)
- White-box audit (product must be safe without Cloudflare): closed an editor→stdio **RCE** (admin-gate +
  sanitized child env), removed **JWT-in-URL** (logstream ticket + SSO handoff code + scope confinement),
  configurable `trustProxy`, OIDC SSRF guard, `email_verified` check, security headers, `/metrics` auth, CORS
  allowlist, 4xx passthrough, query-string stripped from logs. Re-audit fixed 3 more: **TOCTOU** in the handoff
  exchange (atomic `consume(jti)`) + logstream ticket, and a team-roster **IDOR**.
- **SECURITY.md** created: trust boundaries, invariants, control inventory, residual risk, per-change checklist,
  re-validation process, and the security change-log. Referenced from AGENTS.md §5 (revalidate on every change).

## ✅ PASS 24 — Per-team MCP + tool entitlements (v0.1.22–v0.1.23)
- Two levels of access per Team: which virtual servers (level 1, `allowed_teams`) and which of their tools
  (level 2, `team_server_tools`; empty = all). Enforced by narrowing `scope.tools` in `mcp.routes` + chat.
  `viewer` gained `mcp.invoke`; global `/mcp` catalog is admin-only; the raw tool-invoke playground is
  admin-only (both close per-team bypasses). Operator: per-team "MCP access" panel (+ tool-mode toggle fix).

## ✅ PASS 25 — Platform Administrator Team console gate (v0.1.24)
- Access to the whole control-plane requires role admin OR membership in the well-known "Platform Administrator
  Team" (seeded at setup, reconciled at boot, promote↔demote syncs it). Closes the hole where any authenticated
  MCP consumer could reach the admin web. Enforced in `authorize()` (one choke point). Operator shows a clear
  "no console access" screen for non-members. `/api/overview` gated (was a dashboard leak).

## ✅ PASS 26 — Jira + Confluence plugins, user ABM, SCIM 2.0 (v0.1.25–v0.1.27)
- Native **Jira** + **Confluence** plugins (Atlassian Cloud REST; shared `plugins/atlassian.ts` with one
  SSRF-hardened base-URL guard, Basic auth, `secret:true` token, redirect/size/timeout limits).
- **User ABM**: edit name/email/role/password + a `disabled` flag (migration 006). `login`/`authenticate`/
  `authenticateToken`/token-issuance (exchange, OAuth) reject disabled → deactivation cuts access live.
  Anti-lockout + email uniqueness. Operator Users edit modal.
- **SCIM 2.0** provisioning (`/scim/v2/*`, bearer token stored hashed): create/update/deactivate/delete from
  Entra, at a clamped non-admin role, never touching admins. Complements SAML (auth) with provisioning.
  Content-type `application/scim+json` accepted (Entra's 415 fix).

## ✅ PASS 27 — Caching: Anthropic prompt caching + registry read cache (v0.1.28)
- **Token/cost:** the chat runtime now adds `cache_control: {ephemeral}` to the Anthropic request — on the
  system prompt (Project instructions + docs) and the last tool schema — so repeated turns AND every tool-call
  loop iteration read the stable prefix at ~0.1× instead of full input price. OpenAI auto-caches (no change);
  Gemini 2.5 auto-caches. Validated by capturing the real outgoing request body (cache_control present on
  `system[0]` and the last tool).
- **Performance/DB:** `DownstreamMcp.buildScope()` (runs on every `tools/list`) now serves the four registry
  lists from a 10s in-memory snapshot instead of 4 full-table reads per call; invalidated immediately on plugin
  change. Filtering logic unchanged (regression-checked: tools/list returns the same VS-scoped tools).

## ✅ PASS 28 — License (BSL 1.1) + multi-replica prep with Dragonfly (v0.1.29)
- **License:** adopted **Business Source License 1.1** (© 2026 AddLayer) — source-available, free to self-host in
  production, blocks reselling Kravn as a competing hosted service, auto-converts to Apache-2.0 on 2030-07-01.
  `LICENSE` + `package.json` (`BUSL-1.1`) + README note. (Committed separately: `license:` commit.)
- **Cross-replica shared store** (`apps/gateway/src/cluster/shared-store.ts`): a tiny `SharedStore` (fixed-window
  `incr`/`peek` counter + TTL `get`/`set`/`take`/`del`) with two backends — `MemoryStore` (default, single-replica,
  keeps the bounded-map + no-wipe eviction hardening) and `RedisStore` (ioredis; atomic INCR+PEXPIRE+PTTL Lua;
  **degrades to an internal MemoryStore on outage** — never fail-open, never crash; event-driven `ready`/`degraded`
  gate so a sustained outage costs no per-call timeout). Opt-in via `KRAVN_REDIS_URL`; unset ⇒ memory (unchanged).
- **Wiring:** `LoginRateLimiter` is now async + store-backed + namespaced (`rl:login:*` vs `rl:oauth:*`), used by
  login/register + the public OAuth endpoints; OIDC in-flight login state (PKCE verifier + `state`) moved from a
  per-process Map to the store with an **atomic single-use** claim (`take()` = `GETDEL`).
- **Helm:** `redis.enabled` deploys **Dragonfly** (RESP-compatible, `docker.dragonflydb.io/dragonflydb/dragonfly`),
  ClusterIP-only, non-root, `--proactor_threads=1 --maxmemory=256mb`, and wires `KRAVN_REDIS_URL` to it; BYO external
  Redis/Valkey/Dragonfly via `redis.externalUrl`/`existingSecret` (with `enabled:false`).
- **Validated:** 38/38 store unit checks (memory + real Dragonfly incl. `GETDEL`, TTL, degrade); end-to-end **two-pod**
  HTTP test sharing one Dragonfly — a login lockout raised on pod A returns 429 on pod B (counter confirmed in
  Dragonfly with the right PTTL), fresh IP+email still 401 (no over-block), 0 spurious degrades. Full monorepo
  typecheck + build green. Found+fixed during validation: Dragonfly crash-loops unless `maxmemory ≥ threads×256MiB`
  (pinned threads); an initial-connect race that spuriously degraded (fixed with offline-queue + health gate); and
  the OIDC state double-use window (fixed with `take()`).

## ✅ PASS 29 — Hook Pipelines: compose plugin chains per lifecycle junction + trace (v0.1.30)
- **What:** turned the implicit "run all hook plugins by global priority" into a **first-class, composable
  pipeline** the admin cablea from the UI. For each MCP lifecycle junction (`onToolCall`, `onToolResult`,
  `onListTools`, `onResourceRead/Result`, `onPromptGet/Result`, `onResolveUser`) you set the **order** of the
  hook plugins and a **per-junction on/off** — the same plugin can sit in a different position (or be off) at
  each junction. Node-RED-style, but on the fixed MCP spine (no invalid/cyclic graphs).
- **Backend:** `pipeline_steps` table (migration 007) `hook_point → [plugin, position, enabled]`; `PipelineRepo`
  (list/replaceHook/ensureStep/deleteByPlugin); `PluginManager.enabledHooks()` now runs in DB per-hook order
  (falls back to global `priority` only before steps are seeded), gated by BOTH the global plugin switch and
  the per-junction step toggle; new `pipelineView()`, `setPipeline()` (validates the plugin implements the
  hook, dedupes, ≤200), and `trace()` (dry-run a junction's chain on a sample payload, capturing before/after
  + deny per step). Routes: `GET /api/pipeline` (settings.read), `PUT /api/pipeline/:hookPoint` +
  `POST /api/pipeline/:hookPoint/trace` (settings.write); `HOOK_LIFECYCLE` metadata shared via contracts.
- **Frontend:** operator **Pipelines** screen — scope tabs (Tools/Resources/Prompts/Auth), a card per junction
  with the ordered step cards (▲▼ reorder, per-junction toggle, "can deny" badge, "plugin off" hint), and a
  **trace panel** that shows the payload transform (before/after diff, changed/denied/error) end-to-end.
- **Validated:** 15/15 HTTP checks against a booted gateway — seeded `tool-guard` appears at its junctions;
  imported a 2nd hook plugin, reordered them, order persisted; **trace ran both in order and redacted
  BROU→XXXX**; a per-junction toggle-off skipped that step; an unknown plugin in a PUT was rejected (400).
  Full monorepo typecheck + operator vite build green.

## ✅ PASS 30 — Per-virtual-server pipeline overlays (v0.1.31)
- **What:** hook chains are now composed **per scope** — a mandatory **Global** base (runs for all traffic) +
  opt-in **per-virtual-server overlays** that run, in addition to global, only for calls routed through that VS.
  Answers "I want a plugin to do something for one virtual server but not another." Layered on purpose: a VS
  overlay can only ADD steps, never disable/bypass a global (compliance/security) step.
- **Threading:** `virtualServerId` now flows server-side from `buildScope` (the resolved VS) → `dispatch` →
  `invokeTool`/`readResourceFrom`/`getPromptFrom` → the hook context (also exposed to plugins as
  `ctx.virtualServerId`). Not caller-supplied.
- **Model:** `pipeline_steps.scope` ('global' | virtualServerId), migration 008 (rebuild PK to include scope,
  copying existing rows as 'global'). `enabledHooks(method, vsId)` = global chain (always) + VS overlay (opt-in),
  deduped. `pipelineView(scope)` shows a VS's own steps + inherited global (read-only) + available-to-add;
  `setPipeline(scope,…)` validates scope+hook (auth is global-only); `trace(scope,…)` dry-runs the effective
  chain. VS deletion clears its overlay.
- **Frontend:** the Pipelines screen gains a scope selector (Global | each virtual server); a VS view shows the
  inherited global steps read-only, an add-plugin picker, and per-step reorder/toggle/remove for the overlay.
- **Validated 19/19 HTTP:** a plugin disabled in Global but added to VS-A's overlay runs ONLY for VS-A (trace of
  VS-A includes it + tags output with the VS id; VS-B and Global do not); global base always runs; auth-as-VS and
  unknown-VS PUTs rejected (400). Full monorepo typecheck + operator vite build green.

## ✅ PASS 31 — Six built-in content hook plugins (v0.1.33)
- **What:** shipped 6 ready-to-compose hook plugins (disabled by default) so the Pipelines screen has real
  building blocks beyond Tool Guard:
  - **Secrets Redactor** — regex-detects private keys, AWS/GitHub/Slack/Stripe/Google keys, JWTs, bearer
    tokens, URL credentials (+ optional high-entropy) in results and replaces them before the model sees them.
  - **Content Safety Filter** — lexicon-based self-harm/violence/hate detection; redact or annotate results,
    and optionally block a tool CALL whose args are flagged. Honest caveat: pair with a classifier for prod.
  - **Deny List Filter** — block requests / redact results matching a phrase or `/regex/`.
  - **HTML → Markdown** — convert HTML results to Markdown (cleaner + fewer tokens).
  - **SafeHTML Sanitizer** — strip script/style/iframe/on*/js: URLs (or text-only). Defense-in-depth.
  - **TOON Encoder** — re-encode JSON results as TOON (per the official spec) for 30–70% token savings on
    uniform arrays; best placed last.
- **Architecture:** shipped as **native HOOK plugins** (in-code, dependency-free) rather than DB seeds — so
  they appear on existing installs too (seeds skip new ids on a non-empty DB), are re-seeded if removed, and
  stay clean/testable. Small manager change: `native` is now a `KravnPlugin` map; `pluginFor()` resolves a
  hook from native ∪ loaded; native hooks seed DISABLED (they change behaviour) while native mcp-servers keep
  auto-enable. Regexes written linear to avoid ReDoS on untrusted content; each hook is inside the pipeline's
  per-step try/catch.
- **Validated 17/17 HTTP:** all 6 appear as hook plugins (disabled) in Plugins + the pipeline; secrets
  redacted (JWT+AWS), self-harm redacted + violent request blocked, deny-list blocks+redacts, HTML→Markdown
  correct, SafeHTML strips script/onclick/javascript:, TOON tabular encoding. Gateway typecheck + build green.

## ✅ PASS 32 — Compliance plugins (injection/audit/PII) + marketplace Plugins UI (v0.1.34)
- **3 more native hook plugins** (disabled by default), turning Kravn from "gateway with plugins" toward
  "compliance gateway for AI":
  - **Prompt-Injection Guard** — detects indirect prompt injection in tool/resource/prompt results and
    redacts / annotates / fences it as untrusted data. The #1 MCP-specific risk.
  - **Audit / Compliance Logger** — tamper-evident hash-chained audit record per tool call (actor, VS, tool,
    clipped preview, timestamp) → Logs view. Durable store + SIEM export are a follow-up.
  - **PII Tokenizer** — emails/IPs/cards(Luhn)/phones → stable deterministic tokens (⟦EMAIL_ab12⟧) so the
    model reasons consistently without the real value. Reversible restore-to-user is a follow-up.
  - Now 9 built-in hook plugins total. Regexes reviewed for ReDoS (linear); each inside per-step try/catch.
  - Validated 11/11 (injection redact/annotate, PII tokenize + determinism + Luhn, audit hash-chain in Logs,
    all composable in the pipeline).
- **Marketplace Plugins screen** — the flat table becomes a card grid with a **search** box, **Type** filter
  (Hook / MCP Server), **Hook-point** filter (per junction), and a **Catalog / Installed** segment (Installed =
  enabled). Preserves config editor / import / delete. Design-system tokens (light/dark). Presentation-only.

## ✅ PASS 33 — Opt-in pipelines + per-VS pipeline inside the VS editor (v0.1.35)
- **Opt-in everywhere (UX fix):** the global pipeline no longer auto-lists every hook plugin (greyed) — it's
  now opt-in like a VS overlay. A junction shows ONLY the plugins you added, with an "+ Add plugin" picker;
  a plugin runs only where you add it (enabling it on the Plugins screen just makes it available). Removed the
  auto-seed + the legacy priority fallback from `enabledHooks`; `setPipeline` persists exactly the submitted
  chain at every scope. Migration 009 clears the old auto-seeded global rows once (per-VS overlays kept).
  Scales to many plugins (you see your chain, not a wall).
- **Per-VS pipeline in the VS editor:** extracted a reusable `PipelineEditor(scope)` component. The **Pipelines**
  menu now edits the **global** pipeline only; **virtual-server create/edit is a full page** (not a modal) that
  embeds `PipelineEditor` for that VS — you see the global hooks inherited (read-only, can't remove) and add
  hooks that run only for that VS. New routes `/virtual-servers/new` + `/virtual-servers/:id`.
- **Validated 7/7** (+ 6/6 opt-in): global empty by default; add/remove works; only-added runs; VS inherits
  global read-only + its overlay; trace shows global-then-overlay for the VS, global-only for another VS and
  for the global scope; global base always runs for a VS (can't be bypassed). Full monorepo typecheck + build
  green. Self-reviewed (safer simplification of already-reviewed threading/authz).

## ✅ PASS 34 — Decouple control plane vs data plane + rename (MCP Servers / MCP Endpoints) (v0.1.38)
- **Access decouple (the substantive change):** consuming a virtual server is now governed only by its access
  policy — public / authenticated / restricted→team-membership — via one shared `canConsumeVirtualServer()`
  (`mcp/vs-access.ts`). Dropped the platform-role axis (`allowedRoles`) and the implicit admin bypass from
  consumption: being a config-admin no longer auto-grants a restricted endpoint; an admin consumes it by being
  in one of its teams (control plane = configure Kravn; data plane = consume MCPs; now orthogonal, one identity
  can be both). Unified all THREE enforcement points (MCP endpoint, chat options, chat tool-resolution) — fixed
  a real inconsistency (MCP had an admin bypass, chat didn't). Strictly more restrictive. Removed the "Allowed
  roles" UI. Validated 6/6.
- **Naming:** upstream "Servers" → **MCP Servers** (what the gateway connects to); "Virtual server" →
  **MCP Endpoint** (what you publish to consumers). UI labels only — routes/DB/API identifiers unchanged.
- Full monorepo typecheck + build green.

## ✅ PASS 35 — DOCX → structured Markdown (mammoth) + shared HTML module (v0.1.40)
- **The change:** the shared document extractor (`chat/extract.ts::extractText` — used by SharePoint's
  `readDocument` AND chat uploads) now renders `.docx` as reduced **Markdown** (`mammoth.convertToHtml` →
  `htmlToMarkdown`) instead of flat `extractRawText`, keeping headings/lists/bold and — the point — **tables**.
  Fewer tokens than the source XML, more legible than flat text. HTML over the 128 KB cap falls back to plain text.
- **Reuse, done as a module (not a plugin dependency):** `htmlToMarkdown` + entity/tag guards were lifted from
  `native-hooks.ts` into `lib/html.ts`; the HTML→Markdown and SafeHTML hooks import it. Behaviour-preserving
  (helpers byte-identical). Added `<table>` → GFM-table conversion.
- **Adversarial review found + fixed 3 issues on this untrusted path:** (1) mammoth inlines images as base64
  `data:` URIs (token bomb + opaque payload to the model) → images dropped at conversion, and `data:`/`js:`/`vbs:`/
  >2 KB img srcs dropped in `htmlToMarkdown`; (2) **MEDIUM** — cell escaping was bypassable via HTML entities
  (`&#124;`→`|`, `&#10;`→newline, incl. multi-encoded) because the final `decodeEntities` ran after per-cell
  escaping → could inject phantom columns / break out into fake headings + prompt-injection. Fixed by rendering
  tables to a NUL placeholder restored AFTER the decode pass, with fix-point decode + tag-neutralise + pipe-escape
  per cell (final, holds at any encoding depth); (3) **LOW** — `imgSrc` `data:` filter bypassable via entity-encoded
  scheme → tests the fully-decoded src.
- **Validated:** real jszip-built `.docx` (tables/headings/bold, no base64 leak, no phantom columns at single/double/
  triple/hex encoding, no newline breakout), ReDoS bounded (≤~270 ms on 128 KB pathological input, >128 KB passes
  through), all 9 native hooks still load, SafeHTML still strips XSS. Full gateway typecheck + build green.

## ✅ PASS 36 — Clearer authorization errors on denied MCP endpoints (v0.1.41)
- **Problem:** a consumer denied a restricted MCP endpoint (not in an allowed team) saw a generic client-side
  "Authorization failed — check your credentials", even though Kravn returned a correct 403 with a clear body —
  because the 403 carried no structured signal to distinguish *forbidden* from *unauthenticated*.
- **Fix (`mcp.routes.ts`):** a `forbidden()` helper returns 403 + the **RFC 6750 `insufficient_scope`** challenge
  (`WWW-Authenticate: Bearer error="insufficient_scope", error_description="…"`) so spec-compliant clients render
  it as a permission problem, with an **actionable** message (endpoint slug + "ask an admin to grant your team
  access"). Genuine 401 keeps the RFC 9728 `resource_metadata` challenge (unchanged). Every team-denial is logged
  to the admin Logs view (`mcp.access.denied`: actor, teams, endpoint, required `allowedTeams`) for self-serve
  diagnosis.
- **Security:** the client response never leaks which teams are allowed (admin-log only); `error_description` is
  quoted-string-sanitised (a `a"b\c` slug can't inject/break the header); denial log fires post-auth into a
  bounded ring buffer. Self-reviewed (small authz-response change) + validated with a real Fastify `inject`
  integration test (403+insufficient_scope+log for an admin outside the team; 401 unchanged; header injection-safe).
  Full gateway build green.

## ✅ PASS 38 — Microsoft Teams plugin (Graph, app-only) + marketplace permission docs (v0.1.42)
- **New native plugin `teams.ts`** — Teams over MCP via Microsoft Graph app-only (client-credentials), modeled on
  the SharePoint plugin. 7 read-only tools: `teams_find_user` (name/email → id), `teams_find_chat` (the chat
  shared by two people), `teams_list_chats`, `teams_read_chat`, `teams_list_teams`, `teams_list_channels`,
  `teams_read_channel_messages`. The read tools take an ISO `since`/`until` window, so a question scoped to a
  period (e.g. "yesterday") works: find_user ×2 → find_chat → read_chat(since=…). Message HTML → the
  shared hardened `htmlToMarkdown` (fewer tokens). Registered in `native.ts`; auto-appears in Plugins + Tools.
- **Hardening** (built-in, then adversarially reviewed — no critical/high/medium): fixed Graph host (no SSRF),
  every id `encodeURIComponent`'d, nextLink followed only if on graph.microsoft.com, `redirect: 'error'`,
  per-request timeout, message + 60 KB output caps, `$search` query quote-sanitised. Review's 2 low/info notes
  fixed + back-ported to SharePoint: token cache key now includes a secret hash (no cross-config token reuse);
  transcript sort tolerates bad timestamps.
- **Marketplace permission docs:** new reusable `setup` manifest field (plugin-sdk schema + `PluginView` +
  `PluginsView` callout). Teams and SharePoint now show a "Setup & required permissions" box listing the exact
  read-only Graph Application permissions the credential needs.
- **Validated** with a mocked-Graph harness (2 suites, 40 checks): tool shape, correct URLs/encoding, find_user
  `$search` + `ConsistencyLevel`, find_chat member-matching, date-window early-stop, invalid-date error,
  secret-hash cache isolation, output caps, and the security invariant (malicious nextLink not followed, bearer
  token never leaves graph.microsoft.com). Full monorepo build green (contracts, plugin-sdk, gateway, operator).

## ✅ PASS 39 — Plugin detail modal + setup docs; example-name scrub (v0.1.43)
- **Detail modal:** clicking a plugin card in the marketplace opens a modal with its full description, meta
  (type/version/author/built-in), hook points, and a "Setup & required permissions" panel, plus a Configure
  button. The card body is a keyboard-accessible button; actions (Config/Enable/Delete) stay separate.
- **Setup docs:** the `setup` field for Teams and SharePoint is now a numbered Entra ID app-registration
  walkthrough (register → client/tenant id → client secret → add the read-only Graph Application permissions →
  grant admin consent), rendered in both the config and detail modals.
- **Privacy scrub:** an illustrative example in the Teams plugin descriptions/notes used real names; replaced
  with purely functional wording, and the git history was rewritten (`filter-branch`) to purge the string from
  the introducing commit's content + message. Affected tag moved to the scrubbed commit; force-pushed.
- Gateway typecheck + operator build green; no names remain in source.

## ✅ PASS 40 — Fix: New MCP endpoint creation broken (v0.1.44)
- **Bug:** clicking "New MCP endpoint" showed "MCP endpoint not found". `VirtualServerEditView` derived
  `isNew` from `route.params.id === 'new'`, but the create route (`virtual-servers/new`, name
  `virtual-server-new`) is a static path with **no `:id` param** → `route.params.id` is `undefined` →
  `isNew` was always `false` → the view tried to load an endpoint with id `"undefined"` and failed.
- **Fix:** `isNew = route.name === 'virtual-server-new' || !route.params.id`. Verified no other view has the
  same `=== 'new'` param antipattern. Operator build green.

## ✅ PASS 41 — Rename virtual-server → MCP endpoint across the codebase (v0.1.45)
- **Why:** v0.1.38 renamed only the UI labels; identifiers (routes, API, type, permissions) still said
  virtual-server. Aligned the whole internal surface to "MCP endpoint".
- **Renamed:** frontend routes/views (`/virtual-servers`→`/mcp-endpoints`, `McpEndpointsView`,
  `McpEndpointEditView`), `VirtualServer`→`McpEndpoint` type, admin API `/api/virtual-servers`→
  `/api/mcp-endpoints`, `vs-access.ts`→`endpoint-access.ts` (+ `canConsumeMcpEndpoint`), RBAC
  `virtualservers.*`→`endpoints.*`.
- **Preserved (intentional):** DB table `virtual_servers` + column `virtual_server_id` (never user-visible;
  renaming needs a 4-engine migration for no value). RBAC is a static role→permission map (runtime-derived,
  not persisted) → no data migration.
- **Back-compat:** consumer URL alias — canonical `/endpoints/:slug/mcp` + old `/servers/:slug/mcp` kept
  (one shared handler); operator redirects for old `/virtual-servers*` admin URLs.
- **Method + gotcha:** per-form sed (Pascal/camel/hyphen/permission) preserving snake_case. `grep -I` skipped
  two files as "binary" (`registry.service.ts`, `native-hooks.ts`) → caught + fixed via a force-text (`-a`)
  rescan. Validated: full monorepo build green (6 projects); both consumer routes hit one handler (Fastify
  inject → 404 "No such MCP endpoint"); permissions consistent; no stray identifier except the redirect routes.

## ✅ PASS 42 — Gold-raven brand unification (v0.1.46)
- The `RavenLogo` mark in the **operator** and **client** apps now uses `color: var(--accent)` (gold #c9892c)
  instead of `var(--brand)` (dark/white by theme) — the raven is gold everywhere it appears (nav, login,
  setup, chat), matching the marketing site.
- **Favicons unified**: operator `favicon.svg` + `favicon-96x96.png` + `favicon.ico` and client `favicon.svg`
  are now the gold-raven-on-dark-tile (regenerated the PNG/ICO from the SVG via `@resvg/resvg-js` +
  `png-to-ico`, throwaway tools). Browser tab icon is consistent across the site and both apps.
- Operator + client builds green. Visual only.

## ✅ PASS 43 — Fix startup duplicate-key race on catalog sync (v0.1.47)
- **Symptom:** on boot, PG logged `duplicate key ... tools_pkey (23505)` for an enabled plugin server's tools
  (Jira: jira_search, jira_get_issue, …) → "skipped a catalog item that could not be stored" (non-fatal).
- **Root cause:** `services.ts` fires `syncPluginServers()` (L134) and `syncAll()` (L157) **un-awaited** at
  startup; both `connectAndSync` the same enabled server, so two `syncCatalog()` run concurrently. `syncCatalog`
  does `deleteToolsByServer` then per-item INSERT — **not atomic** — so the runs interleave and the second
  INSERT collides. (Only Jira: it's the only enabled/configured plugin server; SharePoint/Teams sit disabled.)
- **Fix:** per-server serialization lock (`syncLocks` map) wrapping `syncCatalog` → `doSyncCatalog`; same-server
  runs chain, different servers stay parallel, a failed run doesn't wedge the chain, map self-cleans.
- **Validated** on the real method (5/5: serialized same-server / parallel diff-server / no leak / error not
  wedged). Gateway typecheck green.

## ✅ PASS 44 — Immutable, SIEM-exportable audit trail + admin config-change auditing (v0.1.49)
- **Tier-1 compliance** (first item from the bank-readiness gap list). New `audit_log` table (migration 010):
  **append-only + hash-chained** (`hash = sha256(prev_hash + canonical content)`). `AuditLogRepo` exposes
  only append/read (no update/delete) so the app can't rewrite history.
- **`AuditService`**: serialized `record()` (chain consistency), durable persist, and **off-box export per
  event** — a structured stdout line (`audit:true`, k8s→SIEM shipping) + optional **SSRF-guarded SIEM
  webhook** (`assertUrlAllowed` + `redirect:'error'` + timeout). Secrets deep-redacted (key-matched) + values
  capped before store/export. `verify()` recomputes the chain and reports the first break.
- **Admin config-change audit**: a global `onResponse` hook records every mutating, authenticated
  control-plane `/api/*` call (who/what/when/outcome/IP); data-plane chat + auth-token churn excluded.
- **Read/verify API** (`GET /api/audit`, `POST /api/audit/verify`) gated by a new `audit.read` permission
  (admin-only; grantable to a dedicated auditor role for SoD). New `observability.auditWebhookUrl` setting.
- **Validated** end-to-end on real sqlite (10/10): persistence, genesis→chain linkage, redaction of
  clientSecret/password, per-event stdout export, `verify()` ok on a valid chain, and `verify()` DETECTING a
  direct-DB tamper. Full monorepo build green.
- **Documented limits:** per-replica chain (off-box SIEM export is the cross-replica tamper-proofing);
  unbounded growth by design (retention managed at the DB/SIEM layer).

## ✅ PASS 45 — External key management (KMS/HSM) for at-rest encryption (v0.1.50)
- **Tier-1 compliance #3** (key custody). At-rest secret encryption can now use an external KMS/HSM via
  **envelope encryption** instead of only the bootstrap secret. Default behavior is unchanged.
- **`Encryptor`** refactored to a key-set (active + read fallbacks), dispatched by ciphertext prefix:
  `enc:v1:` (bootstrap-secret key, byte-compatible with all existing data) and `enc:v2:` (KMS-wrapped DEK).
  encrypt/decrypt stay **synchronous** — no call-site changes.
- **`KeyManager`** (boot, async): default mode = key from `KRAVN_SECRET`; KMS mode generates a random DEK,
  has the KMS **wrap** it, persists ONLY the wrapped DEK (migration 011 `app_keyring`), unwraps once into
  memory. Providers: **HashiCorp Vault Transit** + **Azure Key Vault** (wrapKey RSA-OAEP-256, Entra
  client-credentials) — REST, `redirect:'error'` + timeout + capped response.
- **Backward-compatible + fail-closed:** existing `enc:v1:` secrets keep decrypting (bootstrap key retained
  as read fallback; lazy upgrade to `enc:v2:` on next save — no bulk re-encryption). A configured-but-broken
  KMS fails the boot (never silently unprotected). Provider swap rejected; multi-replica first-boot race
  converges on one DEK. DEK never persisted/logged in plaintext; `unwrapKey` asserts 32 bytes.
- **Validated** on real sqlite + a mock Vault (16/16): env path byte-unchanged, `enc:v1:` reads under KMS,
  `enc:v2:` round-trip, DEK survives restart, keyring holds only the wrapped DEK, tamper rejected. Full
  monorepo build green. Config + limits in `KEY_MANAGEMENT.md`.
- **Deferred (documented):** KEK/DEK rotation + bulk re-key command; JWT signing still on the bootstrap
  secret; AWS/GCP KMS providers (same interface).

## ✅ PASS 46 — Integrations catalog (95 curated public MCP servers) (v0.1.51)
- **Breadth of integrations.** Kravn is a registry/gateway, so most requested integrations are **existing
  remote MCP servers**, not code to write. Added `MCP_SERVER_CATALOG` in `@kravn/contracts` (offline data,
  shared by gateway + operator, like `LLM_MODEL_CATALOG`): 95 curated servers with name, category,
  description, url, transport (derived), auth class (`open`/`apikey`/`oauth`), provider, tags. Sourced/
  adapted from the public mcp-context-forge catalog.
- **Operator UI:** a **Catalog** tab in `ServersView.vue` (Installed | Catalog segmented) — search +
  category filter + cards with an auth badge; **Add** prefills the existing SSRF-guarded create modal
  (name/description/transport/url/authType), so the admin only supplies a credential. `open`/`apikey`
  connect today; `oauth` catalogued pending upstream-OAuth (Phase 2).
- **Validated** on the compiled catalog (95 entries, 42 categories, all https, no dup ids/urls, valid
  auth/transport, no incomplete rows). Full monorepo build green. Website (what-is-kravn + plugins) updated.
- **Not in the reference catalog (flagged for manual add):** Odoo, Zoho, ReadAi, BlueDot.

## ✅ PASS 47 — Upstream OAuth 2.1 client (connect OAuth-protected MCP servers) (v0.1.53)
- **Unlocks the catalog's OAuth servers.** Kravn now connects to remote MCP servers that require OAuth 2.1
  (Notion/Linear/Stripe/…) as an OAuth **client**. Protocol correctness (metadata discovery, DCR, PKCE,
  exchange, refresh) is delegated to the MCP SDK's auth toolkit; Kravn owns storage + CSRF anchor + crypto.
- **New:** `AUTH_TYPES += 'oauth'`; migration 012 (`server_oauth` config+tokens, `server_oauth_pending`
  state+verifier); `ServerOAuthRepo` (atomic single-use `takePending`); `UpstreamOAuthService`
  (startAuthorization / completeAuthorization / accessTokenFor+refresh / forget); `connectAndSync` resolves
  an OAuth token for `authType==='oauth'`; `POST /api/servers/:id/oauth/authorize` (gated) +
  public state-validated `GET /oauth/upstream/callback`; operator **Connect** button + catalog wiring.
- **Security:** callback trust anchor is a single-use, expiring, server-bound `state` (no session); reflected
  values HTML-escaped, no inline script (CSP-safe); access/refresh tokens + PKCE verifier + client secret
  encrypted at rest; SSRF-guarded discovery; `servers.write`-gated; tokens never in an API response; RFC 8707
  `resource` binds the token audience.
- **Validated** end-to-end against a mock AS + mock MCP server (14/14): discovery, DCR, PKCE-S256 verified,
  encrypted storage, single-use state (replay rejected), automatic refresh. Full monorepo build green.
  Adversarially reviewed.

## ✅ PASS 48 — Unified integrations Catalog (native + remote in one place) (v0.1.54)
- **UX unification.** Users don't care native vs remote — they want to find, install, use. The **Catalog**
  tab in `ServersView` now lists **both** the native `mcp-server` plugins (Jira/Teams/SharePoint/Confluence,
  tagged "Built-in") and the 104 remote catalog servers, with search + category filter (native under an
  "Integrations (built-in)" category).
- **Detail modal + routed CTA.** Clicking a card opens a detail view (description, how it connects, endpoint/
  tags for remote, setup notes for native). Remote → Add/Connect; native → Enable/Disable + Configure.
- **Shared config modal.** Extracted the schema-driven plugin config form from `PluginsView` into
  `components/PluginConfigModal.vue`, reused by both the Catalog (native config) and the Plugins page.
- **Plugins page → hooks only.** `PluginsView` filters to `type==='hook'` (governance); the built-in
  integrations moved to the Catalog. Native-plugin listing in the Catalog is guarded by `settings.read`.
- No backend/security change — reuses the existing gated `/api/plugins` + `/api/servers`. Full monorepo
  build green; SFC template balance verified. (Blind UI change — recommend a visual pass after deploy.)

## ✅ PASS 49 — Guided product tour (first-run onboarding) (v0.1.55)
- **Discoverability.** The Catalog was easy to miss, so a first-run guided tour now introduces the console
  and reinforces the Catalog as the place to start. `components/TourModal.vue` — a centered, self-contained
  stepper (no fragile element anchoring), 7 steps (welcome → Catalog ⭐ → endpoints → teams → hooks →
  settings → done), with an **Open the Catalog** CTA that routes to `/servers`.
- **First-run + relaunch.** Auto-opens once per browser (`localStorage kravn.tour.v1.seen`); a **Take a tour**
  button in the sidebar footer relaunches it anytime. Mounted in `AppShell`. Theme-aware.
- Pure UI, no backend change. Operator build green.

## ✅ PASS 50 — Interactive tour (driver.js) + alphabetical Catalog (v0.1.56)
- **Interactive tour.** Replaced the centered card tour with an element-anchored **driver.js** tour
  (`lib/tour.ts`) that spotlights the real sidebar controls (`data-tour="…"` on the nav) with a popover per
  step, reinforces the Catalog ⭐, and routes to `/servers` on finish. Steps whose element isn't visible
  (permission-limited users) are dropped so it works for everyone. First-run once (localStorage) +
  relaunchable from **Take a tour**. CSP-safe (bundled JS; inline positioning styles allowed by
  `style-src 'unsafe-inline'`). Added `driver.js@^1.6` to the operator.
- **Catalog alphabetical.** `catalogItems` is sorted by name (`localeCompare`, case-insensitive).
- Operator build green.

## ✅ PASS 51 — Catalog setup guidance per integration (v0.1.57)
- **Self-service config.** The catalog detail view now shows a **Getting set up** section: what the
  integration needs and **how to get the credential/token**. Two layers: `CATALOG_SETUP` in
  `@kravn/contracts` (24 curated provider guides — GitHub, Stripe, HubSpot, Google, Apify, Mercado Pago… —
  with `setup` steps + optional `docsUrl`, keyed by catalog id, validated against real ids) plus an
  always-accurate `authGuidance()` fallback derived from the auth class (open / apikey / oauth) so every one
  of the 104 has useful guidance. A "Provider docs ↗" link opens where present.
- Operator + contracts build green.

## ✅ PASS 52 — Upstream OAuth for providers without DCR + multi-page interactive tour (v0.1.58)
- **OAuth without Dynamic Client Registration (the GitHub blocker).** `startAuthorization` now resolves a
  client in priority order: operator-supplied `manualClient` → stored client → DCR; if the AS can't
  auto-register and none supplied, it throws `OAuthClientRequiredError` (carries the redirect URL). Also
  wraps `registerClient` so a DCR *failure* falls into the same path. The authorize route accepts
  `{ clientId, clientSecret }` and maps the error to `oauth_needs_client`; the operator catches that code and
  opens a modal showing the redirect URL to register + fields for Client ID/secret, then retries. Manual
  client (incl. secret) is stored encrypted like everything else. Validated on real sqlite + a no-DCR mock
  AS (8/8): correct error without a client, manual-client auth URL, encrypted storage, full code exchange +
  token. DCR-supporting path unchanged.
- **Interactive tour drives the app.** Rebuilt `lib/tour.ts` so the tour navigates to `/servers`, clicks the
  Catalog tab, and spotlights the real search/grid before the nav-anchored steps — fixing the earlier
  "Open the Catalog didn't open the Catalog". Added `data-tour` anchors to the Catalog tab/search/grid.
- Full monorepo build green.

## ✅ PASS 53 — Full manual OAuth config parity (v0.1.59)
- **Manual endpoints + scopes.** `startAuthorization(server, redirectUri, cfg)` now accepts `UpstreamOAuthInput`
  (issuer, authorizationUrl, tokenUrl, scope, clientId, clientSecret). Priority: explicit endpoints → issuer
  discovery → protected-resource auto-discovery. When the MCP server advertises no metadata (e.g. GitHub),
  discovery fails cleanly into `OAuthClientRequiredError` and the UI collects the full config. All operator
  endpoints are SSRF-guarded; client secret stored encrypted.
- **UI:** the Connect dialog gained Authorization URL, Token URL and Scopes fields (blank = auto-discover),
  alongside Client ID/Secret and the redirect URL to register — parity with a dedicated OAuth form.
- **Validated** on real sqlite + mocks: no-DCR fallback (8/8, v0.1.58) and undiscoverable + manual-endpoints
  (5/5) — correct error without config, manual auth URL/scope/PKCE, exchange via the manual token endpoint.

## ✅ PASS 54 — Native Odoo plugin (CRM & ERP over JSON-RPC) (v0.1.60)
- **Works with any Odoo hosting** (Odoo Online, Odoo.sh, self-hosted) — all expose the same JSON-RPC external
  API (`/jsonrpc` → `common.authenticate` → `object.execute_kw`), so one plugin covers them. No XML-RPC dep
  (fetch only). `apps/gateway/src/plugins/odoo.ts`, registered in `native.ts`.
- **13 tools:** 6 generic (`odoo_list_models`, `odoo_fields`, `odoo_search_read`, `odoo_create`,
  `odoo_write`, `odoo_unlink` — full CRUD over ANY model) + 7 domain shortcuts (crm.lead, res.partner,
  sale.order, account.move, product.product, project.task, hr.employee). Config: url/db/username/apiKey
  (secret, encrypted). uid cached by config fingerprint; URL normalized (http(s), blocks loopback/link-local/
  IPv6 literal); requests `redirect:'error'` + 30s timeout + 10 MB cap.
- **Validated structurally** (13 unique well-formed tools, secret apiKey, setup text, graceful errors:
  unconfigured / localhost blocked / unknown tool). Full runtime against a live Odoo not exercised here (no
  instance) — verify on deploy. Gateway build green.

## ✅ PASS 55 — Multi-page navigating tour + per-page tours (v0.1.61)
- **The navigation fix.** Rebuilt `lib/tour.ts` around a controlled runner: overriding driver.js `onNextClick`/
  `onPrevClick`, each advance does `router.push(step.route)` → `waitFor(step.element)` → `moveTo(i)`, so the
  page actually changes and the target is mounted before it's spotlighted (the previous version highlighted
  stale/absent elements). Overview walks every page with richer copy (MCP servers, catalog, tools, resources,
  prompts + creating a custom one, endpoints, teams, governance, settings).
- **Per-page tours.** `startTour(router, path)` runs a page-scoped plan when one exists (`/servers`,
  `/prompts`) else the overview; the sidebar button passes the current route. Added `data-tour` anchors
  (nav tools/resources/prompts, prompt-new). Operator build green.

### Deferred to later phases (intentional, not missing)
Native **Zoho CRM** plugin (requested) — Zoho REST API over OAuth 2.0 (self-client/refresh token) · ZIP plugin bundles (manifest+entry+assets) — part C of the plugin extension, designed not built ·
**multi-replica**: rate-limit + OIDC login state are now cross-replica (Dragonfly); remaining follow-ups are the
per-pod **log ring buffer** (durable shared event store) + the last-admin lock (in-process mutex) ·
Anthropic conversation-history caching (system+tools done) ·
per-team entitlements for **resources/prompts** (tools done) · SCIM **Groups**→teams sync (Users done) ·
gRPC-to-MCP reflection · OpenTelemetry export · resources/prompts test playground (tools playground is done) ·
live smoke against real pg/mysql/mssql servers · project-document RAG/embeddings · agents/knowledge-bases port ·
Gemini/Anthropic tool-calling (currently OpenAI-family only) · interpreter pandas/numpy + WASM cap ·
attachment image/vision · object-storage for attachment bytes (currently base64 in DB).
