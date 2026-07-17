---
title: Frequently asked questions
description: Direct answers about Kravn — what an MCP gateway is, licensing, self-hosting, identity, data privacy and how it compares.
---

# Frequently asked questions

## What is Kravn?

Kravn is a **self-hostable MCP gateway, registry and proxy**. It brings the
[Model Context Protocol](https://modelcontextprotocol.io) to your organization on your own
infrastructure — integrated with your identity stack (SAML, OIDC, SCIM, RBAC), governed by your own
policies, with no data ever leaving your perimeter.

## What is an MCP gateway?

An MCP gateway sits between AI clients (Claude, ChatGPT, Gemini, your own agents) and the MCP servers and
corporate systems they need. It connects to many upstream MCP servers, imports their tools, resources and
prompts into one registry, and re-exposes them behind a single governed endpoint — so a client points at
the gateway instead of a dozen scattered servers, and every call passes through access control and policy.

## Is Kravn free and open-source?

Kravn is **source-available and free to self-host**. It's licensed under the Business Source License 1.1
(BSL 1.1), which **converts to Apache 2.0** after four years. You can read the source, run it, and
self-host it at no cost. See the [LICENSE](https://github.com/addlayerio/kravn/blob/main/LICENSE).

## Is there a paid or "enterprise" edition?

No. There is **one edition**. The enterprise capabilities — SSO, SCIM, RBAC, governance pipelines, audit,
KMS/HSM key management — are in the product you self-host, not behind a paywall or a per-seat license.

## Does my data leave my network with Kravn?

**No.** Kravn is self-hosted by design and runs entirely on your infrastructure — Docker or Helm, on your
servers, in your network. There is no data egress and no third-party dependency in the request path. This
is what makes it safe to install in regulated and compliance-bound organizations.

## How is Kravn different from IBM MCP Context Forge?

IBM MCP Context Forge is a broad, mature, Python-based MCP gateway. Kravn is a **leaner, identity-first
take** built in TypeScript (Fastify + Vue 3): it boots in one command, is configured at runtime, and leads
with corporate identity, governance and audit for compliance-bound teams. See the full
[comparison](/comparison).

## Which identity providers does Kravn support?

SAML and OAuth2 / OIDC single sign-on, SCIM 2.0 provisioning, role-based access control, teams, and
per-team MCP + tool entitlements — out of the box.

## How do I install Kravn?

`docker compose up` or `helm install` with zero overrides and it's running — embedded SQLite, an
auto-generated signing key and a first-run setup wizard. See the [Quickstart](/guide/getting-started) and
the [Installation manual](/guide/installation).

## Which databases does Kravn support?

A portable store over **SQLite, PostgreSQL, MySQL / MariaDB, or SQL Server**, with versioned migrations.
SQLite is embedded so a fresh install needs no external database.

## What can Kravn connect to?

Any upstream MCP server over streamable-HTTP, SSE or stdio, plus a curated **catalog of 100+ public MCP
servers** (Notion, Linear, Sentry, Stripe, Supabase, Vercel, and more) you can add in a click. It also
ships **native integrations** for SharePoint, Microsoft Teams, Jira and Confluence over the vendor API —
no separate MCP server to operate. See the [integrations gallery](/integrations).

## Is Kravn ready for regulated or bank environments?

That's the design center. Kravn provides governance pipelines (redact secrets and PII, sanitize content,
guard against prompt injection), a tamper-evident **audit trail**, KMS/HSM-backed key management,
separation-of-duties / maker-checker controls, and SBOM + signed images. See
[Security & compliance](/guide/security).

## Who makes Kravn?

Kravn is built by **AddLayer**. The source lives on
[GitHub](https://github.com/addlayerio/kravn).
