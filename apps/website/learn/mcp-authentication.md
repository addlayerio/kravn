---
title: MCP Authentication
description: "MCP authentication proves who is calling — via the OAuth 2.1 flow for remote servers and enterprise SSO — before any authorization decision is made."
---

# MCP Authentication

**MCP authentication** is how a client and server establish *who* is making a request before any tool
runs. Local MCP servers trust the process that launched them; remote MCP servers need a real credential,
and the Model Context Protocol defines an **OAuth 2.1-based authorization flow** to obtain one.

## Authentication vs authorization

These two words are often blurred, but they answer different questions. **Authentication** establishes
*who* an identity is — a verified user or a service. **Authorization** decides *what* that identity is
allowed to reach once verified. Authentication comes first and produces an identity; authorization
consumes that identity to make an allow-or-deny decision. This page covers the first half; see
[MCP Authorization](/learn/mcp-authorization) for the second.

## The MCP OAuth 2.1 flow for remote servers

Remote MCP servers that front sensitive systems must not accept anonymous calls. MCP standardizes an
OAuth 2.1-based flow so a client can obtain and present an access token:

- **Authorization server metadata discovery** — the client discovers the server's authorization endpoints
  from well-known metadata rather than hard-coded configuration.
- **Dynamic client registration (DCR)** — a client can register itself with the authorization server on
  the fly, so new clients do not require manual credential provisioning.
- **PKCE (Proof Key for Code Exchange)** — the authorization-code exchange is bound to a one-time secret,
  which defeats code-interception attacks on public clients.
- **Access tokens** — the client presents a bearer token on each request; the server validates it before
  serving tools, resources or prompts.

The result is that a remote server can verify the caller without inventing a bespoke login for every
integration — the same standard every MCP client can speak.

## Enterprise SSO and provisioning

OAuth against one server proves a client holds a token, but an organization needs those identities to be
*its* identities. In practice that means fronting MCP with corporate identity:

- **SAML and OAuth2/OIDC single sign-on** authenticate users against the existing identity provider, so
  MCP access follows the same login, MFA and session policy as the rest of the business.
- **SCIM 2.0 provisioning** keeps user and group membership in sync automatically — when someone joins,
  moves team or leaves, their MCP access changes without manual work.

This is what turns "a token for a server" into "a governed corporate identity that can be revoked
centrally."

## User identity vs service identity

Not every caller is a person. A **user identity** represents a human acting through an AI client and
carries that person's entitlements and audit trail. A **service identity** represents an automated agent
or backend with no human in the loop. Both must authenticate, but they are governed differently: service
identities typically get narrow, long-lived-but-rotatable credentials, while user identities inherit
interactive SSO and session controls. Keeping the two distinct is what lets you audit *who* — a real
person or a named service — did something.

## The gateway as a single authentication point

Wiring OAuth, SSO and provisioning into every MCP server individually does not scale and drifts out of
sync. The durable pattern is a single authentication surface: clients authenticate **once** against one
gateway, which verifies identity and then brokers credentials to upstream servers on the caller's behalf.
One place to configure identity, one place to revoke it, one consistent audit trail.

## How Kravn fits

[Kravn](/) is that single authentication surface. It integrates with **SAML and OAuth2/OIDC SSO** and
**SCIM 2.0** for provisioning, so MCP identities are your corporate identities. As an **upstream OAuth 2.1
client** it performs discovery, dynamic client registration and PKCE against remote servers for you, and
its token interceptor attaches the right `Authorization` and tenant headers on each call — all self-hosted,
with no data leaving your perimeter. See [MCP Authorization](/learn/mcp-authorization) for what happens
after identity is established, and the [security guide](/guide/security).

## Related

- [MCP Authorization](/learn/mcp-authorization)
- [MCP Security](/learn/mcp-security)
- [What is an MCP Gateway?](/learn/what-is-an-mcp-gateway)
- [Kravn security guide](/guide/security)
