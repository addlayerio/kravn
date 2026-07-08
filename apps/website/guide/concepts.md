# Core concepts

A quick mental model of how Kravn is organized. Five ideas cover most of it.

## Architecture at a glance

Kravn sits between your MCP **consumers** and your MCP **servers**. Clients connect to a curated
**endpoint**; every call flows through a policy pipeline (auth, DLP, audit, egress and model controls) over
a single **registry** of capabilities — all inside your own perimeter, with no data leaving your network.

<ArchitectureDiagram />

## MCP Servers vs MCP Endpoints

These are the two sides of the gateway, and keeping them distinct is the key to the whole model.

- **MCP Servers** are the **upstreams Kravn connects to** — the external MCP servers (over
  streamable-HTTP, SSE or stdio) and the native integrations. Kravn imports their tools, resources and
  prompts into its registry.
- **MCP Endpoints** are what **you publish to consumers** — a curated, named surface composed from the
  catalog. A client (Claude, ChatGPT, an agent) connects to an endpoint, not to the raw upstreams.

> Think of MCP Servers as *ingredients* and MCP Endpoints as the *dishes* you put on the menu.

## The registry

Everything an upstream advertises — **Tools**, **Resources** and **Prompts** — is synced into a central
registry. From there you browse it, search it, and pick exactly what each endpoint should expose. The
registry is the single source of truth for "what capabilities does this organization have."

## Control plane vs data plane

Kravn draws a hard line between two orthogonal concerns:

- **Control plane** — *configuring Kravn*. Connecting servers, curating the catalog, publishing
  endpoints, managing users, auth and pipelines. Reserved for administrators.
- **Data plane** — *consuming MCPs*. An end user connecting a client to an MCP endpoint and invoking
  tools. Governed purely by **team membership** against the endpoint's access policy.

The two are independent: one identity can be both a platform admin *and* an ordinary consumer. Being an
admin does **not** grant automatic access to a restricted endpoint — you consume it by being in one of
its teams, exactly like anyone else.

### Access policies

Each MCP endpoint has an access policy:

| Policy | Who can consume it |
|---|---|
| `public` | Anyone, no authentication |
| `authenticated` | Any signed-in user |
| `restricted` | Only members of an allowed **team** |

On top of access, **per-team tool entitlements** narrow *which* tools a team sees on an endpoint — so two
teams can share one endpoint yet get different tools.

## Teams & identity

Users arrive via SAML, OIDC or SCIM provisioning (or are managed locally), carry a role (RBAC), and
belong to **teams**. Teams are the unit of data-plane authorization: endpoints grant access to teams, and
tool entitlements are per team. A dedicated *Platform Administrator* team gates the admin console.

## Pipelines & plugins

A **pipeline** is an ordered chain of **hook plugins** attached to a lifecycle junction — `onToolCall`,
`onToolResult`, `onListTools`, the resource/prompt equivalents, and auth. Pipelines are **opt-in**: a
plugin runs only where an admin explicitly adds it.

- A **global** pipeline runs for all traffic.
- Each MCP endpoint can add its **own overlay** on top — and an overlay can only *add* steps; it can
  never remove or bypass a global one. That invariant is what makes a global control (say, secret
  redaction) impossible for any single endpoint to switch off.

Plugins come in two kinds: **hook** plugins (transform requests/results) and **mcp-server** plugins
(provide tools). See [Plugins & integrations](/guide/plugins).

---

Ready to run it? Head to the [Quickstart](/guide/getting-started).
