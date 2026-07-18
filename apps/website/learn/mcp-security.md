---
title: MCP Security
description: "MCP security covers the threat model of connecting AI to real tools — prompt injection, tool poisoning, data exfiltration — and the controls that contain it."
---

# MCP Security

**MCP security** is the practice of connecting AI models to real tools and data without letting that
connection be abused. Because MCP servers can *act* — write records, send messages, reach internal
systems — the threat model is larger than for a read-only API, and it spans the model, the client, the
server and the data behind it.

## The MCP threat model

The risks worth planning for cluster into a handful of categories:

- **Prompt injection** — untrusted content (a web page, a document, a tool result) carries hidden
  instructions that steer the model into calling tools it shouldn't.
- **Tool poisoning and rug-pull** — a malicious or newly compromised server ships harmful instructions in
  a tool description, or silently changes a tool's behavior after you've approved it. See
  [MCP Tool Poisoning & Rug-Pull Attacks](/learn/mcp-tool-poisoning).
- **Over-broad tool permissions** — default-on access to destructive tools widens the blast radius of any
  single compromise.
- **Credential and secret leakage** — tokens, keys or PII flow through prompts, tool arguments or logs and
  end up somewhere they shouldn't.
- **Server-side SSRF** — a server that fetches URLs on the model's behalf is coerced into reaching
  internal metadata endpoints or other private services.
- **Data exfiltration** — sensitive data leaves the perimeter through an outbound tool call or an
  untrusted third-party server.
- **Unaudited actions** — an agent takes a consequential action with no durable record of who, what and
  when, leaving nothing to investigate after the fact.

## Identity and least privilege

The first line of defense is knowing *who* is calling and constraining *what* they can do.
[Authentication](/learn/mcp-authentication) verifies the caller; [authorization](/learn/mcp-authorization)
restricts them to the servers and tools they are explicitly entitled to. **Least privilege at the tool
level** is what makes the rest of the model tractable: if an identity can only reach `search`, a prompt
injection that tries to call `delete_record` simply has nothing to invoke.

## Inline controls: redaction and injection guards

Even a well-authorized call can carry something dangerous. Two controls sit in the request/response path:

- **Redaction** strips secrets and PII from tool arguments, results and logs before they propagate — so a
  leaked API key or customer record never reaches a model, a transcript or an audit trail.
- **Prompt-injection guards** inspect inbound content and tool results for embedded instructions and
  suspicious patterns, flagging or blocking the manipulation before the model acts on it.

## Network and egress controls

Server-side fetching is a classic SSRF vector, so outbound access should be **policy-controlled**: allow
only the destinations a server legitimately needs and deny reaching internal ranges or cloud metadata
endpoints. The strongest posture for regulated data is **no egress at all** — running the whole MCP
surface [on-premise](/learn/running-mcp-on-premise) so sensitive data and credentials never leave the
network in the first place.

## Auditing every action

Prevention is never perfect, so every consequential call needs a **tamper-evident audit trail**: who
called which tool, with what arguments, against which server, and what came back. Durable, verifiable
logs are what let you detect abuse, prove compliance and reconstruct an incident. See
[MCP Observability & Auditing](/learn/mcp-observability).

## How Kravn fits

[Kravn](/) applies these controls as a single governed layer. Its governance pipelines **redact secrets
and PII**, run a **prompt-injection guard**, and write a **tamper-evident audit** of every call; it adds
**tool-poisoning and rug-pull detection**, usage quotas, and identity-backed least privilege via
[authentication](/learn/mcp-authentication) and [authorization](/learn/mcp-authorization). Because it is
self-hostable with **no data egress**, sensitive traffic stays inside your perimeter. See the
[security guide](/guide/security) and [MCP Governance](/learn/mcp-governance).

## Related

- [MCP Authentication](/learn/mcp-authentication)
- [MCP Authorization](/learn/mcp-authorization)
- [MCP Governance](/learn/mcp-governance)
- [MCP Tool Poisoning & Rug-Pull Attacks](/learn/mcp-tool-poisoning)
