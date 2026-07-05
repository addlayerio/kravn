# Changelog

All notable changes to **Kravn** — the self-hostable, compliance-focused MCP gateway, registry and proxy.

This file is written in plain, benefit-first language on purpose: each entry says *what you can now do*,
so it doubles as source material for release notes and announcements. For the deep technical/security
rationale behind each change, see [SECURITY.md](SECURITY.md).

- 📣 = worth announcing (a capability users care about)
- 🔒 = security · ⚡ = performance · 🧩 = integration/plugin · 🐛 = fix

The format is based on [Keep a Changelog](https://keepachangelog.com/). Versions match the Helm chart
`appVersion` and the `vX.Y.Z` git tags.

## [Unreleased]

- 📣 **Public integrations gallery on the website.** kravn.ai now shows every integration Kravn can connect
  — built-in connectors + the full catalog of public MCP servers — with logos, search and category filter,
  on the landing page and a dedicated `/integrations` page. It's generated from the same catalog the product
  ships, so it's always current.
- 📣 **Tools, Resources and Prompts are now grouped by their origin server too.** The same server grouping
  from the endpoint composer now applies to the browse pages — each list is collapsible per server (with its
  logo) and has a search box, so the origin of every tool/resource/prompt is obvious even with hundreds of
  them.
- 🐛 **Mercado Libre shows its real logo** (the Mercado Pago handshake in MercadoLibre yellow) instead of a
  monogram.

## [0.1.65] — 2026-07-05

- 📣 **Pick tools by server, not from an endless checkbox wall.** Composing an MCP endpoint now groups
  every tool, resource and prompt under its **origin server** (with that server's logo), collapsed by
  default. Search across all of them, tick a whole server at once, filter to “only selected”, and see a
  running “N selected · M servers” summary — so you always know what you're exposing even with hundreds of
  tools. (Same grouping will extend to the Tools/Resources/Prompts pages next.)
- 📣 **Every integration now has its logo.** The catalog, detail view and your installed servers show each
  product's brand icon, so you can tell what's what at a glance instead of reading names — integrations
  without a known logo get a clean coloured monogram. Logos ship inside the app (no external image calls).
- 🧩 **Bluedot added to the catalog.** Connect Bluedot (AI meeting notetaker) with one-click OAuth to reach
  your meeting transcripts, recordings and metadata.
- 🐛 **Fixed: refreshing MCP Endpoints (or any deep page) no longer 404s.** Pressing F5 / opening a direct
  link to `/mcp-endpoints` (and similar pages) now loads correctly instead of returning a "Not found" error.

## [0.1.64] — 2026-07-05

- 📣 **Live updates instead of polling.** The console now reflects changes in real time over Server-Sent
  Events — no more constant refresh/flicker on the MCP Servers page from timer-based polling. When a server
  connects, syncs, or a plugin toggles, the list updates the moment it happens. (This is now the standard
  across the app for live updates.)
- 🐛 **No "Connect" button once a server is Online** — it only shows when the server actually needs
  connecting.

## [0.1.63] — 2026-07-05

- 🐛 **OAuth token exchange, hardened for real providers.** Kravn now performs the token exchange/refresh
  itself instead of relying on the SDK helper — it accepts both JSON and GitHub's form-encoded token
  responses, and **surfaces the provider's real error** (e.g. "the code is incorrect or expired") instead of a
  cryptic "access_token: expected string, received undefined". This fixes GitHub and makes any OAuth failure
  legible.
- 📣 **Choose how the client secret is sent** (from reviewing other providers). New **Client authentication**
  option on OAuth servers — POST body (default, GitHub) or **Basic auth header** (required by Notion) — so
  providers with different token-endpoint conventions all work.

## [0.1.62] — 2026-07-05

- 🐛 **GitHub (and similar) OAuth now completes.** The token exchange failed with "access_token: expected
  string, received undefined" because GitHub returns a form-encoded token response by default — Kravn now
  requests JSON (`Accept: application/json`) on the token/registration calls, so the exchange succeeds.
- 📣 **OAuth config is now saved and editable — no more re-typing on every retry.** Configure an OAuth
  server's Client ID/Secret, Authorization URL, Token URL and Scopes right in the server's **Edit** form
  (with the redirect URL to register), Save, then Connect. If a Connect fails, your config is kept — go back
  to **Edit**, adjust, and Connect again. The secret is stored encrypted and never shown back.

## [0.1.61] — 2026-07-05

- 📣 **The tour now changes pages as it goes** — it navigates to each section and waits for it to load before
  spotlighting, so the highlight always lands on what's on screen (the earlier version spotlighted the wrong
  spot). It's also more complete: it explains MCP servers, the Catalog, tools, resources, prompts (incl.
  creating a custom one), endpoints, access control, governance and settings.
- **Per-page tours.** Click **Take a tour** on a specific page (e.g. MCP Servers or Prompts) and you get a
  focused tour of just that page; from the Dashboard you get the full overview.

## [0.1.60] — 2026-07-05

- 📣 🧩 **Odoo integration (built-in).** A new native Odoo plugin talks to your Odoo (CRM & ERP) over its
  JSON-RPC API — **works with Odoo Online, Odoo.sh and self-hosted**. It exposes generic read/create/update/
  delete over *any* Odoo model, plus ready-made search for leads/opportunities, contacts, sales orders,
  invoices, products, project tasks and employees. Configure it with your Odoo URL, database, username and
  API key; enable it from the Catalog. The user's Odoo access rights govern what it can do.

## [0.1.59] — 2026-07-05

- 📣 **Full manual OAuth config for any provider.** When a provider can't be auto-configured (no metadata,
  like GitHub), the Connect dialog now lets you set everything by hand — **Authorization URL, Token URL,
  Scopes**, Client ID and Secret — with the redirect URL to register shown. Leave the URLs blank and Kravn
  still auto-discovers for providers that support it. This brings connecting an OAuth MCP server to full
  parity with a dedicated OAuth form.

## [0.1.58] — 2026-07-05

- 📣 🔒 **Connect OAuth providers that need a registered app (e.g. GitHub).** Some providers don't support
  automatic app registration. Now when you Connect one, Kravn shows the exact **redirect URL** to register at
  the provider and asks for the **Client ID (and secret)** — then completes the sign-in. Providers that do
  support auto-registration are unchanged (just click Connect). Client credentials are stored encrypted.
- **The tour now drives the app.** Instead of just describing things, it navigates to MCP Servers, **opens
  the Catalog for you**, and spotlights the real controls step by step before covering endpoints, access,
  governance and settings.

## [0.1.57] — 2026-07-05

- 📣 **Catalog cards now tell you how to set each integration up.** Open a catalog integration and the detail
  view explains what you need and **how to get the credential** — e.g. GitHub (authorize via Connect, choose
  repos), HubSpot (create a Private App token with the right scopes), Stripe (a restricted API key), Google
  (an API key in Cloud Console), and more — plus a link to the provider's docs. Integrations without a
  specific guide still get accurate guidance based on how they authenticate (no-auth / API key / OAuth).

## [0.1.56] — 2026-07-05

- 📣 **The product tour is now interactive.** Instead of a static card, the tour **spotlights the real
  controls** in the sidebar and walks you through them one by one — highlighting the Catalog, endpoints,
  access control, governance and settings — then drops you in the Catalog to get started. Relaunch it any
  time from **Take a tour**.
- **Catalog sorted alphabetically** so integrations are easy to scan.

## [0.1.55] — 2026-07-05

- 📣 **Guided product tour.** A friendly first-run walkthrough now introduces the console — what each area
  does, from connecting integrations to publishing endpoints, governance and settings — and points you
  straight to the Catalog to get started. It runs once, and you can relaunch it any time from **Take a tour**
  in the sidebar.

## [0.1.54] — 2026-07-05

- 📣 **One place for every integration.** The **Catalog** (MCP Servers → Catalog) now shows *all* integrations
  together — the built-in ones (Jira, Teams, SharePoint, Confluence) alongside the 104 remote MCP servers — so
  you just find what you want and install it, without caring whether it's built-in or remote. Click any card
  for a **detail view** (what it does, how it connects, setup) and install/connect right there.
- **Plugins is now focused on governance hooks** (secret/PII redaction, prompt-injection guard, audit…). The
  built-in integrations moved to the Catalog; any future non-hook plugin will live there too.

## [0.1.53] — 2026-07-05

- 📣 🔒 **Connect OAuth 2.1 MCP servers in one click.** Kravn can now sign in to remote MCP servers that
  require OAuth 2.1 — Notion, Linear, Stripe, Sentry, Supabase, Vercel and the rest of the catalog's OAuth
  entries. Pick the server, click **Connect**, sign in with the provider, and Kravn is authorized. It handles
  the whole flow for you (endpoint discovery, dynamic client registration, PKCE) and **stores the tokens
  encrypted, refreshing them automatically**. This unlocks the majority of the integrations catalog.

## [0.1.52] — 2026-07-05

- 🧩 **More catalog integrations.** Added 9 general-purpose servers to the integrations catalog — GitHub,
  Atlassian, Stack Overflow, Buildkite, Telnyx, Microsoft Learn, Power BI, Microsoft Foundry and Javadocs —
  bringing it to 104.
- **Sharper positioning.** Clarified on the site that Kravn is a *general-purpose* MCP gateway for any
  company; its compliance-grade governance is what makes it safe for a regulated bank to run — not a niche
  compliance tool.

## [0.1.51] — 2026-07-05

- 📣 🧩 **Integrations catalog — connect 95+ MCP servers in a click.** A new **Catalog** tab on the MCP
  Servers page lets you browse a curated library of public MCP servers (Notion, Linear, Sentry, Stripe,
  Supabase, Vercel, Hugging Face, Google, Attio, Semgrep, and dozens more across project management,
  payments, CRM, databases, observability, docs and search), filter by category, and add one to your
  registry with the connection prefilled — no hand-typing URLs. Servers with no auth or an API key connect
  immediately; OAuth 2.1 servers are catalogued, with upstream sign-in landing next.

## [0.1.50] — 2026-07-05

- 📣 🔒 **Bring your own key — encrypt secrets with your KMS/HSM.** Kravn can now protect secrets at rest
  (plugin credentials, SSO/LLM config, upstream auth) with a key held in your **HashiCorp Vault** or **Azure
  Key Vault**, instead of only the local secret. Your master key never leaves the KMS/HSM (envelope
  encryption): Kravn only unwraps a data key in memory at boot, and your KMS logs every use — so you keep
  key custody, rotation and revocation.
- **Safe to adopt on a running install.** Turning on a KMS doesn't require re-encrypting anything or any
  downtime: existing secrets keep decrypting, and new/edited secrets are written under the KMS key. If a KMS
  is configured but unreachable, the gateway fails to start rather than silently running unprotected.
- Configure with `KRAVN_KMS_PROVIDER=vault|azure` (see [KEY_MANAGEMENT.md](KEY_MANAGEMENT.md)). Default
  behavior is unchanged when unset.

## [0.1.49] — 2026-07-05

- 📣 🔒 **Connect Kravn to your SIEM — immutable, tamper-evident audit trail.** Every event and every
  administrative change is written to an append-only, hash-chained log (each record signed off the previous
  one, so tampering is detectable) and streamed off-box in real time: a structured line to stdout for your
  log collector, plus an optional POST to a SIEM webhook (Splunk HEC or generic). Point it at Splunk, Elastic,
  Sentinel, etc.
- 📣 **Administrative change auditing.** Who changed what, when, from which IP, and whether it succeeded —
  every configuration change through the admin API is recorded automatically. Secrets in request bodies are
  redacted before anything is stored or exported.
- **New `audit.read` permission + auditor role.** Grant read/verify access to the audit trail to a dedicated
  auditor without giving them admin — segregation of duties out of the box. New `GET /api/audit` and a
  `verify` endpoint that recomputes the chain and reports the first break.

## [0.1.48] — 2026-07-05

- 🐛 **Cleaner logs.** Health/readiness probes (`/healthz`, `/readyz`) and metrics scrapes no longer flood
  stdout on every check, so real activity is easy to see.

## [0.1.47] — 2026-07-04

- 🐛 **No more noisy `duplicate key` warnings at startup.** Catalog syncs are now serialized per server, so a
  configured plugin (e.g. Jira) no longer races itself while loading. No data was ever affected.

## [0.1.46] — 2026-07-04

- **Consistent branding.** The gold raven now appears everywhere — admin console, end-user client, and browser
  favicons.

## [0.1.45] — 2026-07-04

- **Renamed "virtual servers" to "MCP Endpoints"** across the whole product for clearer wording. Existing
  connected clients keep working — the old consumer URLs still resolve as aliases.

## [0.1.44] — 2026-07-04

- 🐛 Fixed a "not found" error when creating a new MCP endpoint from the console.

## [0.1.43] — 2026-07-04

- 🧩 **Guided plugin setup.** Each plugin in the marketplace now opens a detail view with step-by-step
  configuration docs (including Entra ID / App Registration setup), so connecting an integration is
  self-service.

## [0.1.42] — 2026-07-04

- 📣 🧩 **Microsoft Teams integration.** Expose Teams chats and channels to your AI as governed MCP tools —
  find a user, find a chat, and read messages filtered by date range. App-only Microsoft Graph; the required
  permissions are documented in the marketplace.

## [0.1.41] — 2026-07-03

- **Clearer access-denied messages.** When an MCP endpoint refuses a client, the error now explains why
  instead of a generic failure.

## [0.1.40] — 2026-07-03

- 📣 **Office documents cost fewer tokens.** Kravn now converts DOCX into clean, structured Markdown (tables
  preserved, images/base64 stripped) before it reaches the model — lower cost and cleaner context than raw
  HTML/XML. Applies to SharePoint document reads too.

## [0.1.38–0.1.39] — 2026-07-03

- **Cleaner separation of concerns.** The control plane (managing servers) is decoupled from data-plane
  consumption, renamed to **MCP Servers** (upstreams) and **MCP Endpoints** (what clients consume), and the
  sidebar navigation was reorganized to match.

## [0.1.30–0.1.37] — 2026-07-02 → 2026-07-03

- 📣 **Pipelines — governance you can compose.** Chain hook-plugins at each stage of the MCP lifecycle
  (before/after a tool runs, on content in/out) with full tracing, a **global base plus per-endpoint
  overlays**, and opt-in per MCP endpoint. (0.1.30–0.1.31, 0.1.35)
- 📣 🧩 **A library of built-in plugins.** Secrets redaction, safety filtering, deny-lists, HTML→Markdown,
  safe-HTML, TOON token compaction — plus **compliance plugins**: prompt-injection guard, PII redaction, and
  an audit hook, all browsable from a new **plugin marketplace**. (0.1.33–0.1.34)
- 🐛 Resilient catalog sync (oversized upstream values are clamped, one bad item is skipped instead of
  aborting the sync) and the pipeline picker only offers org-enabled plugins. (0.1.36–0.1.37)

## [0.1.29] — 2026-07-02

- 📣 **Run Kravn in multiple replicas.** A shared cross-replica store (Dragonfly, Redis-compatible) makes rate
  limits and SSO login state consistent across pods — ready for high-availability deployments.

## [0.1.28] — 2026-07-02

- ⚡ **Faster and cheaper.** Anthropic prompt caching and a registry read cache cut latency and token spend.

## [0.1.22–0.1.27] — 2026-07-01 → 2026-07-02

- 📣 🔒 **Granular access control.** Grant MCP-endpoint and per-tool access **per team** — each team sees only
  the tools it's entitled to. (0.1.22–0.1.23)
- 🔒 **The admin console is locked down** behind the Platform Administrator Team, so an authenticated MCP
  consumer can never reach admin screens. (0.1.24)
- 📣 🧩 **Jira and Confluence integrations** (native MCP plugins, credentials encrypted at rest). (0.1.25–0.1.26)
- 📣 **Enterprise user lifecycle.** Edit/disable users, and **SCIM 2.0 auto-provisioning** from your IdP
  (Entra ID) — users are created and deactivated automatically, always at a safe role. (0.1.26)

## [0.1.17–0.1.19] — 2026-07-01

- 📣 🧩 **SharePoint integration.** Read SharePoint content (including `.docx` / PDF / `.xlsx` text) as MCP
  tools via app-only Microsoft Graph, with a configurable search region. **Plugin secrets are encrypted at
  rest.**

## [0.1.14–0.1.16] — 2026-07-01

- 📣 🔒 **OAuth 2.1 authorization server for MCP connectors.** Standards-based auth so MCP clients (e.g. Claude
  connectors) can connect securely. (0.1.14)
- **Change user roles from the UI.** (0.1.16)

## [0.1.10–0.1.13] — 2026-06-30 → 2026-07-01

- 📣 🔒 **Single sign-on with SAML / Entra ID.** Log in with your corporate IdP, with robust handling of
  IdP-signed responses and assertions. (0.1.10, 0.1.12–0.1.13)
- 🔒 **Login rate limiting** and an SSO-only / Entra-ID admin mode. (0.1.11)

## [0.1.6–0.1.9] — 2026-06-30

- **Zero-touch database migrations.** Automatic migrations plus a Helm migration Job for clean multi-replica
  rollouts. (0.1.6, 0.1.8)
- **Architecture Flow dashboard** — a visual map of how requests move through the gateway. (0.1.7, 0.1.9)

## [0.1.0–0.1.5] — 2026-06-30

- 🎉 **First release of Kravn.** A self-hostable MCP gateway, registry and proxy.
- **Runs on your database.** SQLite, PostgreSQL, MySQL and SQL Server, with schema support
  (`KRAVN_DB_SCHEMA`) and least-privilege Postgres users. (0.1.1, 0.1.4)
- Accepts SQLAlchemy-style `DATABASE_URL` schemes, with input-validated registry and server forms. (0.1.3,
  0.1.5)

[0.1.64]: https://github.com/addlayerio/kravn/releases/tag/v0.1.64
[0.1.63]: https://github.com/addlayerio/kravn/releases/tag/v0.1.63
[0.1.62]: https://github.com/addlayerio/kravn/releases/tag/v0.1.62
[0.1.61]: https://github.com/addlayerio/kravn/releases/tag/v0.1.61
[0.1.60]: https://github.com/addlayerio/kravn/releases/tag/v0.1.60
[0.1.59]: https://github.com/addlayerio/kravn/releases/tag/v0.1.59
[0.1.58]: https://github.com/addlayerio/kravn/releases/tag/v0.1.58
[0.1.57]: https://github.com/addlayerio/kravn/releases/tag/v0.1.57
[0.1.56]: https://github.com/addlayerio/kravn/releases/tag/v0.1.56
[0.1.55]: https://github.com/addlayerio/kravn/releases/tag/v0.1.55
[0.1.54]: https://github.com/addlayerio/kravn/releases/tag/v0.1.54
[0.1.53]: https://github.com/addlayerio/kravn/releases/tag/v0.1.53
[0.1.52]: https://github.com/addlayerio/kravn/releases/tag/v0.1.52
[0.1.51]: https://github.com/addlayerio/kravn/releases/tag/v0.1.51
[0.1.50]: https://github.com/addlayerio/kravn/releases/tag/v0.1.50
[0.1.49]: https://github.com/addlayerio/kravn/releases/tag/v0.1.49
[0.1.48]: https://github.com/addlayerio/kravn/releases/tag/v0.1.48
[0.1.47]: https://github.com/addlayerio/kravn/releases/tag/v0.1.47
[0.1.46]: https://github.com/addlayerio/kravn/releases/tag/v0.1.46
[0.1.45]: https://github.com/addlayerio/kravn/releases/tag/v0.1.45
[0.1.44]: https://github.com/addlayerio/kravn/releases/tag/v0.1.44
[0.1.43]: https://github.com/addlayerio/kravn/releases/tag/v0.1.43
[0.1.42]: https://github.com/addlayerio/kravn/releases/tag/v0.1.42
[0.1.41]: https://github.com/addlayerio/kravn/releases/tag/v0.1.41
[0.1.40]: https://github.com/addlayerio/kravn/releases/tag/v0.1.40
