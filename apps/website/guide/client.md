---
title: The Governed Client
description: "Kravn's end-user client is just another consumer of the gateway's governed surface — people chat over company tools, filtered by their own entitlements."
---

# The Governed Client

Kravn is, first and foremost, an [MCP gateway](/guide/what-is-kravn): it connects to your upstream MCP
servers, imports their tools, resources and prompts into one registry, and re-exposes them behind a single
governed, identity-aware surface. The **client** is not a second product — it's the first-party consumer of
that surface, and the place where all the [governance](/learn/mcp-governance) you configured on the gateway
quietly pays off.

## Downstream of the gateway, by design

The client is its own deployable — a chat app with SSO login — but it holds no privileges of its own. It
points at the same gateway the way an external agent would, honours the same
[authorization](/learn/mcp-authorization) model, and never touches the MCP data plane. Every tool a user
sees is a tool the gateway already decided that user may reach. The gateway stays the single point of
control; the client is simply the surface where that control becomes daily work.

## What people do here

Users sign in through the same SSO — SAML or OAuth2/OIDC — that guards the rest of Kravn, and land in an app
built for everyday work over **your** company's governed tools, not a public chatbot:

- **Conversations** — chat with a model, and the model calls real corporate tools through the gateway, with
  memory, a web-search toggle and file attachments.
- **Projects** — pin a curated set of tools, a default model and documents, then share the workspace with
  users or teams.
- **Org agents** — an admin defines a preset once (instructions + model + tools) and shares it with teams or
  users, so a vetted way of working spreads without everyone reconfiguring it.
- **Scheduled tasks** — let an agent run on a cadence against the same governed surface and report back.

## A filter, never a grant

This is the load-bearing rule that keeps the client strictly subordinate to the gateway: **nothing in it can
widen access.** When an admin pins tools to a project or an org agent, they are *narrowing* what's available
inside that workspace — a project or agent can only ever offer a subset of what a user already holds through
their gateway entitlements, never a tool they aren't entitled to.

And it isn't a one-time check at setup. Entitlements are re-evaluated on **every turn**, against live gateway
state. Revoke a team's access to a tool and the next message in an existing conversation — or the next
scheduled run of an agent shared org-wide — can no longer reach it. The client can never become a side door
around your policy, because it holds no authority of its own; it borrows the gateway's, every single time. If
the gateway says no, the client says no.

## Why it matters

The hard part of enterprise AI was never the chat window — it was making tool access safe enough to hand out.
Because the gateway already solved that, the client is the payoff: proof that a properly governed surface is
one your people can actually *use*, not just audit.

Start with the gateway. See [what Kravn is](/guide/what-is-kravn), how it handles
[authorization](/learn/mcp-authorization) and [governance](/learn/mcp-governance), or head back to the
[overview](/).
