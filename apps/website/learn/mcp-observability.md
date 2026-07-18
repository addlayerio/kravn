---
title: MCP Observability & Auditing
description: "MCP observability means capturing traces, metrics and logs of every tool call — plus a tamper-evident audit trail of who called what, when and with what result."
---

# MCP Observability & Auditing

**MCP observability** is the practice of capturing traces, metrics and structured logs for every
Model Context Protocol interaction, while **MCP auditing** adds a tamper-evident record of *who* called
*which* tool, *when*, with what arguments and what result. Together they turn an opaque AI-to-tool
integration into a system you can debug, cost, secure and prove compliant.

## Why MCP is hard to observe

An MCP call is not an ordinary API request. A single user prompt can fan out into many tool invocations,
across several upstream servers, driven by a model's non-deterministic choices. Without instrumentation you
cannot answer basic questions: which tool was slow, why a call failed, how much a workflow cost, or whether
a model reached data it should not have. Observability makes that flow legible; auditing makes it
accountable.

## The four signals

- **Traces** — a distributed trace follows one request from the client, through the gateway, to each
  upstream MCP server and back. Spans show tool name, latency, and where errors occurred. **OpenTelemetry**
  is the vendor-neutral standard, so traces flow into Jaeger, Tempo, Datadog or any OTLP backend you already
  run.
- **Metrics** — counters and histograms: calls per tool, error rates, p95 latency, token or cost usage per
  user or team. These drive dashboards, capacity planning and quota enforcement.
- **Logs** — structured, correlated log lines for each call, carrying the same trace and request IDs so you
  can pivot from a metric spike to the exact events behind it.
- **Audit trail** — a durable, append-only record of security-relevant events: identity, tool, arguments,
  outcome and timestamp. Unlike logs, an audit trail is designed to be complete and **tamper-evident**, so
  it can stand up to a security investigation or an auditor.

## Observability vs. auditing

They overlap but serve different masters. Observability is for *engineers*: it is sampled, high-volume,
and optimized for debugging and performance. Auditing is for *security and compliance*: it must be
complete (no sampling of sensitive actions), attributable to a real identity, and resistant to alteration.
A mature MCP deployment keeps both, because a trace tells you *how* a request behaved while an audit record
proves *that* it happened and who was responsible.

## What good instrumentation records

For every MCP call worth auditing, capture: the authenticated principal (user or service), the upstream
server and tool, a redacted view of the arguments, the result status, latency, and a correlation ID that
ties the audit entry back to the corresponding trace. Sensitive values — secrets, tokens, PII — should be
**redacted before storage**, so the record is useful without becoming a new liability.

## Where this pays off

- **Debugging** — reproduce a failing agent workflow by replaying its exact tool sequence.
- **Cost and usage** — attribute token and call volume to teams to control spend.
- **Security forensics** — after an incident, reconstruct precisely which tools an identity reached.
- **Compliance** — demonstrate to auditors that access to regulated systems is logged and reviewable.

## How Kravn fits

[Kravn](/) instruments every MCP call it proxies. It emits **OpenTelemetry** traces, metrics and logs to
your existing backends, and it keeps a **tamper-evident audit trail** of each call — identity, tool,
arguments and result — so debugging, cost analysis and compliance all draw from the same source of truth.
Because Kravn is [self-hosted](/learn/running-mcp-on-premise), that telemetry never leaves your perimeter.
See the [security guide](/guide/security) for how audit and access control fit together.

## Related

- [MCP Security](/learn/mcp-security)
- [MCP Governance](/learn/mcp-governance)
- [MCP for Regulated Industries](/learn/mcp-for-regulated-industries)
- [What is an MCP Gateway?](/learn/what-is-an-mcp-gateway)
