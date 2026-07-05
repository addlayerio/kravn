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

Integrations differ only in **where they run**:

- **Built-in** — a native `mcp-server` plugin that runs **in-process** inside Kravn: no separate MCP server
  to operate, an app-only credential, and nothing leaving your perimeter. You enter credentials once and its
  tools join the catalog. Kravn ships built-in connectors for the corporate systems you already run —
  **SharePoint, Microsoft Teams, Jira, Confluence, Odoo** — plus a **Code Interpreter** (Python in a
  Pyodide/WASM sandbox for reading and transforming attached files).
- **Remote MCP servers** — a curated set of public servers you add in one click (Notion, Linear, Sentry,
  Stripe, Supabase, Vercel, Hugging Face, Google, and dozens more across project management, payments, CRM,
  databases, observability, documentation and search). Servers with no auth or an API key connect
  immediately; for **OAuth 2.1** servers, click **Connect** to sign in with the provider — Kravn runs the
  whole flow (discovery, dynamic client registration, PKCE) and stores the tokens encrypted, refreshing them
  automatically.

Either way, a credential is only needed when the server requires one, **credentials are encrypted at rest**,
and every integration's tools flow into the same registry and **team-governed MCP endpoints** — you compose
them into a restricted endpoint for the teams allowed to use them.

## Governance & content pipelines

Hook plugins are composed into **pipelines** — an ordered chain per lifecycle junction. A global pipeline
runs for all traffic; each endpoint can add its own overlay that can only *add* steps, never remove or
bypass a global one. Built-in hooks include:

| Hook | What it does |
|---|---|
| **Secrets Redactor** | Detects and strips private keys, cloud/API tokens, JWTs and credentials from results before they reach the model. |
| **PII Tokenizer** | Replaces emails, IPs, credit cards (Luhn-checked) and phone numbers with stable, deterministic tokens so the model reasons consistently without seeing the real values. |
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
