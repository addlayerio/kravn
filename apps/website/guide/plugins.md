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

## Native integrations

Talk to the corporate systems you already run — no separate MCP server to operate. Each is a native
`mcp-server` plugin; you enter credentials once and its tools join the catalog.

| Integration | What it does |
|---|---|
| **SharePoint** | Search, browse document libraries, and read documents (Word/PDF/Excel/text extracted to text) over Microsoft Graph (app-only). |
| **Microsoft Teams** | Find people, find/list/read chats (scopable by date — "what did X and Y discuss yesterday"), list teams/channels and read channel posts, over Microsoft Graph (app-only). |
| **Jira** | Query and read issues via the Jira REST API. |
| **Confluence** | Search and read pages. |
| **Code Interpreter** | Run Python in a WASM sandbox (Pyodide — no host filesystem or network) to read and transform attached files, e.g. complete a spreadsheet and return it. |

Credentials for these are stored **encrypted at rest**, and access is governed by the same team model as
everything else — you compose their tools into a restricted MCP endpoint for the teams allowed to use
them.

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
