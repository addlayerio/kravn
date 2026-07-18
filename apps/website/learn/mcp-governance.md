---
title: MCP Governance
description: "MCP governance applies policy at each step of a tool call: redaction, injection guards, approvals, quotas and a tamper-evident audit trail."
---

# MCP Governance

**MCP governance** is the layer that shapes and records what actually happens when an AI agent uses
Model Context Protocol tools. Where authorization decides *whether* a call is allowed, governance sits on
the call itself — redacting secrets, sanitizing content, blocking prompt injection, requiring human
approval for sensitive actions, enforcing quotas, and writing a tamper-evident audit trail.

## Governance is not authorization

It is easy to conflate the two, but they answer different questions. **Authorization** is a gate: *is this
identity permitted to reach this server and this tool?* Once the answer is yes, the call proceeds — and a
plain yes/no gate has nothing to say about the *contents* of the request or the response. **Governance** is
what happens next: the request and its result pass through policy that can transform them, hold them for
approval, count them against a budget, and record exactly what occurred. Authorization decides access;
governance shapes and records the action. A serious MCP deployment needs both.

## Policy at each lifecycle junction

An MCP call has natural junctions — a client lists tools, invokes one with arguments, the server returns a
result. Governance attaches policy at each of them:

- **Secret and PII redaction** — strip API keys, tokens, account numbers and personal data out of
  arguments and results before they are logged or returned, so sensitive values never leak into a
  transcript or a downstream model.
- **Content sanitization** — normalize or neutralize tool output (untrusted HTML, control characters,
  embedded markup) before it re-enters the model's context.
- **Prompt-injection guards** — inspect tool descriptions and returned content for instructions that try
  to hijack the agent, and block or flag them.
- **Human approval (maker-checker)** — route high-impact tool calls to a second person for sign-off before
  they execute, so no single actor can trigger a sensitive action alone.
- **Usage quotas** — cap calls per user, per team or per endpoint to contain runaway loops and cost.

## Governance pipelines and hooks

The clean way to implement this is as **composable hooks** at each junction rather than one monolithic
checkpoint. Each policy is a small, ordered step in a pipeline: a request pipeline runs before the upstream
server sees the call, a response pipeline runs before the result reaches the model. Because steps are
composable, a team can enable redaction and injection scanning everywhere, add maker-checker only on the
tools that write or move money, and set quotas per endpoint — without rewriting the gateway. Policy becomes
configuration, not a fork.

## The tamper-evident audit trail

Governance is only credible if it is provable. Every decision — what was called, by whom, with which
arguments (redacted), what policy fired, what was returned, who approved it — is recorded in an
append-only, **tamper-evident** log. That record is what lets an auditor reconstruct an incident, satisfy a
regulator, or answer "which agent touched this system last Tuesday, and did a human approve it?" Without it,
you have controls you cannot demonstrate.

## How Kravn fits

[Kravn](/) implements governance as composable hook plugins at each MCP lifecycle junction. The same
pipeline can redact secrets and PII, sanitize content, guard against prompt injection, require
[maker-checker approvals](/guide/security) for sensitive tools, and enforce per-user and per-endpoint
quotas — all while writing a tamper-evident audit trail and keeping data inside your perimeter. It turns raw
MCP access into governed, recorded action. See the [Security guide](/guide/security) and
[Kravn concepts](/guide/concepts) for how the pieces fit.

## Related

- [MCP Authorization](/learn/mcp-authorization)
- [MCP Security](/learn/mcp-security)
- [MCP Observability & Auditing](/learn/mcp-observability)
- [MCP Tool Poisoning & Rug-Pull Attacks](/learn/mcp-tool-poisoning)
