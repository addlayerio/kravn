# Why Kravn

**Kravn is a self-hostable MCP gateway, registry and proxy, built for the enterprise.** It brings the
[Model Context Protocol](https://modelcontextprotocol.io) to your organization on your own
infrastructure — integrated with your identity stack, governed by your own policies, with no data ever
leaving your perimeter.

## The problem

The rise of AI has brought a wave of new tooling, and almost all of it is SaaS-first: your prompts, your
context and your data leave your network for someone else's cloud. For regulated and compliance-bound
organizations that is a non-starter — information cannot cross the corporate boundary.

Yet the self-hostable alternatives tend to fall short exactly where the enterprise needs them most:
corporate identity and governance — SAML, OAuth2/OIDC, SCIM provisioning, role-based access, teams and
per-team entitlements.

Kravn was created to close that gap. Born out of the compliance world, it lets any company adopt MCP and
AI tooling **entirely within its own infrastructure** — plugged into its own identity provider, governed
by its own access policies, with nothing leaving the perimeter and no integration compromises. The goal
is maximum flexibility for the corporate world: every organization runs and integrates Kravn on its own
terms.

## What it does

Kravn sits between your AI clients (Claude, ChatGPT, Gemini, your own agents) and the MCP servers and
corporate systems they need:

- **Connects to upstream MCP servers** over streamable-HTTP, SSE or stdio, and imports their tools,
  resources and prompts into a single **registry**.
- **Re-exposes them** — globally or composed into curated **MCP endpoints** (virtual servers) — behind
  one governed MCP surface, so a client points at Kravn, not at a dozen scattered servers.
- **Governs every call** with an identity- and team-aware access model, plus composable **pipelines**
  that can redact secrets and PII, sanitize content, guard against prompt injection, and keep a
  tamper-evident audit trail.
- **Ships native integrations** for the systems enterprises already run — SharePoint, Microsoft Teams,
  Jira, Confluence — over Microsoft Graph / the vendor API, no separate MCP server to operate.

## Highlights

- **Runs entirely on your infrastructure.** Self-hosted by design — Docker or Helm, on your servers, in
  your network. No data egress, no third-party dependency.
- **Enterprise identity out of the box.** SAML and OAuth2/OIDC single sign-on, SCIM 2.0 provisioning,
  role-based access control, teams, and per-team MCP + tool entitlements.
- **Boots on one command.** `docker compose up` or `helm install` with zero overrides → it's running.
  Embedded SQLite, auto-generated signing key, first-run setup wizard.
- **Config lives in the app.** SSRF policy, CSRF, rate limits, transports, federation, auth and
  observability are edited at runtime from the **Settings** page and applied without a redeploy. Only
  true infrastructure (DB, secret, port) is environment config.
- **A real MCP gateway.** Not just a proxy — a registry, a policy layer, a governance pipeline and a
  first-run-friendly console.

## Architecture at a glance

Kravn is a TypeScript monorepo (**pnpm + Nx**):

| Component | What it is |
|---|---|
| **Gateway** | Fastify control-plane backend: MCP core (upstream client + downstream JSON-RPC), registry, settings, auth/RBAC, SSO, teams, plugins, LLM providers, chat runtime, SSRF-safe HTTP, metrics and logs. Portable store over SQLite / PostgreSQL / MySQL · MariaDB / SQL Server with versioned migrations. Serves the operator console. |
| **Operator console** | Vue 3 admin UI — connect servers, curate the catalog, publish endpoints, manage users/teams/auth, compose pipelines. Bundled into the gateway image. |
| **Client app** | Vue 3 end-user app (chat + conversations) — a separate deployable. |
| **Plugin SDK** | The plugin contract: `hook` plugins (manipulate requests/results) and `mcp-server` plugins (in-process MCP servers). |

Next: read the [core concepts](/guide/concepts), or jump straight to the [Quickstart](/guide/getting-started).
