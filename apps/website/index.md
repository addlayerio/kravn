---
layout: home

hero:
  name: Kravn
  text: The enterprise MCP gateway
  tagline: Bring the Model Context Protocol to your organization — on your own infrastructure, plugged into your identity stack, governed by your own policies, with no data ever leaving your perimeter.
  image:
    src: /logo.svg
    alt: Kravn
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Installation Manual
      link: /guide/installation
    - theme: alt
      text: View on GitHub
      link: https://github.com/addlayerio/kravn

features:
  - icon: 🏛️
    title: Runs entirely on your infrastructure
    details: Self-hosted by design — Docker or Helm, on your servers, in your network. No data egress, no third-party dependency. Built for regulated and compliance-bound organizations.
  - icon: 🔐
    title: Enterprise identity out of the box
    details: SAML and OAuth2 / OIDC single sign-on, SCIM 2.0 provisioning, role-based access control, teams, and per-team MCP + tool entitlements.
  - icon: 🚀
    title: Boots on one command
    details: "docker compose up or helm install with zero overrides → it's running. Embedded SQLite, auto-generated signing key, first-run setup wizard."
  - icon: 🔌
    title: A real MCP gateway
    details: Connects to upstream MCP servers (streamable-HTTP / SSE / stdio), imports their tools, resources and prompts, and re-exposes them — globally or as composed MCP endpoints.
  - icon: 🧩
    title: Governance pipelines
    details: Compose hook plugins at each MCP lifecycle junction — redact secrets & PII, block or sanitize content, guard against prompt injection, keep a tamper-evident audit trail.
  - icon: ⚙️
    title: Config lives in the app
    details: SSRF policy, rate limits, transports, auth and observability are edited at runtime from the Settings page and applied without a redeploy. Only true infra (DB, secret, port) is environment config.
---

## Why teams choose Kravn

The rise of AI brought a wave of new tooling, and almost all of it is SaaS-first: your prompts, your
context and your data leave your network for someone else's cloud. For regulated and compliance-bound
organizations that is a non-starter — information cannot cross the corporate boundary.

Yet the self-hostable alternatives tend to fall short exactly where the enterprise needs them most:
**corporate identity and governance** — SAML, OAuth2/OIDC, SCIM provisioning, role-based access, teams
and per-team entitlements.

Kravn was created to close that gap. Born out of the compliance world, it lets any company adopt MCP
and AI tooling **entirely within its own infrastructure** — plugged into its own identity provider,
governed by its own access policies, with nothing leaving the perimeter and no integration compromises.

## Up and running in one command

```bash
# Docker
docker compose up            # → http://localhost:8080

# Kubernetes
helm install kravn ./charts/kravn
kubectl port-forward svc/kravn 8080:80
```

Then open the console, complete the first-run setup wizard, connect your first upstream MCP server, and
publish it as an MCP endpoint your teams can consume. The full walkthrough is in the
[Quickstart](/guide/getting-started) and the [Installation Manual](/guide/installation).

## Built for the corporate world

| | |
|---|---|
| **No data egress** | Everything runs inside your perimeter. Kravn never phones home. |
| **Identity you already have** | SAML, OIDC, SCIM 2.0, RBAC, teams — integrate, don't migrate. |
| **Portable persistence** | SQLite out of the box; PostgreSQL, MySQL/MariaDB or SQL Server when you scale. |
| **Highly available** | Multi-replica ready, with a shared store for cross-pod state. |
| **Source-available** | BSL 1.1, converting to Apache 2.0 — inspect it, run it, trust it. |

<div style="margin-top: 2.5rem; text-align:center;">

[Get started →](/guide/getting-started) &nbsp;·&nbsp; [Read the concepts →](/guide/concepts) &nbsp;·&nbsp; [See the security posture →](/guide/security)

</div>
