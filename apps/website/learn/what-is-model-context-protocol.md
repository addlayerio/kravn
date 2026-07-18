---
title: What is the Model Context Protocol (MCP)?
description: "The Model Context Protocol (MCP) is an open standard that lets AI models call external tools, data and prompts through one uniform interface."
---

# What is the Model Context Protocol (MCP)?

The **Model Context Protocol (MCP)** is an open standard that lets AI applications connect to external
tools, data sources and prompts through **one uniform interface**. Instead of hand-wiring every model to
every system, an app speaks MCP to any number of **MCP servers**, each of which exposes its capabilities in
a predictable, machine-readable way. MCP was introduced by Anthropic and is now implemented across many AI
clients and platforms.

## Why MCP exists

Before MCP, every integration between an AI model and an external system was bespoke: a custom function,
a custom schema, a custom auth flow. That does not scale — *N* models times *M* systems is *N×M* pieces of
glue. MCP turns that into *N+M*: each client speaks MCP once, each system exposes MCP once, and they
interoperate. It is often described as "a USB-C port for AI" — a single connector standard.

## The core concepts

An MCP server can expose three kinds of capability, and a client discovers them at connection time:

- **Tools** — actions the model can invoke (query a database, create a ticket, send a message). Each tool
  has a name, a description and a JSON-Schema for its inputs.
- **Resources** — read-only data the model can pull in as context (a file, a record, a document).
- **Prompts** — reusable, parameterized prompt templates the server offers to the client.

Communication is **JSON-RPC 2.0**. A client connects, negotiates capabilities, lists what the server
offers, and then calls tools or reads resources on demand.

## How MCP is transported

MCP runs over a few transports, chosen by how the server is deployed:

- **stdio** — the server runs as a local subprocess; messages go over standard input/output. Common for
  local, single-user tools.
- **Streamable HTTP** — the current standard for remote servers: a single HTTP endpoint, with streaming for
  long-running responses.
- **SSE (Server-Sent Events)** — an earlier remote transport still widely deployed.

## Authentication and security

Remote MCP servers that expose sensitive systems need **authorization**. MCP defines an OAuth 2.1-based
authorization flow, so a client obtains a token and presents it to the server. In an organization, that
raises the real questions this Learn section covers: *who* is allowed to reach *which* server and *which*
tools, how tokens are issued and stored, and how every call is governed and audited. See
[MCP Authentication](/learn/mcp-authentication), [MCP Authorization](/learn/mcp-authorization) and
[MCP Security](/learn/mcp-security).

## MCP in an organization

A single developer can point their AI client at one MCP server and be productive in minutes. An
**organization** has a harder problem: dozens of servers, many users and teams, corporate identity,
compliance rules, and data that cannot leave the network. That is where an
[MCP Gateway](/learn/what-is-an-mcp-gateway) comes in — a single governed surface that fronts many upstream
MCP servers, applies identity and policy, and keeps an audit trail.

## How Kravn fits

[Kravn](/) is a self-hostable **MCP gateway, registry and proxy**. It connects to upstream MCP servers,
imports their tools, resources and prompts into one registry, and re-exposes them behind governed endpoints
— integrated with your identity stack, with no data leaving your perimeter. If you are adopting MCP beyond
a single laptop, that is the layer you will want.

## Related

- [What is an MCP Gateway?](/learn/what-is-an-mcp-gateway)
- [What is an MCP Registry?](/learn/mcp-registry)
- [Enterprise MCP Architecture](/learn/enterprise-mcp-architecture)
- [MCP Best Practices](/learn/mcp-best-practices)
