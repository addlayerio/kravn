---
title: Comparison — choosing an MCP gateway
description: How to evaluate an MCP gateway, and how Kravn compares to SaaS AI tooling, self-hosted alternatives and IBM MCP Context Forge.
---

# Choosing an MCP gateway: how Kravn compares

If you're evaluating how to bring the [Model Context Protocol](https://modelcontextprotocol.io) to your
organization, you're weighing a few real options: a SaaS product that hosts everything for you, a
general-purpose self-hosted project, or a gateway like **Kravn** that is self-hosted *and* built around
enterprise identity and governance. This page lays out **what to look for** and **where Kravn fits** —
honestly, including where it isn't the right tool.

## What an MCP gateway actually needs to do

Before comparing products, compare on the dimensions that matter once MCP is more than a demo:

| Dimension | The question to ask |
|---|---|
| **Single governed surface** | Can one endpoint front many upstream MCP servers, so clients point at the gateway — not a dozen scattered URLs? |
| **Identity & access** | Does it plug into your IdP (SAML, OIDC), provision users (SCIM), and enforce **per-team** access to servers and individual tools? |
| **Data boundary** | Where do prompts, context and results go? Can you guarantee **nothing leaves your network**? |
| **Deployment & ops** | How long from zero to running? Is day-2 config done in-app, or does every change mean a redeploy? |
| **Governance & audit** | Can you redact secrets/PII, guard against prompt injection, and keep a tamper-evident **audit trail**? |
| **Extensibility** | Can you add integrations and lifecycle hooks without operating a separate server per source? |
| **Licensing** | Can you read the source, self-host without a per-seat bill, and avoid lock-in? |

Kravn was built to answer all seven with a **yes** — that's the whole design goal.

## Kravn vs. the common approaches

| | SaaS AI tooling | Generic self-hosted | **Kravn** |
|---|---|---|---|
| **Runs on your infrastructure** | ❌ vendor cloud | ✅ | ✅ Docker / Helm, your network |
| **Data leaves your network** | ⚠️ usually yes | varies | ✅ **no egress by design** |
| **Enterprise identity (SSO / SCIM / RBAC)** | varies | ⚠️ often thin | ✅ SAML, OIDC, SCIM 2.0, RBAC, teams |
| **Per-team tool entitlements** | rare | ⚠️ rare | ✅ per-team MCP + tool grants |
| **Governance pipelines & audit** | ⚠️ limited | ⚠️ rare | ✅ redact PII/secrets, prompt-injection guard, tamper-evident audit |
| **Time to running** | instant (hosted) | hours | ✅ **one command**, first-run wizard |
| **Day-2 config without redeploy** | n/a | ⚠️ config files | ✅ edited at runtime in Settings |
| **Licensing** | proprietary | varies | ✅ **source-available** (BSL 1.1 → Apache 2.0) |

*The middle column is a generalization of self-hostable projects, not any single product — evaluate your
specific shortlist on the same rows.*

## Kravn vs. IBM MCP Context Forge

IBM's **MCP Context Forge** is an open-source (Apache-2.0) MCP gateway and registry, built in Python. It's
broad and mature, and Kravn is unapologetically inspired by it — Kravn is a **leaner, opinionated take**
in a different stack:

- **Stack:** Kravn is a TypeScript monorepo (Fastify + Vue 3), shipped as a single image that boots with
  `docker compose up`. No Python runtime to operate.
- **Focus:** Kravn leads with **corporate identity and governance** — SSO/SCIM/RBAC, per-team
  entitlements, governance pipelines and a tamper-evident audit trail as first-class features, with a
  first-run setup wizard and runtime config so day-2 changes don't need a redeploy.
- **Scope:** Context Forge covers more surface area; Kravn deliberately trades breadth for a **simpler,
  install-anywhere** posture aimed at regulated and compliance-bound teams.

Both are self-hostable and source-visible. If you want the broadest Python-based reference implementation,
Context Forge is a strong choice. If you want a compact, identity-first gateway that a bank can install
without information leaving the building, that's Kravn.

## Kravn vs. broader platforms (Obot, TrueFoundry)

Some tools that show up next to Kravn are **broader platforms** that happen to include gateway features:

- **Obot** is an AI-agent platform; the MCP gateway is one part of a larger agent-building product.
- **TrueFoundry** is an ML/LLM infrastructure platform (model deployment, an AI gateway) aimed at
  ML-platform teams.

Kravn is narrower on purpose: it is an **MCP gateway, registry and proxy** — not an agent builder or a
model-serving platform. If your problem is *"safely expose MCP tools to AI clients under corporate
identity and governance, on our own infrastructure,"* that focus is the point.

## When Kravn is the right fit

- You need MCP **on your own infrastructure**, with **no data leaving the perimeter**.
- Corporate **identity and governance** are non-negotiable: SSO, SCIM, RBAC, per-team entitlements, audit.
- You want to be **running in one command** and manage config in-app, not via redeploys.
- You value **source-available** software you can read, run and trust.

## When it isn't

- You want a fully hosted, zero-ops SaaS and are fine with data leaving your network — a hosted product is
  simpler.
- You need an end-to-end **agent-building** or **model-serving** platform — that's a different category.
- You need the broadest possible feature surface today and don't mind operating a Python stack — evaluate
  IBM MCP Context Forge.

## See for yourself

- [Why Kravn](/guide/what-is-kravn) — the positioning in full
- [Get started](/guide/getting-started) — running in one command
- [Security & compliance](/guide/security) — the governance and licensing detail
- [Frequently asked questions](/faq)
- [Source on GitHub](https://github.com/addlayerio/kravn)
