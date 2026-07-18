---
title: Learn — Model Context Protocol for the enterprise
description: "Plain-language guides to the Model Context Protocol — MCP gateways, security, authentication, governance, and running MCP on-premise."
---

# Learn: the Model Context Protocol for the enterprise

Clear, vendor-neutral guides to the **Model Context Protocol (MCP)** and what it takes to run it in a real
organization — the architecture, the security model, and the operational choices. Start with the
fundamentals, then dig into security, governance and deployment.

## Fundamentals

- [**What is the Model Context Protocol (MCP)?**](/learn/what-is-model-context-protocol) — the open standard for connecting AI models to tools and data.
- [**What is an MCP Gateway?**](/learn/what-is-an-mcp-gateway) — one governed surface in front of many MCP servers.
- [**What is an MCP Registry?**](/learn/mcp-registry) — cataloguing and curating the tools, resources and prompts you expose.
- [**MCP Proxy**](/learn/mcp-proxy) — how a proxy brokers, secures and observes MCP traffic.
- [**MCP Reverse Proxy**](/learn/mcp-reverse-proxy) — fronting internal MCP servers with a single controlled entry point.
- [**MCP Gateway vs API Gateway**](/learn/mcp-vs-api-gateway) — what's the same, what's different, and why MCP needs its own layer.

## Security & governance

- [**MCP Authentication**](/learn/mcp-authentication) — proving *who* is calling, with SSO, OAuth 2.1 and tokens.
- [**MCP Authorization**](/learn/mcp-authorization) — deciding *what* each identity may reach, down to the tool.
- [**MCP Security**](/learn/mcp-security) — the threat model and the controls that address it.
- [**MCP Governance**](/learn/mcp-governance) — policy, redaction, approvals and a tamper-evident audit trail.
- [**MCP Tool Poisoning & Rug-Pull Attacks**](/learn/mcp-tool-poisoning) — how malicious tool definitions attack agents, and how to defend.

## Enterprise & operations

- [**Enterprise MCP Architecture**](/learn/enterprise-mcp-architecture) — a reference architecture for MCP at scale.
- [**MCP for Regulated Industries**](/learn/mcp-for-regulated-industries) — adopting MCP under banking, healthcare and public-sector constraints.
- [**MCP Observability & Auditing**](/learn/mcp-observability) — tracing, metrics and audit for every MCP call.
- [**Running MCP On-Premise**](/learn/running-mcp-on-premise) — keeping prompts, context and data inside your perimeter.
- [**Deploying MCP in Kubernetes**](/learn/deploying-mcp-in-kubernetes) — running an MCP gateway on your own cluster.
- [**MCP Best Practices**](/learn/mcp-best-practices) — a practical checklist for adopting MCP safely.

---

Building this in your own organization? [Kravn](/) is a self-hostable MCP gateway, registry and proxy that
puts these ideas into practice — on your infrastructure, plugged into your identity stack, with nothing
leaving your perimeter. [Get started](/guide/getting-started) or [see how it compares](/comparison).
