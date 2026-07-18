---
title: Enterprise MCP Architecture
description: "A reference architecture for MCP at scale — AI clients through a gateway to upstream servers, with identity, governance, audit and a firm data boundary."
---

# Enterprise MCP Architecture

**Enterprise MCP architecture** is the layered design that lets many AI clients use many **MCP servers**
safely at scale. The shape is consistent: AI clients connect to a central **MCP gateway**, which fronts the
upstream MCP servers and applies identity, policy and auditing in between — so control lives in one governed
layer rather than in each client or server.

## The request path

At the core is a simple three-tier flow:

**AI clients → MCP gateway → upstream MCP servers.**

Clients (IDE assistants, chat apps, agents) never talk to upstream servers directly. They connect to the
gateway over an MCP transport — **Streamable HTTP** or **SSE** for remote clients, **stdio** for local ones —
and the gateway parses the **JSON-RPC 2.0** traffic, decides what is allowed, and forwards permitted calls to
the right server. Upstreams expose **tools**, **resources** and **prompts**; the gateway imports these into a
single registry so clients see one coherent catalog instead of a sprawl of endpoints.

## The identity plane

Every request must be tied to a real principal. The identity plane connects the gateway to corporate SSO —
**SAML** or **OAuth2/OIDC** — and provisions users and groups via **SCIM 2.0**. On top of that sits
**RBAC**: users belong to teams, and each team is granted access to specific MCP servers and specific tools.
The result is that "who can call this tool" is answered by the same directory that governs the rest of the
enterprise, not by ad-hoc config on individual servers. See [MCP Authentication](/learn/mcp-authentication)
and [MCP Authorization](/learn/mcp-authorization).

## The policy and governance plane

Authorization decides *whether* a call proceeds; the governance plane decides *how*. Because the gateway
understands MCP semantics, it can inspect and transform traffic in flight:

- **Redaction** of secrets and PII from tool arguments and results before they cross a boundary.
- **Prompt-injection guarding** on untrusted content flowing back to the model.
- **Tool-definition integrity** checks that catch silently changed tool schemas — the
  [tool-poisoning and rug-pull](/learn/mcp-tool-poisoning) supply-chain risk.
- **Usage quotas** and cost budgets so a runaway agent can't exhaust an upstream.

Where duties must be separated, **SoD / maker-checker** approvals gate sensitive changes. See
[MCP Governance](/learn/mcp-governance).

## The audit plane

Everything the gateway does is recorded. A **tamper-evident audit** trail captures which principal invoked
which tool, with which arguments, against which server, and what came back — the granularity that regulated
environments require and that a plain HTTP log cannot provide. Centralizing audit at the gateway means one
consistent record instead of fragments scattered across servers. See
[MCP Observability & Auditing](/learn/mcp-observability).

## High availability and the data boundary

For production, the gateway runs as multiple stateless replicas behind a load balancer, backed by a
replicated datastore, so no single node is a point of failure; disaster-recovery planning covers backup and
restore of that state. Equally important is the **data boundary**: a self-hosted gateway keeps model-to-tool
traffic inside your network, so sensitive arguments and results never egress to a third party. That boundary
is often the deciding factor for [regulated industries](/learn/mcp-for-regulated-industries).

## How Kravn fits

[Kravn](/) implements this reference architecture as a single self-hostable component: a gateway, registry
and proxy with SSO/SCIM identity, per-team and per-tool entitlements, governance pipelines and tamper-evident
audit — deployable via one-command Docker Compose or Helm, with no data egress. See
[What is Kravn](/guide/what-is-kravn) and [Enterprise-relevant concepts](/guide/concepts).

## Related

- [What is an MCP Gateway?](/learn/what-is-an-mcp-gateway)
- [Running MCP On-Premise](/learn/running-mcp-on-premise)
- [Deploying MCP in Kubernetes](/learn/deploying-mcp-in-kubernetes)
- [MCP for Regulated Industries](/learn/mcp-for-regulated-industries)
