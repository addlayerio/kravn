---
title: MCP Gateway vs API Gateway
description: "An API gateway routes HTTP requests; an MCP gateway understands MCP tools, resources, JSON-RPC semantics and per-tool authorization on top of that."
---

# MCP Gateway vs API Gateway

An **API gateway** manages HTTP/REST traffic — one entry point that handles routing, authentication, rate
limiting and observability for backend services. An **MCP gateway** does all of that too, but it also
understands the **Model Context Protocol** itself: the tools, resources and prompts each server exposes, and
the JSON-RPC method semantics underneath. That protocol awareness is the difference.

## What they share

At a high level the two play the same role: a single, governed front door.

- **One entry point** in front of many backends, so clients don't wire up to each service directly.
- **Authentication and authorization** at the edge, before traffic reaches anything internal.
- **Rate limiting and quotas** to protect upstreams from overload or abuse.
- **Observability** — centralized logging, metrics and tracing across all traffic.
- **TLS termination** and a stable public surface that hides internal topology.

If MCP servers were just ordinary REST endpoints, a plain API gateway would largely suffice.

## Where they differ

They aren't. An MCP server speaks **JSON-RPC 2.0** and exposes **tools** (actions with JSON-Schema inputs),
**resources** (read-only data) and **prompts** (templates). A generic API gateway sees these as opaque POST
bodies to a single endpoint — it cannot tell one tool call from another, so its policy vocabulary stops at
the HTTP layer.

| Concern | API Gateway | MCP Gateway |
|---|---|---|
| Traffic model | HTTP paths and methods | JSON-RPC methods over MCP transports (stdio, Streamable HTTP, SSE) |
| Unit of policy | Route / endpoint | Individual **tool**, resource or prompt |
| Authorization | Per-route | **Per-tool** entitlements, often per team or user |
| Capability discovery | Static API spec | Live enumeration of a server's tools/resources/prompts |
| Tool-definition integrity | Not modeled | Detects silently changed tool schemas (rug-pull / tool poisoning) |
| Payload governance | Header/path rules | Inspect and redact tool arguments and results (secrets, PII) |
| Audit granularity | Request path | Which tool, which arguments, which caller |

## Why MCP needs its own gateway layer

The risks that matter for MCP live *inside* the JSON-RPC payload, where an HTTP gateway can't look. Two AI
clients hitting the same MCP endpoint may invoke wildly different tools — one reads a document, another
deletes records — and only a protocol-aware layer can authorize them differently. Likewise, a tool's
description and input schema are instructions the model trusts; if an upstream silently changes them, that is
a supply-chain attack an API gateway would never notice. Enforcing per-tool access, redacting sensitive
arguments, and verifying tool-definition integrity all require parsing MCP, not just HTTP. See
[MCP Tool Poisoning & Rug-Pull Attacks](/learn/mcp-tool-poisoning) and
[MCP Governance](/learn/mcp-governance).

## Not a replacement

An MCP gateway doesn't retire your API gateway; they operate at different layers and frequently coexist. The
API gateway continues to govern REST traffic across the organization, while the MCP gateway governs the
model-to-tool surface with the granularity MCP demands.

## How Kravn fits

[Kravn](/) is a purpose-built MCP gateway: it imports upstream servers' tools, resources and prompts into one
registry and re-exposes them behind governed endpoints with **per-team, per-tool** entitlements, argument
redaction and tamper-evident auditing — controls that operate on MCP semantics rather than raw HTTP. See
[What is an MCP Gateway?](/learn/what-is-an-mcp-gateway) and the [concepts guide](/guide/concepts).

## Related

- [What is an MCP Gateway?](/learn/what-is-an-mcp-gateway)
- [MCP Reverse Proxy](/learn/mcp-reverse-proxy)
- [MCP Authorization](/learn/mcp-authorization)
- [MCP Governance](/learn/mcp-governance)
