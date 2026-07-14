# Plugins & integrations

Kravn's capabilities are **plugins** — nothing is hard-wired. That keeps the core small and lets you
extend the catalog and govern every call without forking the product.

There are two kinds:

- **`mcp-server` plugins** — provide an in-process MCP server (tools/resources/prompts) that Kravn
  exposes and composes like any other upstream. This is how the native corporate integrations work.
- **`hook` plugins** — Apigee-style interceptors that transform tool-call requests, results and the
  advertised tool list at each lifecycle junction. This is how governance pipelines are built.

Built-in plugins ship in the console's **Plugins** marketplace — search, filter, enable, and configure
them. Credential-bearing plugins document the exact permissions they need right in their setup screen.

## Integrations

Every integration lives in **one catalog** — you browse, configure and govern them all the same way, so
there's no separate class to manage. Browse the full, always-current list in the
**[integrations gallery](/integrations)**, or the **Catalog** tab on the *MCP Servers* page in the console.
Click any card for its detail (what it does, how it connects, setup) and filter by category.

The catalog mixes two kinds of connector, which you use identically — the only difference is how Kravn
reaches the service:

- **Built-in** connectors are `mcp-server` plugins **maintained by Kravn** that speak the vendor's own API
  directly (Microsoft Graph, REST, JSON-RPC) from inside the gateway — nothing extra to deploy or operate.
  Kravn ships them for common corporate systems, the major clouds and email (see the table below).
- **Remote MCP servers** are public MCP endpoints you point Kravn at (Notion, Linear, Sentry, Stripe,
  Supabase, Vercel, Hugging Face, Google, and dozens more). Servers with no auth or an API key connect
  immediately; for **OAuth 2.1** servers, click **Connect** — Kravn runs the whole flow (discovery, dynamic
  client registration, PKCE) and stores the tokens encrypted, refreshing them automatically.

### Built-in integrations

| Integration | What it does |
|---|---|
| **SharePoint** | Search, browse document libraries and read documents (Word/PDF/Excel/text) over Microsoft Graph. |
| **Microsoft Teams** | Find people, read chats and channel posts, list teams/channels, and fetch a message's images — over Microsoft Graph. |
| **Outlook** | Read **and send** email (search, read, send, reply/reply-all) over Microsoft 365 / Exchange Online (Graph). |
| **Gmail** | Read **and send** email (search, read, send, reply into a thread) over the Gmail API. |
| **Jira** | Query and read issues via the Jira REST API. |
| **Confluence** | Search and read Confluence pages. |
| **Odoo** | CRM & ERP over Odoo JSON-RPC — CRUD, server-side aggregation & counts, and search across leads, contacts, sales orders, invoices, products, tasks. |
| **Zoho CRM** | Read/search/CRUD over any module plus COQL queries (GROUP BY + aggregates), over the Zoho v6 REST API. |
| **Azure** | Read-only diagnostics & cost — Resource Graph (KQL over any resource), Log Analytics (KQL), Cost Management (spend by service), and Azure Monitor metrics. |
| **AWS** | Read-only cost & diagnostics — Cost Explorer (spend by service), CloudWatch Logs Insights, and resource inventory. Requests signed with SigV4. |
| **Google Cloud** | Read-only diagnostics & cost — Cloud Asset (any resource), Cloud Logging, Cloud Monitoring, and cost from the BigQuery billing export. |
| **HTTP Request** | Fire an HTTP request (GET/POST/…) with custom headers to retrieve information from any public API or page. JSON responses are returned as **TOML** and HTML as **Markdown** to save tokens. SSRF-guarded (internal/private hosts blocked); can send mutating methods, so pair it with the approval gate. |
| **LinkedIn** | Read the authenticated member's profile and **publish posts/shares** on their behalf, over LinkedIn's official OAuth 2.0 API (OpenID Connect + Share on LinkedIn). Standard-app scope only — profile search, messaging and jobs need LinkedIn partner programs. Includes a mutating action (posting). |
| **Code Interpreter** | Runs Python in a Pyodide/WASM sandbox (no host filesystem or network) to read and transform attached files — e.g. complete an Excel and return it as a download. |

Both reach the target system over the network, so **whether data stays on-prem depends on the target**, not
on the connector kind — a self-hosted Odoo/SharePoint stays inside your perimeter; a cloud service does not.
Either way, a credential is only needed when the service requires one, **credentials are encrypted at rest**,
and every integration's tools flow into the same registry and **team-governed MCP endpoints** — you compose
them into a restricted endpoint for the teams allowed to use them.

## Governance & content pipelines

Hook plugins are composed into **pipelines** — an ordered chain per lifecycle junction. A global pipeline
runs for all traffic; each endpoint can add its own overlay that can only *add* steps, never remove or
bypass a global one. Built-in hooks include:

| Hook | What it does |
|---|---|
| **Secrets Redactor** | Detects and strips private keys, cloud/API tokens, JWTs and credentials from results before they reach the model. |
| **PII Tokenizer** | Replaces emails, IPs, IBANs (mod-97), credit cards (Luhn), Argentina CBU + CUIT/CUIL (check-digit) and phone numbers with stable, deterministic tokens so the model reasons consistently without seeing the real values. Bank/tax-id detectors are checksum-validated to limit false positives. |
| **Prompt-Injection Guard** | Flags/neutralizes indirect prompt injection in tool output ("ignore previous instructions", role-tag spoofing, exfiltration directives) — the #1 MCP-specific risk. |
| **Content Safety Filter** | Lexicon-based self-harm / violence / hate detection with redact or annotate, and optional request blocking. |
| **Deny List Filter** | Block requests and/or redact results by phrase or regex. |
| **SafeHTML Sanitizer** | Strips common XSS vectors from HTML results (script/iframe/on\*/`javascript:`). |
| **Audit / Compliance Logger** | Writes a tamper-evident, hash-chained audit record for every tool call. |

## Fewer tokens, cleaner context

Several plugins exist specifically to shrink what reaches the model — lower cost, better focus:

- **HTML → Markdown** turns verbose HTML tool/resource results into clean Markdown.
- **Document extraction** in the integrations renders **DOCX to structured Markdown** (headings, lists
  and — the real win — tables), and PDF/Excel to text, instead of shipping raw binary.
- **TOON Encoder** re-encodes uniform JSON arrays into a compact tabular notation, cutting 30–70% of
  tokens.

## Writing your own

The plugin contract lives in `@kravn/plugin-sdk`. A plugin is a plain object (the default export of an ES
module) with a `manifest` and either a `server` (for `mcp-server`) or `hooks` (for `hook`). See
[PLUGINS.md](https://github.com/addlayerio/kravn/blob/main/PLUGINS.md) in the repository for the full
guide.

---

Next: [Security & compliance](/guide/security).
