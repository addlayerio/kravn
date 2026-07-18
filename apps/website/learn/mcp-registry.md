---
title: What is an MCP Registry?
description: "An MCP registry is a central catalog of the tools, resources and prompts you expose — curated, versioned and composed into published endpoints."
---

# What is an MCP Registry?

An **MCP registry** is a central catalog — an inventory — of the **tools**, **resources** and
**prompts** an organization exposes to AI clients. Instead of every client discovering
capabilities from scattered servers, the registry is where those capabilities are collected,
curated, enabled or disabled, versioned, and composed into the endpoints you actually publish.

## Inventory of capabilities

When a client connects to an [MCP](/learn/what-is-model-context-protocol) server, it discovers
three kinds of capability: tools (actions with JSON-Schema inputs), resources (read-only data),
and prompts (reusable templates). A registry aggregates those from many upstream servers into a
single searchable list. It answers a question no individual server can: *across everything we
run, what capabilities exist, and where does each one come from?*

## Curate, enable, disable

Discovery is not the same as approval. A registry lets an operator decide what is actually
offered:

- **Curate** — review each imported tool, resource and prompt before it is made available.
- **Enable / disable** — turn a capability on or off centrally, without touching the upstream
  server, so a risky or deprecated tool can be pulled instantly.
- **Describe and annotate** — attach names, descriptions and metadata that clients see, giving
  the catalog a consistent vocabulary.

## Versioning and change control

Tool definitions are not static. An upstream server can silently change a tool's schema,
description or behavior between connections — the basis of
[tool-poisoning and rug-pull attacks](/learn/mcp-tool-poisoning). A registry that tracks the
version and fingerprint of each capability can detect when a definition changes and require
re-approval before the new version is served. That turns an invisible mutation into a reviewable
event.

## Composition into endpoints

The registry is also where capabilities are assembled into what clients consume. Rather than
exposing every upstream server wholesale, you compose selected tools, resources and prompts into
published [gateway](/learn/what-is-an-mcp-gateway) endpoints — for example, one endpoint scoped
to a team with only the tools that team is entitled to. The registry holds the mapping between
raw upstream capabilities and the governed endpoints built from them.

## Registry vs gateway vs proxy

A registry is the **inventory** layer. A [proxy](/learn/mcp-proxy) is the **traffic** layer that
brokers live MCP messages. A [gateway](/learn/what-is-an-mcp-gateway) is the product that binds a
registry and a proxy together with identity and governance. You need all three, but the registry
is what makes the set of exposed capabilities explicit and manageable.

## How Kravn fits

[Kravn](/) connects to upstream MCP servers and imports their tools, resources and prompts into a
single registry. From there you curate what is exposed, enable or disable individual tools, and
compose them into governed endpoints with per-team entitlements. Kravn also fingerprints tool
definitions to detect [rug-pull changes](/learn/mcp-tool-poisoning), and ships a catalog of 100+
public MCP servers plus native SharePoint, Teams, Jira and Confluence to populate the registry
quickly. See [Kravn concepts](/guide/concepts) and [integrations](/integrations).

## Related

- [What is MCP?](/learn/what-is-model-context-protocol)
- [What is an MCP Gateway?](/learn/what-is-an-mcp-gateway)
- [MCP Tool Poisoning & Rug-Pull Attacks](/learn/mcp-tool-poisoning)
- [MCP Best Practices](/learn/mcp-best-practices)
