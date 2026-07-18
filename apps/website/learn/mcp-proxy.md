---
title: MCP Proxy
description: "An MCP proxy is an intermediary that brokers MCP traffic between clients and servers — a security boundary for credentials, policy and observability."
---

# MCP Proxy

An **MCP proxy** is an intermediary that sits between an AI client and one or more **MCP
servers** and brokers the traffic between them. The client connects to the proxy; the proxy
relays JSON-RPC 2.0 messages to the real server and returns the responses. That single point in
the path becomes where you enforce security, isolate credentials, observe activity, and bridge
transports.

## Why put a proxy in the path

Speaking to an MCP server directly works for one developer and one tool. The moment servers hold
real credentials or touch sensitive systems, a direct connection gives up too much control. A
proxy re-establishes it: the client no longer talks to the server, it talks to a boundary you
own — and everything that flows through can be inspected and governed.

## Security boundary and credential isolation

A proxy is a **trust boundary**. Upstream credentials — API keys, OAuth tokens — live on the
proxy, never on the client. A user authenticates to the proxy, and the proxy uses its own stored
secret to reach the upstream server. That keeps long-lived credentials off end-user machines,
lets you rotate them in one place, and means a compromised client never holds the keys to the
downstream system. For remote MCP servers, MCP defines an OAuth 2.1-based authorization flow; a
proxy is where those tokens are best held and refreshed.

## Observability

Because every request and response passes through it, a proxy is the natural place to record
them. It can log who called which tool, with what arguments, and what came back — producing the
audit trail and metrics an individual client cannot. See
[MCP Observability & Auditing](/learn/mcp-observability).

## Transport bridging

MCP runs over several transports: **stdio** for local subprocesses, **Streamable HTTP** for
remote servers, and **SSE** on older deployments. A proxy can bridge between them — for example,
wrapping a local stdio server so it is reachable over HTTP, or terminating a remote HTTP
connection and speaking stdio to a local process. That lets clients and servers interoperate
even when their native transports differ.

## Policy enforcement

Sitting inline, a proxy can do more than relay. It can **redact** secrets and PII from arguments
and results, **sanitize** content, block calls that violate rules, guard against
[prompt injection](/learn/mcp-security), and apply rate limits or quotas. Enforcement happens on
the wire, before a call reaches the upstream server or a response reaches the model.

## Proxy vs gateway

A proxy is the **traffic layer** — it moves and polices MCP messages. A
[gateway](/learn/what-is-an-mcp-gateway) is the larger product that wraps a proxy with a
[registry](/learn/mcp-registry), identity, and governance. Every MCP gateway contains a proxy,
but a bare proxy is not yet a gateway.

## How Kravn fits

[Kravn](/) acts as the proxy in front of your MCP servers. Clients connect to Kravn; it holds
upstream credentials (including an OAuth 2.1 client with DCR and PKCE), runs governance pipelines
that redact secrets and PII and guard against prompt injection, and writes a tamper-evident audit
trail of every call — all before traffic reaches the upstream server. See the
[security guide](/guide/security) and [key management](/guide/key-management).

## Related

- [MCP Reverse Proxy](/learn/mcp-reverse-proxy)
- [What is an MCP Gateway?](/learn/what-is-an-mcp-gateway)
- [MCP Security](/learn/mcp-security)
- [MCP Observability & Auditing](/learn/mcp-observability)
