---
title: MCP Best Practices
description: "A practical checklist for adopting MCP safely: front servers with a gateway, enforce SSO and least-privilege authorization, curate a registry, audit every call."
---

# MCP Best Practices

**MCP best practices** are the operational habits that let an organization adopt the Model Context Protocol
without creating a new, ungoverned path to its data. In short: front every server with a gateway, tie access
to your identity system, grant least privilege per tool, curate what you expose, and record everything. The
checklist below expands each point.

## Front everything with a gateway

Do not let AI clients connect directly to individual MCP servers. Route every connection through a single
[MCP gateway](/learn/what-is-an-mcp-gateway) so identity, authorization, policy and auditing are enforced in
one place. A gateway turns *N* clients times *M* servers into one governed surface, and gives you a single
point to observe, rate-limit and revoke.

## Enforce SSO and centralized identity

Every request should carry a real, verified identity. Integrate the gateway with your **SSO / IdP** (OIDC or
SAML) and, where possible, **SCIM** for provisioning, so joiners and leavers are handled automatically. Never
rely on shared API keys or anonymous access for anything touching sensitive systems. See
[MCP Authentication](/learn/mcp-authentication).

## Grant least privilege per tool

Authentication proves *who*; authorization decides *what*. Apply **least privilege** at the granularity of
individual tools and servers, driven by role- or attribute-based access control — a support agent should not
reach a tool that issues refunds just because both live behind the same gateway. See
[MCP Authorization](/learn/mcp-authorization).

## Curate a registry, don't expose everything

Maintain a deliberate [registry](/learn/mcp-registry) of approved servers and tools rather than auto-exposing
whatever a server advertises. Curation lets you review each tool before it is reachable, disable risky or
unused ones, and give clients a clean, discoverable catalog.

## Verify and pin tool definitions

An MCP tool's description and schema influence how a model behaves, which makes them a security surface.
Review tool definitions before approving them, and **pin** them so a server cannot silently change a tool
after it has been trusted — the class of attack covered in
[Tool Poisoning & Rug-Pull Attacks](/learn/mcp-tool-poisoning). Re-review on change rather than accepting
updates blindly.

## Redact secrets and PII

Tool arguments and results routinely carry credentials and personal data. **Redact** secrets and PII before
they land in logs, traces or the audit trail, so observability does not become a data-leak of its own. Keep
redaction rules close to the gateway where all traffic converges.

## Require approval for sensitive actions

For high-impact or irreversible operations — deleting data, moving money, changing access — require
human approval before the call executes. A **maker-checker / approval** step turns a single model mistake or
prompt injection into a caught event rather than an incident.

## Keep sensitive data on-premise

If prompts and results contain regulated or proprietary data, keep the whole path
[on-premise](/learn/running-mcp-on-premise). Self-hosting the gateway and upstream servers avoids data egress
and satisfies residency requirements. See also [MCP for Regulated Industries](/learn/mcp-for-regulated-industries).

## Monitor usage, quotas and cost

Instrument the gateway with [observability](/learn/mcp-observability): traces, metrics and per-user or
per-team usage. Set **quotas and rate limits** to contain runaway agents and control cost, and alert on
anomalies such as a sudden spike in calls to a sensitive tool.

## Keep a tamper-evident audit trail

Record every call — identity, tool, arguments, result, timestamp — in a **tamper-evident audit trail**. This
is what lets you reconstruct an incident, satisfy an auditor and prove that access to regulated systems is
controlled. Treat the audit trail as non-negotiable, not optional.

## How Kravn fits

[Kravn](/) is built around this checklist: it fronts your MCP servers behind one gateway, integrates with
enterprise SSO/SCIM/RBAC, curates a [registry](/learn/mcp-registry) of approved tools, pins tool definitions,
supports approval workflows and redaction, and keeps a tamper-evident audit trail — all
[self-hosted](/learn/running-mcp-on-premise) with no data egress. See the [security guide](/guide/security)
and [governance concepts](/guide/concepts) for details.

## Related

- [MCP Security](/learn/mcp-security)
- [MCP Governance](/learn/mcp-governance)
- [Enterprise MCP Architecture](/learn/enterprise-mcp-architecture)
- [What is an MCP Gateway?](/learn/what-is-an-mcp-gateway)
