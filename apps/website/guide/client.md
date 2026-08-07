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
- **Automations** — an agent plus an instruction, started by a trigger instead of a person: on a schedule, or
  by an inbound event. See below.

## A filter, never a grant

This is the load-bearing rule that keeps the client strictly subordinate to the gateway: **nothing in it can
widen access.** When an admin pins tools to a project or an org agent, they are *narrowing* what's available
inside that workspace — a project or agent can only ever offer a subset of what a user already holds through
their gateway entitlements, never a tool they aren't entitled to.

And it isn't a one-time check at setup. Entitlements are re-evaluated on **every turn**, against live gateway
state. Revoke a team's access to a tool and the next message in an existing conversation — or the next
automated run of an agent shared org-wide — can no longer reach it. The client can never become a side door
around your policy, because it holds no authority of its own; it borrows the gateway's, every single time. If
the gateway says no, the client says no.

## Automations: the same agent, started by something other than a person

An **automation** is an agent, an instruction, and a trigger. Nothing else — there is no canvas, no nodes, no
field mapping. You pick the agent (which carries its own instructions and its own filtered set of tools), write
what you want done in a sentence, and choose what starts it:

- **By time** — a cron expression or a one-off date.
- **By event** — an inbound webhook. Each automation gets its own URL (`/api/hooks/<token>`); you paste it into
  any system that can call a URL, and the request body becomes the event the agent reacts to.

The point is that the *authoring* is a sentence, not a flow. "When a record is created over there, look up what
it relates to and fill in the missing field" is one automation with two tools behind it — the kind of thing that
is a multi-step diagram anywhere else. Nothing about it is tied to a particular product: if it can send a
webhook, it can start an automation, and whatever tools the agent holds are what it can act on.

### Shaping the event — starting from what actually arrived

You cannot write a rule for a payload you have never seen, and you cannot see one until the sender has fired.
So Kravn keeps **the last events received at that URL** — including the ones it filtered out or that arrived
while the automation was paused — and the editor builds the rule from them:

1. Save the automation and paste its URL into the sending system.
2. Do one action there — whatever makes that system fire.
3. Come back: the event is listed, with every field of its body laid out and searchable.
4. Click **Filter** on a field to say "only run when this has this value", or **Tell** to include it in what
   the agent is told. Both write into the boxes below, which stay fully editable.

That turns two fields that used to demand knowledge of someone else's JSON schema into pointing at real data.
It is also the answer to *"why didn't my automation run"* — a dropped delivery is stored with the exact
condition that dropped it.

The three controls themselves:

- **Run only for some events** — one `path=value` condition per line (use `!=` to negate); all must match or
  the delivery is acknowledged and dropped. Leave it empty and every event runs. One URL usually receives
  several kinds of event, so this is what turns one URL into a rule rather than a firehose.
- **What to tell the agent about the event** — turns the body into the prompt.
  <span v-pre>`{{ data.title }}`</span> reads any field by path, <span v-pre>`{{ payload }}`</span> drops in the
  whole thing. Leave it empty and the agent receives the entire event.
- **Max runs per hour** — the loop backstop. If the agent writes back to the source and that fires the webhook
  again, this bounds the blast radius. Only deliveries that actually start a run count against it.

A **sample-payload sandbox** sits under the editor: load a received event (or paste one), and a dry run renders
the exact prompt and reports the filter verdict *without* spending a model call.

### Where the runs live

Every run, whatever started it, lands in the automation's run history with its status and a link to the
conversation it produced — including the runs that failed, which are the ones worth opening.

Those conversations are deliberately **kept out of your Chats list**: a rule that fires a hundred times would
bury everything you actually started. They live under the automation instead. Open one and reply to it and it
becomes an ordinary chat of yours, listed in Chats from then on — replying is how you adopt it.

### Why this stays governed

An automation runs **as the person who created it**: their role, their teams, their tool entitlements, freshly
re-evaluated on every turn. A webhook can start work; it can never widen what that work is allowed to touch.
If a mutating tool is held for [maker-checker approval](/learn/mcp-governance), it is still held when an
automation calls it.

The webhook endpoint is deliberately unauthenticated in the session sense — the caller is the sending system,
not a Kravn user. What stands in for a session is the unguessable token in the URL, plus an optional shared
secret or, better, an **HMAC-SHA256 signature** over the raw body (what most systems send once you configure a
webhook secret; Kravn accepts every common signature header, so a shim is rarely needed). Secrets are stored
encrypted and never returned by the API; rotating the URL revokes every sender at once. Duplicate deliveries
are recognised and dropped, so a retrying sender never runs the agent twice.

## Why it matters

The hard part of enterprise AI was never the chat window — it was making tool access safe enough to hand out.
Because the gateway already solved that, the client is the payoff: proof that a properly governed surface is
one your people can actually *use*, not just audit.

Start with the gateway. See [what Kravn is](/guide/what-is-kravn), how it handles
[authorization](/learn/mcp-authorization) and [governance](/learn/mcp-governance), or head back to the
[overview](/).
