---
title: MCP Reverse Proxy
description: "An MCP reverse proxy is a single controlled entry point in front of internal MCP servers, handling TLS, authentication, SSRF protection and logging."
---

# MCP Reverse Proxy

An **MCP reverse proxy** is a single controlled entry point placed in front of one or more internal
**MCP servers**. Clients connect only to the proxy; the proxy authenticates them, forwards permitted
JSON-RPC traffic to the right upstream server, and returns the response — while the internal servers stay
hidden from the outside world.

## Reverse proxy vs forward proxy

The two are easy to confuse. A **forward proxy** sits in front of *clients* and mediates their outbound
requests to arbitrary destinations — it protects and controls who is making calls. A **reverse proxy** sits
in front of *servers* and mediates inbound requests to a fixed, known set of backends — it protects and
controls what is being reached. For MCP, the interesting problem is almost always the reverse case: many AI
clients need governed access to a defined set of internal tool servers, and those servers must not be
exposed directly.

## What a reverse proxy centralizes

Putting a reverse proxy in front of your MCP servers moves several concerns out of each individual server
and into one place:

- **TLS termination** — the proxy presents the certificate and terminates HTTPS once, so upstream servers
  don't each need their own public TLS setup.
- **Authentication** — clients authenticate to the proxy (for example with an OAuth 2.1 access token) before
  any request is forwarded. Servers behind it can trust that traffic is already vetted.
- **SSRF protection** — because the proxy holds the fixed list of allowed upstreams, a client cannot coax it
  into reaching arbitrary internal hosts. Requests to anything outside the known backend set are refused.
- **Topology hiding** — the internal addresses, ports and count of MCP servers are never revealed to clients.
  They see one endpoint; the wiring behind it can change without breaking anyone.
- **Centralized logging** — every request and response passes through one chokepoint, so access logs, metrics
  and audit records are collected uniformly instead of scattered across servers.

## Why MCP servers benefit specifically

MCP servers expose **tools** (actions with JSON-Schema inputs), **resources** (read-only data) and
**prompts**, all over **JSON-RPC 2.0**. Many are small processes originally built for a single developer over
**stdio**, with no notion of corporate identity, TLS or rate limiting. A reverse proxy lets you keep those
servers simple and un-exposed while still meeting production requirements: the security surface lives in one
audited component instead of being reimplemented — often inconsistently — in every server.

## Beyond plain proxying

A generic reverse proxy (nginx, Envoy) forwards bytes without understanding MCP. It can terminate TLS and
check a token, but it cannot see that a JSON-RPC call is invoking a *specific tool*, cannot enforce per-tool
authorization, and cannot verify that a tool definition hasn't silently changed. An **MCP-aware** reverse
proxy parses the protocol, which is what makes per-tool policy, redaction and tamper-evident auditing
possible. See [MCP Gateway vs API Gateway](/learn/mcp-vs-api-gateway) for where that line falls.

## How Kravn fits

[Kravn](/) acts as an MCP-aware reverse proxy: AI clients connect to Kravn, and Kravn forwards vetted calls
to upstream MCP servers with no data leaving your perimeter. Because it parses JSON-RPC rather than blindly
tunneling it, it can terminate TLS, authenticate against your identity provider, restrict which upstreams are
reachable, and log every call centrally. See [What is an MCP Gateway?](/learn/what-is-an-mcp-gateway) and the
[security guide](/guide/security).

## Related

- [MCP Proxy](/learn/mcp-proxy)
- [MCP Gateway vs API Gateway](/learn/mcp-vs-api-gateway)
- [What is an MCP Gateway?](/learn/what-is-an-mcp-gateway)
- [MCP Security](/learn/mcp-security)
