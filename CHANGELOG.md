# Changelog

All notable changes to **Kravn** — the self-hostable, compliance-focused MCP gateway, registry and proxy.

This file is written in plain, benefit-first language on purpose: each entry says *what you can now do*,
so it doubles as source material for release notes and announcements. For the deep technical/security
rationale behind each change, see [SECURITY.md](SECURITY.md).

- 📣 = worth announcing (a capability users care about)
- 🔒 = security · ⚡ = performance · 🧩 = integration/plugin · 🐛 = fix

The format is based on [Keep a Changelog](https://keepachangelog.com/). Versions match the Helm chart
`appVersion` and the `vX.Y.Z` git tags.

## [0.1.91] — 2026-07-22

- 🐛 **The Audit screen fits the page again.** With real traffic in it, the trail's seven columns pushed past
  the page width and the eight filters each took a full row, so the table overflowed and the filters ate most
  of the screen. The trail now scrolls inside its own card instead of stretching the layout, the filters pack
  into a dense auto-fitting grid (as many per row as the width allows) with smaller controls, and the
  timestamp is rendered compactly (`2026-07-22 02:06:36Z`) so it no longer wraps mid-value.

## [0.1.90] — 2026-07-22

- 📣 **Every MCP tool call is now audited.** Each tool invocation is written to the tamper-evident audit trail
  (and exported to your SIEM): who called it — or which client, for anonymous public endpoints — which tool, on
  which upstream server and MCP endpoint, the arguments (redacted and capped), the outcome, and the driving
  **model** when the call comes from Kravn's chat (external MCP clients don't advertise a model, so those are
  attributed by client/identity). Auditing is fire-and-forget, so it never blocks or fails a tool call.
- 📣 **In-app audit viewer.** A new **Audit** screen in the operator (gated by `audit.read`, so a bank can give
  it to a dedicated auditor) shows the trail with server-side filters — actor, actor type (user/system),
  category, resource type, tool/resource, outcome, and a UTC date range — plus paging and a one-click
  **"verify chain"** that recomputes the hash chain and reports any break.
- 🧩 **Teams: quoted/replied messages are resolved.** When someone quotes or replies to an earlier message,
  Teams sends only a reference; the connector now fetches the original and inlines it (*"↩️ In reply to X: …"*)
  instead of a dangling pointer, falling back to the embedded preview when it can't be retrieved.

## [0.1.89] — 2026-07-18

- 📣 **Every chat has its own link — refresh no longer loses it.** Chats, projects and scheduled tasks now
  each have their own URL (`/c/…`, `/p/…`, `/s/…`), so a page refresh (F5) reopens exactly what you were
  looking at, browser back/forward moves between views, and you can share a link straight to a chat. Deleting
  or archiving the open chat returns to the home view; a stale link falls back gracefully.
- 🐛 **Composer polish.** Tidied the redesigned composer: the `+` and **Send** buttons now match the input
  height instead of rendering small, and no longer overlap the input, and the active web-search mode shows as
  a removable pill above the input.

## [0.1.88] — 2026-07-18

- 🎨 **Chat client — a cleaner, more consistent UI.** Every emoji glyph in the chat app was replaced with proper
  vector icons (the same set the admin console uses), so the interface reads as one product instead of a mix of
  system emoji. Row actions across the sidebar and menus are crisp icons with tooltips.
- 📣 **Projects get a right-click-style menu, like chats.** Each project in the sidebar now has a `⋯` menu to
  **rename** it inline, open its **configuration** (sharing, default model, tools, documents, instructions), or
  **delete** it — gated by access (rename for owners/editors, delete for owners). Previously a project could only
  be opened, never managed from the list.
- 🐛 **The sidebar no longer squashes on a short window.** When the window got short, the whole sidebar compressed
  upward; now only the conversation list scrolls, while the brand, new-chat button and footer stay put.
- 🎨 **Composer: one "+" instead of a row of buttons.** Attach files, prompt library, memory and web search moved
  into a single **`+` menu**. Web search shows a check when it's on and appears as a removable pill inside the
  composer, so an active mode is obvious — a tidier, more familiar composer.

## [0.1.87] — 2026-07-18

- 🧩 **Jira: read a ticket's comment thread (`jira_get_comments`).** The connector could *add* a comment but had
  no way to *read* the discussion. New `jira_get_comments` returns an issue's comments — author, date and text,
  oldest first, paginated (`startAt`/`maxResults`) — so an agent can catch up on what was said, not just the
  fields. `jira_get_issue` also stops leaking the raw comment JSON into its field dump and now shows a
  `Comments: N — read with jira_get_comments` pointer when a ticket has any.
- 🧩 **Catalog: one-click Connect for OAuth servers that support it.** A catalogued MCP server that advertises
  dynamic client registration now shows a **Connect** button right on its card — one click creates the server
  and starts the sign-in (redirect → approve → connected), instead of add-then-hunt-for-the-button. Servers that
  need a manually registered OAuth app (GitHub, Slack, …) keep the plain **Add** and are configured afterward;
  the split is verified per server, so Connect never dead-ends in a config form.
- 🎨 **Operator: cleaner configuration tables.** Row actions across every config table — MCP servers, endpoints,
  agents, models, prompts, teams, users — are now compact icons with tooltips instead of text buttons, and the
  actions column no longer wraps to a second line. On MCP servers, native plugins and remote servers now share a
  single **Edit** action: one "MCP Server" to the user, whichever it is underneath.
- 🐛 **Jira now returns custom fields and pages past 50 results.** The Jira connector requested a fixed handful
  of fields (summary/status/assignee/type/priority/dates), so **custom fields never came back** — Story Points,
  Sprint, a "Module" select, a "Target UAT" date, anything your team added — and search capped at 50 issues with
  no paging. That silently starved any report that needs those fields. Now: **`jira_get_issue` returns every
  populated field**, each labelled by its display name (so `customfield_10050` shows as "Story Points Global").
  **`jira_search` takes a `fields` array** — the exact columns you want per issue, base or custom, by display
  name or id (`["assignee","status","Story Points Global","Sprint","Team","Fecha Target UAT"]`) — returns each
  issue as a clean row of just those columns (no descriptions), **pages automatically up to 200 in one call**
  (was a hard 50), and takes a `startAt` offset to window past that in a larger set. So a 114-issue report is
  one call, not 114. Values are flattened sensibly whatever their shape (a number, a select, a sprint, a user,
  a date, a list).
- 📣 **Agents: reusable, org-defined chat presets (replacing the personal Assistant).** An **Agent** is a named
  chat preset — instructions, a model, and a set of tools — that an **admin defines once in the operator** and
  shares with specific users or teams. Anyone entitled to it starts a chat from it in the chat app and inherits
  its setup. This replaces the old personal "Assistant" (a preset each user built for themselves, hidden in the
  new-chat dialog): the good ones are now organization capital, curated and governed centrally, instead of
  trapped in one person's account.
  - **Operator → Agents**: create/edit/delete agents with the same cross-endpoint tool picker as MCP endpoints,
    a provider + model, and an access policy (all signed-in users, or specific teams/users). Managing agents is
    gated by the `settings` permission.
  - **Chat client**: an "Agents" section in the sidebar and a picker in the new-chat dialog list the agents you
    may use. Starting a chat from one applies its model + instructions + tools.
  - **Governance is unchanged.** An agent's tools are a **filter over what each user is already entitled to,
    never a grant** — re-checked live on every turn, exactly like project tools. Being able to use an agent can
    never reach a tool you couldn't already reach. The **MCP gateway/data plane is untouched**: agents are a
    chat-client concept and are invisible to external MCP clients.
  - The personal Assistant is removed (its saved presets are dropped — they were few, in beta, and lost no
    stored content since assistant instructions were only ever injected live).
- 🎨 **Projects can pin a default model.** A project can set a default model so every chat started in it opens on
  that model (the highest-leverage setting for a workflow — the right model is what most separates a good result
  from a bad one). Leave it empty to keep picking per chat.
- 📣 **Teams now shows iPhone (HEIC) photos, and blank images say why.** The native Teams connector fetched an
  image's bytes and handed them to the model without checking what they were, so two kinds of image arrived
  blank: an **HEIC** photo (an iPhone's default format, which vision models can't render) whose type was passed
  through verbatim, and a `200` response that wasn't an image at all — an empty body, or a SharePoint
  auth/redirect page — which got mislabeled `image/png`. Now Kravn identifies the real format from the bytes
  themselves (magic number, not the claimed type or file extension). **HEIC/HEIF photos are transcoded to JPEG**
  so they actually display — the conversion is pure-WASM, adding no native dependency to the image. png/jpeg/webp/
  gif pass through with the correct type. Anything still not displayable (TIFF, BMP, an auth page, an empty body)
  becomes a plain-language note (*"got a web page, likely a permission redirect"*) instead of a silently blank
  image, so you can see which failed and why. (The MCP gateway was never at fault — it proxies image results
  untouched; this was the connector.)
- 🐛 **Azure cost "last month" failed — fixed by asking Azure a question it can answer.** `azure_cost_by_service`
  offered `TheLastMonth` and Azure rejected it: *"Invalid query definition, timeframe TheLastMonth is currently
  not supported."* The value is not ours to fix — Azure's Query API reuses the **Export** timeframe enum and never
  implemented that member (open since 2024: `Azure/azure-rest-api-specs#27650`; Microsoft's own Query samples fail
  the same way). Since "what did we spend last month" is the question people actually ask, Kravn now answers it
  instead of dropping it: the previous calendar month is unambiguous, so it is sent as an explicit date range and
  Azure never sees the value it dislikes. The other timeframes are reported to work and are untouched. Results now
  also state the exact window queried, so a cost report can't misattribute its own numbers.
- 🧩 **The cloud tools now declare their legal values instead of describing them.** Not one of Azure's tools used a
  JSON Schema `enum`: every closed set (timeframe, groupBy, aggregation) was a free-form string whose options lived
  in prose, so a model had to guess the exact spelling and nothing caught a wrong guess until the cloud API
  rejected it. Those sets are now real enums, generated from the same constants the server validates against — so
  the contract and the check cannot drift apart, as they had (the description advertised four `groupBy` dimensions
  while six were accepted, leaving two working dimensions no model could discover). `azure_metrics_query`'s
  `aggregation` is now validated rather than forwarded blind, and Custom `from`/`to` dates are checked and expanded
  to the full-day range Azure expects instead of being passed through raw.
- 📣 **The chat streams, and shows its work.** A chat turn is an agentic loop — the model thinks, calls a tool,
  reads the result, thinks again — and it all ran inside one blocking HTTP request that stayed silent until the
  last round finished. Any proxy in front of Kravn gives up long before that (Cloudflare cuts at ~100s with a
  **524**), so a deep investigation failed with *"Request failed (524)"* even though the gateway was still
  working. The web client now uses a streaming endpoint that answers immediately and keeps the connection alive
  for as long as the turn takes, so **the turn's length no longer has a ceiling**. While it works you see it
  work: Claude's own reasoning between rounds, and each tool as it runs, succeeds or fails.
  - **A dropped connection no longer loses the answer.** The stream is a *view* of the turn, not the turn
    itself — the reply is produced and saved regardless. If the connection drops, the client goes and finds it
    rather than claiming the turn failed (which previously cost you a full re-run).
  - The old JSON endpoint is unchanged, so scheduled tasks and API callers are unaffected.
- 🐛 **The model picker offered four retired Claude models.** Four of the six suggested Anthropic models
  (`claude-3-7-sonnet-latest`, `claude-3-5-haiku-latest`, `claude-opus-4`, `claude-sonnet-4`) have been retired
  by Anthropic and answer 404, and not one of the six was from the 4.6+ family — the only models where the
  extended thinking below actually applies. The list is now current and best-first (Opus 4.8/4.7/4.6, Sonnet
  5/4.6, Haiku 4.5). This only affects the offline suggestions; a provider with a key still discovers its own.
- 📣 **Claude now thinks before it answers (Anthropic extended thinking).** A Kravn chat on Claude used to
  answer straight from its first guess and never revise its plan between tool calls — the same model on
  claude.ai reasons first, which is why the same question against the same tools gave a visibly worse analysis
  here. Kravn now turns thinking on, picking the shape each model actually accepts: **adaptive** for Claude 4.6
  and later (Opus 4.8/4.7/4.6, Sonnet 5/4.6, Fable/Mythos 5), where Claude sizes its own reasoning per turn;
  the **legacy fixed budget** for Claude 3.7–4.5, which is all those models support; and **nothing at all** for
  a model id Kravn can't place, so an unknown or proxied model behaves exactly as before instead of failing.
  Thinking blocks are replayed verbatim across the agentic loop, so the model keeps its reasoning as it works
  through a multi-tool investigation. Also raises the answer ceiling from **4096 to 16000 tokens** (thinking is
  drawn from the same budget, and long structured reports were being cut short), with the request timeout
  widened to match. Nothing to configure — it applies to every Anthropic provider.
- 🎨 **Chat client UI fixes.** Three papercuts:
  - **The model picker now lists every model.** It was a text input backed by a `<datalist>`, which filters its
    suggestions by what's already typed — since the field is pre-filled with the provider's default, you only
    ever saw that one. It's a real **`<select>`** now (new chat, scheduled task, assistant), keeping any custom
    model the value already had, and falling back to a text field only when a provider advertises no models.
  - **A live "working" indicator.** While a turn is in flight the placeholder was static text, so a long
    tool-using turn looked frozen. It's now animated (pulsing dots, `prefers-reduced-motion` respected).
  - **Polished buttons** (shared `@kravn/ui`, so the operator gets it too): control-sized type, a hairline lift
    instead of a chunky border, a tactile press state, a proper `:focus-visible` ring, and disabled buttons no
    longer answer the pointer.
- ⚙️ **The chat agent's tool-round limit is now configurable (and higher by default).** The chat runs an
  agentic loop where the model calls tools, gets results, and calls more — capped per message so it can't run
  away on cost/latency. That cap was a hard-coded **6**, which cut off deep multi-source agents (a research/
  support agent querying Jira → GitHub → Azure → Datadog → … in sequence) with *"the assistant kept requesting
  tools past the limit"*. It's now an operator setting — **Settings → Governance → "Chat: max tool rounds per
  message"** (`governance.chatMaxToolRounds`, 1–40) — with the default raised to **12**.
- 🐛 **A chat turn cut off by the tool-round limit no longer looks like it silently died.** When the cap was hit,
  the model's last message is a *preamble* ("Let me fetch the controller code and check the DB metrics:")
  emitted alongside the tool calls we can no longer run — and that preamble was persisted **as if it were the
  finished answer**, with no warning (the notice only appeared when the text happened to be empty). The
  truncation notice is now **always** shown, appended to whatever partial text there was, so an unfinished
  analysis is unmistakable and tells you to raise the limit.
- 📁 **Projects (chat client): chats-first view + scheduled tasks inside a project.** Opening a project now
  shows its **chats** (and its scheduled tasks) as the main view instead of dropping straight into edit mode;
  project instructions / documents / sharing moved behind a **⚙️ settings** toggle. A project has a **"+
  Scheduled task"** button that creates a schedule scoped to the project — the run inherits the project's
  instructions + documents and its result lands as a chat in the project. Also renamed the confusing "Tools
  (MCP endpoint)" picker to **"MCP Endpoint"** (it selects an endpoint, not individual tools). *(Project-level
  tool selection — pick specific tools across endpoints — is the next step.)*
- 🧰 **Project-level tool selection (chat client).** A project can pin a **subset of tools** — chosen from **all
  the tools you have access to, across every MCP endpoint** (the endpoint becomes a grouping reference, not a
  gate). Every chat and scheduled task in the project is then limited to exactly those tools, so you can build a
  project around 2–3 specific tools instead of a whole endpoint. Purely a **chat-layer filter over the existing
  MCP governance** — the pinned set is **re-checked against the running user's live entitlement** on every call
  (a pin never grants access), each tool executes through **its own endpoint** so the approval gate / DLP
  overlays / usage metering apply exactly as on the MCP data plane, and the **MCP gateway data plane is
  unchanged**. New endpoint `GET /api/chat/available-tools`; `chat_projects.tool_ids` (migration 030). New chats
  started in such a project inherit the tools (no endpoint picker). Hardened after an adversarial review: pinned
  tools are **de-duplicated by name** so two same-named tools from different endpoints can't duplicate the
  provider tool list (a 400) or shadow one endpoint's approval gate (first pinned wins); and on a **shared**
  project an editor saving tools can only **add** tools they're entitled to — it never drops owner-pinned tools
  the editor can't see. The picker uses the same **server → tools tree** as the operator's MCP-endpoint composer
  (search, expand/collapse, per-server select-all), listing only what the user is entitled to (grouped by origin
  server via a new `serverId` on the available-tools response).
- 👥 **Share a project by picking a user, not typing an email.** The sharing panel now shows a **directory of
  Kravn users** to select (excluding yourself and existing members) instead of a free-text email box. New
  endpoint `GET /api/chat/shareable-users` (a minimal `{id,email,name}` directory available to end-users).
- 🐛 **Opening a chat project no longer crashes the client** (white screen, console `SyntaxError: 10`). The
  "share by email" placeholder (`user@company.com`) contained a literal `@`, which vue-i18n parses as
  linked-message syntax and throws on (`INVALID_LINKED_FORMAT`) the first time the project view renders it — so
  every project failed to open. The `@` is now escaped (`{'@'}`) in all locales. A new **`pnpm check:i18n`**
  guard (wired into CI) compiles every localized message with vue-i18n's own compiler and fails the build on any
  string that would crash at runtime, so this class of bug can't ship again.
- 🔌 **MCP clients with a custom callback scheme (Cursor, VS Code, Windsurf, …) can now connect.** Kravn's
  OAuth 2.1 authorization server previously rejected any `redirect_uri` that wasn't `https` or `http` on
  loopback, so a native-app client registering e.g. `cursor://anysphere.cursor-mcp/oauth/callback` failed
  Dynamic Client Registration with **"Invalid redirect_uri"**. Private-use / custom URI schemes are now
  accepted for native apps (RFC 8252 §7.1) — PKCE S256 (already mandatory) is the standard mitigation, and a
  denylist still refuses browser-executable / local-resource schemes (`javascript:`, `data:`, `file:`, …).
  Claude (https) and loopback clients are unaffected.
- 🌐 **Native web search in chat (per-chat toggle).** A 🌐 toggle in the composer turns on the LLM
  provider's own server-side web search for that conversation — **Claude** (Anthropic `web_search` tool,
  any model), **Gemini** (Google Search grounding, any 2.x model) and **OpenAI** (`web_search_options`,
  needs a `-search-preview` model). The search runs at the provider and the model weaves cited results into
  its answer — **no SearXNG/Brave to configure and no bot-detection**. For fetching a specific URL/API,
  use the `http_request` tool below. Persisted per chat (`chat_conversations.web_search`, migration 029).
- 🔗 **LinkedIn integration (native `kravn-linkedin`).** A built-in mcp-server plugin over LinkedIn's
  **official** OAuth 2.0 API: **`linkedin_me`** reads the authenticated member's profile (OpenID Connect
  `userinfo`) and **`linkedin_create_post`** publishes a post/share on their behalf (optionally attaching a
  link), via the Share on LinkedIn API. Auth is 3-legged OAuth — client id/secret + a member refresh token
  (secrets encrypted at rest; Kravn refreshes access tokens itself). Honest scope: LinkedIn does **not** open
  profile search, others' profiles, messaging, jobs or network stats to standard apps (those need partner
  programs), so the plugin doesn't fake them. Posting is a mutating action — pair it with the approval gate.
  Seeds disabled until configured; appears in the catalog with the LinkedIn logo.
- 🌍 **Multi-language platform (i18n).** The client and operator now run fully in **English, Español
  (Argentina), Français (France)** and **Português (Portugal)** — every view, modal, menu, placeholder,
  toast and the Settings field labels are localized (~4,000 translated strings across the two apps, all four
  locales in exact key parity). Keyed by **ISO `language-REGION`** code (single source of truth in
  `packages/contracts/src/i18n.ts`), so a regional variant (e.g. `es-UY`, which differs from `es-AR`/`es-ES`)
  is added with one code + one message file per app. An admin sets the **instance default** in **Appearance →
  Language**; each user can override it for their own session (a language switcher in both apps, persisted
  locally). Resolution: user override → instance default → browser language → English (the fallback for any
  key). Wired end-to-end via the public `/api/bootstrap` so the login and OAuth approval screens are localized
  pre-auth. Left in English by design: brand names (OpenAI, Anthropic…) and raw values echoed from the
  server. AGENTS.md now **requires** every new user-facing string to ship in all defined locales.
- 🎨 **White-label Appearance (per-client branding).** A new admin **Appearance** page (operator console) lets
  each customer brand the client-facing surfaces to match their organisation — **logo** (image upload),
  **brand name**, **tagline**, **primary colour**, and an advanced **raw CSS override** for a technician.
  Stored in settings (no migration) and served publicly on `/api/bootstrap`, so it applies **before login**
  to the **chat client** (login, sidebar, empty state, browser tab + favicon) and the **MCP OAuth approval
  page**. The Appearance page has a **live preview** and annotates where each change lands. Safety: the raw
  CSS override is applied only to the chat client, never the approval screen (where hiding the Approve/Deny
  controls would be a risk); the primary colour is hex-validated and the logo must be an image data URI
  (≤512 KB). A **“Powered by Kravn”** mark (small raven + wordmark, hard-coloured and guarded against CSS
  hiding) always renders below a custom logo.
- 🗂️ **Chat actions menu (chat client).** Each chat now has a `⋯` menu (like the reference apps): **rename**,
  **move to a project** (submenu), **pin** (pinned chats float to the top, with a 📌 marker), **archive**
  (hidden from the list, shown under a collapsible “Archived” section) and **delete**. (`chat_conversations.
  pinned` + `archived`, migration 028; the conversation `PUT` accepts `pinned`/`archived`/`projectId`.)
- 🔒 **SSRF guard hardening.** The outbound SSRF guard now classifies IPv6 correctly by parsing the address
  to bytes: IPv4-mapped (`::ffff:a.b.c.d` in dotted **or** hex-compressed form), NAT64 and IPv4-compatible
  addresses are resolved to their embedded IPv4 and blocked when private/reserved, and the AWS IPv6 metadata
  endpoint (`fd00:ec2::254`) is always blocked — closing bypasses that string-prefix checks missed. Untrusted,
  call-time URLs (the new `web_fetch`) go through a **strict** dispatcher that blocks private/loopback/
  link-local/reserved/metadata targets **regardless** of the `ssrfAllowPrivateNetworks` operator toggle (that
  setting only ever loosens the gateway's own egress to operator-configured upstreams), plus an explicit
  pre-flight that also covers IP-literal URLs (which undici does not run the dispatcher lookup for).
- 🌐 **HTTP Request integration (native `kravn-http`) — a configurable API connector with three lock levels.**
  An admin adds one connector per API and picks how much the client may vary the request: **Pinned** — fires
  **one exact request** (fixed method + URL + optional fixed body); the model can only *trigger* it, never
  change the URL, path or method (a "Postman saved request", ideal for a sensitive or write endpoint).
  **Scoped** — a **base URL** (API root, or a single endpoint) that the client calls **paths under**; it can
  never reach another host. **Open** — advanced opt-in: the client may call **any public URL** (strict SSRF).
  **Default headers** (auth, e.g. `Authorization: Bearer …`) are encrypted at rest, applied server-side, and
  **never shown to the model or chat**. Responses come back **token-efficiently** — JSON as **TOML**, HTML as
  **Markdown**, else capped text. Add it again per API; it seeds **disabled** (configure-first) so no empty
  default clutters the installed list. (Replaces the earlier `kravn-web` search/fetch plugin — general web
  search is now the provider-native chat toggle above.)
- 🔒 **Hardened the HTTP connector against host-lock escape and credential leakage** (found by two rounds of
  adversarial review of the connector). In a locked (Pinned/Scoped) connector, a **cross-host redirect is now
  refused** — an open-redirect on the trusted API can no longer bounce the request to an attacker host — and the
  server-side **auth headers are stripped whenever a request crosses to another host**, so a bearer token can't
  be exfiltrated via a redirect. **Path-scope confinement is enforced on the *normalized* path**, so encoded
  dot-segments (`%2e%2e`, `.%2e`, any case) can no longer climb above a Scoped connector's base path — a base of
  `…/team-a` really is confined to `/team-a`. In **Open** mode the connector no longer sends the stored auth
  headers at all (the client chooses the host, so a credential would leak). An **IP-literal target** (e.g. an
  IPv6 cloud-metadata address like `[fd00:ec2::254]`) is now validated up front, so metadata/IMDS ranges stay
  blocked even in the admin-configured path. Plus: the base URL is joined with proper URL semantics (a base
  carrying a `?query`, e.g. an API key, is no longer corrupted), and an empty/`/` path hits the base URL exactly.
- 🐛 **A configure-first connector no longer leaves an empty default instance in the installed list.** A
  `seedDisabled` mcp-server type (the HTTP Request connector) never gets an auto-created default `plg_<id>`
  server — any that a prior build seeded is removed on the next sync — so adding your own instance (e.g.
  "ComplianceOne Swagger") no longer sits next to a duplicate, request-refusing "HTTP Request" row. Your
  instances are untouched.
- 🤖 **Assistants (chat client).** Reusable presets — a **persona (system instructions) + default model +
  default tools** — that a user can start a chat from. Picking an assistant in "New chat" pre-fills the model
  and tool endpoint and injects its instructions into every chat started from it; instructions are loaded
  **live and owner-scoped**, so editing an assistant updates its chats and no user ever sees another's preset.
  Managed from the "New chat" dialog ("Manage…"). (`chat_assistants`, migration 026; `chat_conversations.
  assistant_id`, migration 027.)
- 🗂️ **Folders & tags for chats + persistent memory (chat client).** Two ways to keep the chat client usable
  at scale, both **user-governed**:
  - **Tags (folders).** A chat carries free-form tags; the sidebar shows a tag-filter bar and a per-chat tag
    editor, and tags combine with the title search to narrow the list. Tags are owner-scoped and de-duped
    case-insensitively. (`chat_conversations.tags`, migration 024; the conversation `PUT` now accepts
    `title` and/or `tags`.)
  - **Persistent memory.** A per-user set of durable facts ("I lead the AML team", "answer in Spanish") that
    is injected into the system prompt of **every** chat (and scheduled run). It is **curated by the user, not
    extracted by the model** — a governed, inspectable set the operator can reason about, in keeping with
    Kravn's controlled-interface stance. Managed from a 🧠 panel in the composer. (`chat_memory`,
    migration 025.)
- ⏱️ **Scheduled tasks (chat client).** Users can schedule a prompt to run on a **cron** or one-off
  **calendar** basis (with timezone); each run opens a fresh conversation with the result. The scheduler is
  multi-replica-safe — it claims each due run through the shared store's atomic counter, so exactly one
  replica executes it. (`chat_schedules`, migration 022.)
- 🖼️ **Vision + drag-and-drop attachments (chat client).** Images attached to a message are now sent to the
  model as vision input (Anthropic + OpenAI multimodal; Gemini falls back to text), and files can be dropped
  straight onto the composer to attach them.
- 📋🧠🗑️ **Prompt library, inline rename, delete chats, markdown & LaTeX (chat client).** A personal
  **prompt library** (per-user reusable prompts — answers "what if the user wants a custom prompt not in the
  MCP", `chat_user_prompts`, migration 023); **inline chat rename**; **delete chats** (hover trash + in-chat,
  with confirmation); assistant replies render as **markdown** with **KaTeX** math (`$…$` / `$$…$$`); and a
  **chat search** box in the sidebar.
- 🧩 **Deploy the chat client from Helm (`client.enabled`).** The chart can now stand up the end-user chat
  client (apps/client) as its **own pod + Service** — an nginx image (`ghcr.io/<owner>/kravn-client`, built +
  cosign-signed by CI) that serves the SPA and **reverse-proxies `/api` to the gateway Service** (the client
  uses same-origin paths, so the browser sees one origin — no CORS). Enable with `client.enabled=true` (+ an
  optional `client.ingress`); the client's public URL is auto-wired to the gateway as `KRAVN_CLIENT_URL` for
  SSO. One `helm install` now runs the gateway (control-plane + operator + chat API) and the client in
  parallel. Client pods carry a distinct name so the gateway Service never selects them.
- 📣 **Shared projects (multi-user).** A project owner can now share a project with other Kravn users by
  email, at two levels: **editor** (edit the instructions + documents) or **viewer** (read + chat with the
  project's context). Shared projects appear in each member's list ("shared by …") and their chats get the
  same instructions + document context. Access is enforced by a single membership gate on every project
  path, so a user with no grant sees nothing and **un-sharing is fail-closed** (the context stops reaching
  their chats immediately). Owner-only: deleting the project and managing who it's shared with.
  (`chat_project_members`, migration 021.)
- 🔒📣 **DLP on the chat input — redact PII before it reaches the AI model.** New pipeline junction
  **Chat Input** (`onChatInput`): whatever an end-user types in the chat client is now run through the
  pipeline **before** it's sent to the connected LLM. Add the **PII Tokenizer** to that junction and a CUIT,
  CBU, email, credit card or phone number in a message is replaced with a stable token (`⟦TAX_ID_ab12⟧`) —
  the raw value **never reaches the model**, while the user still sees exactly what they typed. Auditable:
  each message stores both what the user wrote (`content`) and what the model received (`model_content`, new
  nullable column, migration 020). Opt-in per the pipeline (global + per-endpoint overlays); nothing changes
  until an operator adds a hook to the Chat Input junction. Any text hook can now target chat input.

## [0.1.86] — 2026-07-11

- 🧩 **Real brand logos for (almost) every integration.** Integrations that simple-icons doesn't ship now
  show their **actual brand logo** instead of a lettered monogram, from two added sources baked into the
  shared icon map: **Iconify** (`logos`/`mdi`/`cib`) for Microsoft/Amazon (Azure, AWS, Teams, Outlook,
  SharePoint) + Salesforce, Slack, monday, Canva, Power BI, Microsoft Learn/Foundry, AWS Knowledge; and
  **Logo.dev** (baked as PNG data URIs at build time) for real companies no icon set has — ServiceNow, Plaid,
  Ramp, Apify, Attio, Telnyx, Semgrep, ThoughtSpot, Stytch, and ~40 more. Coverage went from ~54 to **119 of
  123**; the handful with no logo anywhere keep the monogram (a wrong logo is worse than initials). Build-time
  only — nothing new ships at runtime (logos are inlined; no external logo requests from the app).

## [0.1.85] — 2026-07-11

- 🧩📣 **Email attachments (Gmail & Outlook).** `gmail_send` / `outlook_send_mail` can now send **attachments**.
  Two ways: **`attachFiles`** — names of files already in the conversation, **including one a tool just produced**
  (e.g. a PDF from the Code Interpreter), so nothing is echoed as base64 through the model — and/or
  **`attachments`** (a JSON array of `{name, mimeType, data}` with base64). Files a trusted plugin produces during
  a turn are now added to the conversation's file workspace, so a later tool (like the mailer) can attach them by
  name. Limits: Gmail ~25 MB, Outlook ~3 MB (Graph `sendMail`).

## [0.1.84] — 2026-07-10

- 🐛 **Governance usage table shows names, not raw ids.** The per-scope usage rows now resolve the id to a
  human name — the **user's email** for user rows and the **endpoint name** for endpoint rows — instead of an
  opaque hash (it falls back to the id if the user/endpoint was deleted).
- 🐛 **Teams: the read transcript now always surfaces the real messageId** for any message with an attachment
  or inline image, so `teams_get_message_images` never has to guess it.

## [0.1.83] — 2026-07-10

- 🧩 **Teams: also fetch image _file attachments_, not just inline images.** `teams_get_message_images` now
  handles screenshots shared as a **file** (📎), resolving the attachment to its SharePoint/OneDrive item and
  downloading it — on top of the inline (pasted) images it already fetched. The read transcripts now surface a
  🖼️ hint (with the messageId) for both kinds. Fetching file attachments needs the `Files.Read.All` (or
  `Sites.Read.All`) permission on the Teams app; inline images don't.

## [0.1.82] — 2026-07-10

- 🧩 **Teams: view a message's inline images.** The Teams read tools now flag when a message has pasted
  images/screenshots (a 🖼️ hint with the messageId), and a new `teams_get_message_images` tool fetches those
  hosted images from Graph and returns them as viewable images — so an assistant can actually see a screenshot
  in a chat, not just its filename. Uses the same read-only permissions; images over 5 MB are skipped.
- 🧩📣 **Add any integration more than once (multi-instance).** A native integration can now be added
  multiple times, each as its own **MCP Server** with its **own credentials** — e.g. Azure subscription A on
  the DevOps team's endpoint and subscription B on the Dev team's, or two different Outlook/Gmail accounts.
  From the Catalog, "Add" a built-in integration, name the instance, and enter its credentials; each instance
  is composable into a different endpoint, enabled/governed independently, with its secrets encrypted at rest.
  Native and remote integrations are now one unified, multi-instance "MCP Server" model (built-in ones just
  carry a badge). Your existing integrations keep working unchanged as their default instance — no
  re-configuration.
- 🧩📣 **Email integrations — Gmail & Outlook (read _and_ send).** Two new native plugins let an assistant
  work with email end-to-end: **search/read** messages and **send** new mail (Outlook also reply/reply-all),
  so a workflow can, for example, email a summary when a task finishes — something you couldn't do before.
  **Gmail** uses OAuth 2.0 (client id/secret + refresh token); **Outlook** uses app-only Microsoft Graph
  (Mail.Read + Mail.Send), the same auth as the SharePoint/Teams plugins. Secrets are encrypted at rest.
  Sending is a mutating action — put the send tools behind the **approval gate** if you want a human to
  confirm outbound mail.
- 🧩 **Azure: discover Log Analytics workspaces.** New `azure_list_log_analytics_workspaces` tool lists every
  workspace (name + workspace ID) visible in the subscription, so an assistant can query across several
  workspaces without pinning one in config — the configured Workspace ID is a convenient default, not a limit.

## [0.1.81] — 2026-07-09

- 🧩📣 **AWS integration — read-only cost & diagnostics.** A new native **AWS** plugin connects Kravn to your
  AWS account over the AWS REST APIs — no external runner, no aws-sdk. Break down **cost by service type** with
  Cost Explorer, run **CloudWatch Logs Insights** queries (with log-group discovery) for diagnostics, and list
  resources with the Resource Groups Tagging API. Auth is an IAM access key (encrypted at rest); every request
  is signed with **AWS Signature V4**. Every tool is **read-only** — no write tools at all.
- 🧩📣 **Google Cloud integration — read-only diagnostics & cost.** A new native **Google Cloud** plugin
  connects Kravn to GCP over the Google REST APIs — no external runner, no google SDK. Search **any resource**
  with Cloud Asset Inventory, query **Cloud Logging** and **Cloud Monitoring** for diagnostics, and read
  **cost** from the BigQuery billing export. Auth is a service-account key (encrypted at rest); Kravn signs a
  short-lived **RS256 JWT** for it. Every tool is **read-only** — no write tools at all.

## [0.1.80] — 2026-07-09

- 🧩📣 **Azure integration — read-only diagnostics & cost.** A new native **Azure** plugin connects Kravn to
  your Azure tenant over the Azure REST APIs — no external runner, no SDK. Query **any resource** with
  Resource Graph (KQL), run **Log Analytics KQL** for logs & platform diagnostics (e.g. a SQL Hyperscale DB),
  break down **cost by service type** with Cost Management, and read **Azure Monitor metrics** — all from one
  MCP endpoint, alongside Datadog, so an assistant can analyse an incident end-to-end. Auth is a Microsoft
  Entra **service principal** (client id + secret, encrypted at rest); public, US Gov and China clouds are
  supported. Every tool is **read-only** — there are no write tools at all, so it can never change anything in
  your cloud.

## [0.1.79] — 2026-07-09

- 🔒 **Dependency & image vulnerability hardening.** Fixed every flagged dependency CVE: `xlsx` moves to the
  maintained SheetJS build (ReDoS + prototype pollution — reachable via uploaded spreadsheets), plus
  `@fastify/static`, `fast-xml-parser`, and `echarts`/`vue-echarts`. The Docker image is now a hardened,
  **package-manager-free Alpine** build — the build tooling (pnpm/npm and their bundled deps: tar, glob,
  minimatch, cross-spawn, sigstore, …) no longer ships in the runtime, OS packages are `apk upgrade`-patched,
  and it runs as a non-root user. Together this removes the bulk of the image's CVE surface (`pnpm audit` is
  now clean, and the per-release Trivy scan from 0.1.78 verifies each image).

## [0.1.78] — 2026-07-09

- 🔒 **Release images are vulnerability-scanned with Trivy.** Every release now runs a Trivy scan of the built
  image (CRITICAL/HIGH, fixable only) and publishes the findings to the repo's Security tab — on top of the
  SBOM, SLSA provenance and cosign signature. The Trivy vulnerability DB is mirrored into our own GHCR
  (refreshed daily) so scans pull from a controlled source, not the public registry.

## [0.1.77] — 2026-07-09

- 📣 **Settings page redesigned.** The one-long-scroll list of every option is now a sectioned two-pane
  layout — pick a section on the left, edit its fields on the right — with a **search box that finds any
  setting across every section**. "Your sessions" is its own section now.
- 🐛 **Tool-call failures now appear on the Logs page**, not just in the error metric. When a proxied tool
  errors — and the MCP client masks it as a generic "error occurred" — you can now read the real upstream
  error (HTTP status, message) in Kravn's Logs.
- 🐛 **Approval Gate polish.** "Tools requiring approval" is now a **grouped-by-server tool picker** (like the
  MCP-endpoint composer) instead of a flat checklist, and glob patterns match a server's **name or slug**, not
  only its internal id.

## [0.1.76] — 2026-07-09

- 🐛 **Governance settings are their own section now, and the Approval Gate picks tools from a list.** The
  tool-definition pinning + budget settings moved out of *Security* into a dedicated **Settings → Governance**
  group. The Human Approval Gate's "tools requiring approval" field now renders a **picker of your live tools**
  (like the other screens) instead of a free-text "one per line" box — globs (`*delete*`) remain available via
  the JSON view.

## [0.1.75] — 2026-07-09

- 📣🔒 **MCP threat defence — rug-pull detection & tool-poisoning scanning.** A compromised or updated upstream
  can silently change a tool's definition after you approved it, or hide instructions in a tool description
  ("tool poisoning"). Kravn now defends against both. **Tool-definition pinning** (Settings → Governance →
  *Tool-definition pinning*: `off` / `audit` / `enforce`) fingerprints each tool's description + input schema
  on first sight; a later change is flagged, audited, and — under `enforce` — the tool is **quarantined** (not
  advertised or invocable) until an admin re-approves it under **Governance → Tool changes**. The
  **Prompt-Injection Guard** plugin now also scans tool *definitions* (add it to the `onListTools` junction):
  it strips invisible/bidi/tag unicode, redacts/annotates injected phrases in descriptions, and flags
  name-shadowing across servers.
- 📣🔒 **Human approval gate (maker-checker) for agent actions.** The new **Human Approval Gate** plugin holds
  a matching tool call (glob on tool name or `server/tool`) until a person approves it under **Governance →
  Approvals**: approved → the call runs; denied → it's blocked; not decided within the timeout → blocked with
  a queue id to retry (bounded-wait, configurable). It **fails closed**, enforces **separation of duties** (you
  can't approve your own call), records every decision in the audit trail, and works across replicas.
- 📣🔒 **Cost / quota governance.** Kravn now meters **tool calls** and **LLM tokens** per day (global, per
  user, per endpoint, per model) for chargeback, and enforces **org-wide daily budgets** (Settings →
  Governance): exceed the tool-call or token budget and Kravn either warns or blocks (`budgetAction`). Usage
  and budgets are shown under **Governance → Usage** and exported to Prometheus (`kravn_llm_tokens_total`,
  `kravn_budget_blocks_total`) and the audit trail. (Per-team / per-endpoint budgets are on the roadmap.)

## [0.1.74] — 2026-07-06

- 📣🐛 **Non-admin users can now sign in to authorize an MCP endpoint (OAuth consent).** Connecting a Kravn
  MCP endpoint from an MCP client sends the user through Kravn's login (incl. SSO / EntraID) to approve the
  scope — but the operator SPA's admin-console guard was bouncing every non-Platform-Admin to the login page
  with *"Only members of the Platform Administrator Team can sign in here"*, so a normal MCP consumer could
  never complete consent. The guard now exempts the standalone `/oauth/consent` page (and the password-login
  path mirrors it). The backend already allowed this — consent required only authentication, not admin, and
  mints an MCP-scoped token for the user's own identity; per-endpoint access stays governed by team
  membership. Admin-console access is unchanged.

## [0.1.73] — 2026-07-06

- 🐛 **Favicon is now the golden raven on a transparent background, tightly framed** — the black rounded tile
  behind it was unintended and showed as a black box in the browser tab, and the raven only filled ~60% of the
  canvas so it rendered small. Removed the background `<rect>` and cropped the `viewBox` to the raven (now
  ~90% fill), then regenerated `favicon.ico` / `favicon-96x96.png` transparent, across the operator, website
  and client apps. (The gateway serves the operator build, so its favicon updates automatically.)

## [0.1.72] — 2026-07-06

- 🧩 **Datadog catalog setup now documents the exact permissions each query family needs.** Two non-obvious
  gotchas are called out: (1) the MCP-specific RBAC permissions **`mcp_read` / `mcp_write`** gate the server
  *separately* from the data scopes — without them `tools/list` works but every query fails with
  `Forbidden / Failed permission authorization checks`; (2) metric queries need **`timeseries_query`** on top
  of `metrics_read` (easy to miss). The detail now maps scopes per family (metrics, logs, events/change
  tracking), notes granting the MCP permissions to the Application key owner's role, and adds the "leave the
  key unscoped while debugging" tip.

## [0.1.71] — 2026-07-06

- 🐛 **Datadog connects with an API key + Application key, not OAuth.** The catalog entry was wrongly marked
  OAuth (so it asked for OAuth 2.1 config with nowhere for the keys/region). It now uses header auth: create
  a Datadog API key + a read-scoped Application key, set your region host in the URL, and add both as
  `DD-API-KEY` / `DD-APPLICATION-KEY` under **Extra headers**.

## [0.1.70] — 2026-07-06

- 🔒 **Model governance — allowlist which LLM models may be used.** Settings → *Allowed LLM models* restricts
  the chat to an approved set (exact ids or `*` globs like `claude-*`; empty = any). A conversation on a
  disallowed model is refused server-side. (MCP-upstream egress is already governed by the SSRF policy, and
  which LLM providers exist is admin-configured.)
- 🔒 **Deeper PII detection.** The PII Tokenizer now also catches **IBANs** (mod-97), **Argentina CBU**
  bank accounts and **CUIT/CUIL** tax ids — all **checksum-validated** to limit false positives — on top of
  emails, IPs, credit cards and phones. Each is replaced with a stable token so the model never sees the
  real value.
- 📣 **OpenTelemetry tracing (OTLP).** Export distributed traces of requests, MCP tool calls and LLM calls to
  your observability stack (Jaeger/Tempo/Grafana/Datadog…). Off by default — enable with
  `KRAVN_OTEL_ENABLED=true` and the standard `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_SERVICE_NAME`. No request
  bodies or tokens in spans; zero overhead when disabled.
- 🔒 **See and revoke your active sessions, plus idle timeout.** Settings now lists every browser/device
  you're signed in on — revoke any one, or "log out other sessions". An operator can set an **idle timeout**
  (Settings → *Idle timeout*, on top of the absolute session TTL). Logout and revocation take effect
  immediately.
- 🔒 **Connect to internal upstreams with a custom CA or mutual TLS.** An MCP server can now carry a **custom
  CA bundle** (trust a corporate/self-signed CA) and a **client certificate + key** for **mTLS**. The private
  key is encrypted at rest and write-only. The SSRF guard still applies, and server-cert verification stays
  on. Set it under *TLS / mTLS (advanced)* on the server form.
- 📣 **Disaster recovery & continuity, documented and automatable.** A full DR/BCP runbook
  ([`DR_BCP.md`](https://github.com/addlayerio/kravn/blob/main/DR_BCP.md) + a [website guide](/guide/dr-bcp))
  covers exactly what to back up (database **and** encryption key, together), per-engine backup/restore
  steps, RPO/RTO guidance, key recovery, and HA — plus an optional **backup CronJob** in the Helm chart
  (`backup.enabled`).
- 🧩 **Six enterprise connectors added to the catalog:** Salesforce, ServiceNow, Slack, Snowflake, Datadog and
  GitLab — all official first-party MCP servers, one-click add with OAuth. Their setup cards note the
  specifics (per-instance URLs for ServiceNow/Snowflake/self-managed GitLab, Slack's pre-registered app,
  Datadog/GitLab preview/beta status).
- 🔒 **Signed, verifiable releases.** Every release image now ships a CycloneDX **SBOM** (bill of materials)
  and **SLSA build provenance**, and both the image and the Helm chart are **cosign-signed** (keyless). You
  can verify an artifact is the genuine, untampered build and see exactly what's in it before deploying — the
  [Security guide](/guide/security) shows how. (All free/automated; no third-party audit involved.)

## [0.1.69] — 2026-07-05

- 🧩 **Read AI added to the catalog.** Connect Read AI (meeting copilot) with one-click OAuth to reach your
  meeting reports, transcripts, summaries and action items.
- 🐛 **The dashboard shows the real running version.** It always read `0.1.0` (a hardcoded constant); the
  actual release version is now injected into the image at build time, so the console reflects the version
  you're running. (Takes effect from the next released image.)

## [0.1.68] — 2026-07-05

- 🧩 **New built-in integration: Zoho CRM.** Connect Zoho CRM (server-to-server OAuth 2.0 — a Self Client +
  refresh token, region-aware) and get read/search/CRUD over any module plus **COQL** queries with `GROUP BY`
  and `COUNT`/`SUM`/`AVG` aggregates (the "how much / how many" tool), and convenience search for Leads,
  Contacts, Accounts and Deals. Credentials encrypted at rest; adversarially security-reviewed.
- 📣 **Filter the integrations gallery by kind.** The website gallery (`/integrations`) now has All /
  Built-in / Catalog chips (with counts) alongside search and category.

## [0.1.67] — 2026-07-05

- 🧩 **Odoo: answer "how much / how many" in one call.** Two new read-only tools — `odoo_read_group`
  (server-side aggregation: totals and sums grouped by any field, e.g. invoiced-per-currency for a month in a
  single query) and `odoo_search_count` (a plain count, e.g. active customers). No more paging through
  hundreds of records and summing client-side.
- 🐛 **The integrations gallery is now actually live on the site.** The website deploy had been failing since
  the gallery landed (its data loader imports a workspace package that CI wasn't building first), so
  kravn.ai/integrations wasn't updating — fixed, and the full gallery now publishes.

## [0.1.66] — 2026-07-05

- 📣 **Integration setup guides now render as formatted docs, not a wall of text.** In the catalog detail
  view and the built-in integration config, the "Getting set up" / setup notes and field help are rendered
  as **Markdown** — numbered steps, bullet lists, `code` for menu paths and field names, bold and links —
  so multi-step setups (GitHub OAuth app, SharePoint/Teams Entra registration, Odoo, HubSpot…) are actually
  readable. Rewrote the built-in + catalog setup texts to use that structure.
- 🧩 **Odoo connector: clearer database guidance for Odoo.sh.** The Database field help + setup notes (and the
  Plugins docs) now explain that on Odoo.sh the database is **not** the subdomain — find it via `?debug=1`
  (top-right, in brackets), and keep the URL and database from the same build.
- 🐛 **Editing a built-in integration now shows its real settings.** Clicking **Configure** on an installed
  built-in integration (e.g. Odoo) in MCP Servers opens the same credential form you filled in on install
  (database, user, API token…) — instead of the generic server form that showed none of them.
- 🐛 **Built-in integrations read "Provided by Kravn"** (was "Provided by plugin"); existing ones self-heal
  on the next sync.
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
