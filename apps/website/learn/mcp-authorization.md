---
title: MCP Authorization
description: "MCP authorization decides what an authenticated identity may reach — which MCP servers and which individual tools — using RBAC, teams and least privilege."
---

# MCP Authorization

**MCP authorization** decides *what* an already-authenticated identity is allowed to reach: which MCP
servers, and which individual tools within them. Authentication proves who is calling; authorization
turns that identity into a concrete allow-or-deny decision on every request.

## Authorization vs authentication

Authorization only runs *after* an identity is established. [Authentication](/learn/mcp-authentication)
answers "who is this?" and produces a verified user or service; authorization answers "what may this
identity do?" Conflating them is a common security mistake — a valid token proves identity, not
entitlement. A well-designed MCP surface always makes the second decision explicitly, per call, using the
identity the first step produced.

## Why tool-level granularity matters

An MCP server rarely exposes a single capability. One server might offer a read-only `search` tool
alongside a destructive `delete_record` or a `send_email` tool. Authorizing access at the *server* level
is too coarse — granting the server grants everything it exposes. Real least privilege means deciding at
the **tool** level: an identity may be allowed `search` but denied `delete_record` on the very same
server. Effective MCP authorization operates on individual tools, not just whole servers.

## RBAC, teams and entitlements

The scalable way to express "what may this identity do" is not per-user rules but **roles and teams**:

- **RBAC (role-based access control)** attaches permissions to roles, and identities inherit them by role
  — so policy is expressed once and applied consistently.
- **Teams** group users and carry their own entitlements: a team is granted access to a specific set of
  MCP servers and tools, and members inherit that grant.
- **Per-team, per-tool entitlements** are the unit of decision — team X may use tools A and B on server S,
  but not tool C.

This keeps authorization auditable and reviewable: you reason about a handful of teams and roles instead
of thousands of individual grants.

## Least privilege by default

The safe default is **deny**: an identity reaches only the servers and tools it has been explicitly
entitled to, and nothing else. New servers and newly discovered tools are not automatically exposed to
everyone. Least privilege limits blast radius — if a client, token or agent is compromised, the attacker
inherits only that identity's narrow entitlements rather than the full catalog. Broad, default-on tool
access is one of the most common and most dangerous MCP misconfigurations.

## The "filter, never a grant" principle

A subtle but critical rule: when you scope an **agent** or an **endpoint** to a set of tools, that scope
must be a **filter over what the user is already entitled to — never a grant**. In other words, narrowing
an endpoint to three tools can only *remove* access, never *add* it. The effective permission is always
the intersection of the user's entitlements and the endpoint's tool list. If scoping an endpoint could
grant a user a tool they were not otherwise entitled to, an attacker could escalate privilege simply by
choosing a differently-scoped endpoint. Authorization must be evaluated against the user's own
entitlements every time, with endpoint and agent scopes acting only to restrict.

## How Kravn fits

[Kravn](/) implements exactly this model. It supports **RBAC, teams, and per-team MCP and tool
entitlements**, so you express access once and apply it consistently. Crucially, an agent's or endpoint's
tool list in Kravn is a **filter over what a user is already entitled to, never a grant** — scoping can
only narrow, never escalate. Combined with [authentication](/learn/mcp-authentication), that gives you
end-to-end control over who reaches what. See the [concepts guide](/guide/concepts) and
[security guide](/guide/security).

## Related

- [MCP Authentication](/learn/mcp-authentication)
- [MCP Security](/learn/mcp-security)
- [MCP Governance](/learn/mcp-governance)
- [Kravn concepts](/guide/concepts)
