---
title: What is an MCP Gateway?
description: "An MCP gateway is one governed endpoint that fronts many upstream MCP servers, unifying discovery, access control and audit for AI clients."
---

# What is an MCP Gateway?

An **MCP gateway** is a single governed endpoint that sits in front of many upstream
**MCP servers**. AI clients connect to the gateway instead of to a dozen scattered servers,
and the gateway handles discovery, identity, access control and auditing on their behalf. It
is the control point where an organization decides *who* can reach *which* tools — and keeps a
record of every call.

## The problem it solves

A single developer can point an AI client straight at one MCP server and be productive in
minutes. An organization cannot. It has dozens of servers — internal and third-party — plus
many users and teams, corporate identity, compliance rules, and data that must not leave the
network. Wiring every client to every server directly means duplicated credentials, no central
policy, and no consistent audit trail. A gateway collapses that mesh into one managed surface.

## What a gateway does

A gateway typically provides several functions at once:

- **Unified discovery** — it aggregates the tools, resources and prompts of every upstream
  server into one place, so a client sees a single catalog instead of many endpoints.
- **Identity and access control** — it authenticates the caller against corporate identity and
  decides, per user or team, which servers and tools they are entitled to use.
- **Policy enforcement** — it can inspect requests and responses, redact secrets and PII,
  sanitize content, and block calls that violate rules.
- **Audit and observability** — it records who called what, when, and with which arguments, so
  activity is reviewable after the fact.
- **A stable seam** — upstream servers can be added, removed or moved without reconfiguring
  every client, because the client only ever knows the gateway's address.

## Gateway, proxy, registry

These terms overlap but describe different jobs. A [proxy](/learn/mcp-proxy) is the traffic
layer — it brokers MCP messages between client and server and enforces policy inline. A
[registry](/learn/mcp-registry) is the inventory — the curated catalog of tools, resources and
prompts you expose. A gateway is the product that combines both: a proxy plus a registry plus
identity and governance, presented as one endpoint.

## How it differs from an API gateway

An MCP gateway resembles a traditional [API gateway](/learn/mcp-vs-api-gateway), but its unit of
work is the **MCP capability**, not the HTTP route. It speaks JSON-RPC 2.0, understands the
distinction between tools, resources and prompts, negotiates capabilities at connect time, and
reasons about tool schemas — concerns an HTTP-only gateway has no model for. It is designed for
AI clients that discover and call tools dynamically, rather than for fixed request paths.

## How Kravn fits

[Kravn](/) is a self-hostable MCP gateway. It connects to your upstream MCP servers, imports
their tools, resources and prompts into one [registry](/learn/mcp-registry), and re-exposes them
behind governed MCP endpoints — integrated with SAML, OIDC and SCIM, with per-team RBAC and tool
entitlements, redaction and prompt-injection guarding in the request path, and a tamper-evident
audit trail. Clients point at Kravn; nothing leaves your perimeter. See
[What is Kravn](/guide/what-is-kravn) and the [security guide](/guide/security).

## Related

- [What is MCP?](/learn/what-is-model-context-protocol)
- [What is an MCP Registry?](/learn/mcp-registry)
- [MCP Gateway vs API Gateway](/learn/mcp-vs-api-gateway)
- [Enterprise MCP Architecture](/learn/enterprise-mcp-architecture)
