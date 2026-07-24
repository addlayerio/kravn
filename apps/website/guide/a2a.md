---
title: Agent-to-agent (A2A)
description: "Kravn speaks A2A in both directions — consume remote agents as governed tools, and publish your own agents to the ecosystem under identity, entitlements and audit. The same governance plane, applied to the horizontal axis."
---

# Agent-to-agent (A2A)

[MCP](/guide/what-is-kravn) connects an agent to **tools** (the vertical axis). [A2A](https://a2a-protocol.org)
— the Agent2Agent protocol, now under the Linux Foundation — connects an agent to **other agents** (the
horizontal axis). They compose: A2A routes a task to the right specialist agent; MCP gives that agent its
context and tools.

Both protocols have the **same blind spot**: neither expresses identity, entitlements, redaction or an audit
trail. That gap is exactly what Kravn fills. Kravn is the governance plane for agent interoperability —
**MCP for tools, A2A for agents, one control plane**. Nothing leaves your perimeter.

Kravn speaks A2A in **both directions**.

## Consume a remote A2A agent (client)

Register a partner's or an internal team's A2A agent the same way you add any other server: under
**MCP Servers → Add**, choose the **A2A agent** transport and paste the agent's base or Agent Card URL.

Kravn fetches the [Agent Card](https://a2a-protocol.org) (`/.well-known/agent-card.json`), bridges each of
its **skills into your tool registry as a tool**, and from then on the remote agent is just another governed
capability:

- It composes into **MCP endpoints** and is granted to **teams** like any other tool.
- Every delegation runs through your **governance pipelines** (secret/PII redaction, prompt-injection guard,
  approval gates, cost budgets) and lands in the **audit trail**.
- Your existing MCP clients (Claude, your chat client, anything) can delegate to it **with no changes** — the
  A2A agent shows up as a tool that takes a `message`. Kravn sends `message/send`, tracks the task lifecycle,
  and returns the result.

Authentication (bearer, basic or full **OAuth 2.1** with automatic refresh) and per-server TLS/mTLS are
reused from the MCP upstream machinery — an authenticated remote agent needs no special handling.

## Publish Kravn as an A2A agent (server)

Turn Kravn into a governed A2A endpoint so **other agents can delegate tasks to yours**. Enable it under
**Settings → Agent-to-agent (A2A)**; it is **off by default** — publishing an A2A surface is an explicit
opt-in.

Once enabled, Kravn exposes:

- **`GET /.well-known/agent-card.json`** — a discovery [Agent Card](https://a2a-protocol.org) listing the
  skills you expose (your org **agents**, and optionally your **MCP endpoints**). Restricted skills are hidden
  from anonymous discovery.
- **`POST /a2a`** — the A2A **JSON-RPC 2.0** endpoint (`message/send`, `message/stream` over SSE, `tasks/get`,
  `tasks/cancel`, `tasks/resubscribe`, and `tasks/pushNotificationConfig/*` for async webhook delivery).

Every inbound task is **governed end to end**:

1. **Authenticated** — a Kravn access token or an OAuth 2.1 mcp-scoped token (the same tokens the MCP data
   plane accepts); gated by the `a2a.invoke` permission.
2. **Entitlement-checked** — the caller may only reach agents/endpoints they are granted (`canUseAgent` /
   team membership). Being a platform admin does **not** grant use — this is the data plane, not the console.
3. **Executed under governance** — the task runs as one chat turn as the caller, so the **model allowlist**,
   **daily token budget**, **DLP on input**, and **per-tool audit** all apply. An agent's tools are re-filtered
   against the caller's own live entitlement — a delegation is a filter, never a grant.
4. **Audited** — every task create / complete / fail / cancel is written to the tamper-evident audit trail
   under the `a2a` category, with the caller, the skill, and the linked conversation. See
   [MCP governance](/learn/mcp-governance) for how the same controls apply everywhere.

Callers select a skill via `message.metadata["kravn/skillId"]` (Kravn's own A2A client sets this
automatically); with a single accessible skill it is used by default.

## The 8-state task lifecycle

A2A tasks are asynchronous and stateful — `submitted → working → input-required / auth-required →
completed / canceled / failed / rejected`. Kravn persists each transition, so `tasks/get` and
`tasks/resubscribe` work across replicas, `message/stream` streams status and artifact updates over SSE,
and a registered push webhook is notified when a task finishes. The full lifecycle lives in the **A2A**
page of the operator, alongside the published Agent Card and the recent-task feed.

## Where it fits

A2A is newer and less widely adopted than MCP — Kravn keeps the MCP gateway as the hero and treats A2A as
its horizontal sibling. If your agents already speak MCP, you get the client bridge essentially for free;
turn on the server side when you have a concrete peer to interoperate with. Either way, the governance is
the same one you already configured — identity, entitlements, redaction and audit — now covering
agent-to-agent traffic too.
