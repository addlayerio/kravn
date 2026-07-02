# SECURITY.md — Kravn

> **Read this before touching auth, tokens, routes, MCP, OAuth, SSO, plugins, DB access, headers or
> secrets — and before declaring ANY change "done".** This is the security contract for Kravn: the
> invariants that must never be broken, the controls already in place, the accepted residual risk, and the
> **mandatory re-validation process** every change goes through. `AGENTS.md` §5 points here on purpose so
> it is always in context.

Kravn is an MCP **gateway / registry / proxy** exposed publicly (reference deployment: `mcp.worldsys.io`).
It brokers untrusted external MCP clients (e.g. Claude connectors) to configured upstream MCP servers, runs
an OAuth 2.1 authorization server, and executes admin-provided code (native + user plugins, stdio servers).
The attack surface is real and the product **must be secure on its own** — a CDN/WAF (Cloudflare) is
optional hardening, **never** a control we depend on.

---

## 0. The one rule

**Every change re-validates security.** Not "security-looking" changes — every change. Small diffs move
auth boundaries too. Before you call work done, run the checklist in §6 against your diff; if the change
touches a security-sensitive surface (§5), run an adversarial review and fix confirmed findings first.
"It builds and the happy path works" is not done.

---

## 1. Trust boundaries & threat model

| Boundary | Who's on the other side | Primary token | Enforcement point |
|---|---|---|---|
| **Control plane** (`/api/*`, operator SPA) | Authenticated staff (admin/editor/viewer) | Unscoped session JWT (Bearer) | `authenticate` + `authorize(<perm>)` in `auth/plugin.ts` |
| **Data plane** (`/mcp`, `/servers/:slug/mcp`) | Signed-in users AND external OAuth clients | Session JWT **or** `scope='mcp'` JWT | `mcp.routes.ts` (auth + `mcp.invoke` + server `access` policy) |
| **OAuth 2.1 AS** (`/oauth/*`, `/.well-known/*`) | Untrusted third-party MCP clients | DCR client creds, auth codes, refresh tokens | `oauth.routes.ts` + `oauth.service.ts` |
| **SSO/SAML/OIDC** (`/api/auth/sso/*`) | External IdP (EntraID, etc.) | Signed SAML assertion / OIDC id_token | `sso.service.ts` (signature + issuer checks) |
| **Upstream MCP servers** | Third-party/self-hosted MCP endpoints | Per-server config (secrets encrypted) | `mcp/upstream.ts` |
| **Plugins & stdio servers** | **Admin-authored code, runs in-process / as child** | — (trusted-admin surface) | `servers.routes.ts` gating + `upstream.ts` env sanitization |

**Untrusted inputs:** request bodies/params/headers, SSO responses, OAuth params, upstream MCP tool output.
**Trusted-but-dangerous:** user plugins (run in-process with full privilege) and stdio servers (arbitrary
`command`/`args` → RCE). These are **admin-only by design**; the boundary is "only an admin can introduce
executable code", enforced in code — not "the code is sandboxed" (it isn't).

**Token scope model (never blur these):**
- **unscoped** → full control-plane session. `authenticate` accepts ONLY this.
- **`mcp`** → data-plane only (OAuth-issued, for MCP invocation). Rejected on the control plane.
- **`handoff`** → one-time SSO→session exchange code (2-min TTL, atomic single-use).
- **`logstream`** → one-time SSE ticket for `/api/logs/stream` (1-min TTL, atomic single-use).

---

## 2. Security invariants (must never be violated)

1. **Auth tokens are Bearer-only and never travel in a URL.** SSE/redirect flows use short-lived,
   purpose-scoped, **atomically single-use** tickets/codes (`consume()` in `repos.ts`, backed by the
   `token_revocations.jti` PRIMARY KEY). Single-use enforcement is **atomic and fail-closed** — never
   check-then-act, never swallow the duplicate-key error.
2. **Scope confinement.** The control plane (`authenticate`) rejects **any** scoped token. Scoped tokens
   reach only their one surface.
3. **Authorize + own.** Every mutating route sits behind `authenticate` + `authorize(<permission>)`. Every
   per-user / per-team read additionally enforces **ownership/membership** — a permission is not authority
   over *someone else's* resource (IDOR). Multi-tenant data paths are scoped by `user_id` / team.
4. **No secret paired with a caller-supplied URL. No redirect origin derived from request headers.**
   Redirect targets come from server config (`KRAVN_PUBLIC_URL` / `KRAVN_CLIENT_URL`), never from `Host`
   or `X-Forwarded-*`.
5. **stdio/plugins are admin-only.** Creating/patching/syncing a `stdio` server requires `role==='admin'`
   **and** `KRAVN_ALLOW_STDIO`; child processes get a **sanitized env** (no secret inheritance, no
   loader-injection vars — see `DANGEROUS_ENV` in `upstream.ts`).
6. **Secrets are encrypted at rest, write-only, fail-closed.** Config fields marked `secret:true` are
   AES-256-GCM encrypted (`Encryptor`), masked in every API/UI response, decrypted only at runtime.
7. **Defense-in-depth transport controls, set in the app.** Security headers on **every** response (staged
   at `onRequest`), strict CORS allowlist, configurable `trustProxy` (never blindly `true`). The app is
   safe without a CDN.
8. **Errors don't leak.** Client mistakes → 4xx with a generic message; never a stack trace, DB error,
   schema shape (`ZodError.issues`), or internal detail. Unexpected → 500 generic.
9. **All SQL is parameterized** (`Store` `?`-placeholders via knex.raw) and **schema identifiers are
   validated** (`KRAVN_DB_SCHEMA` is a simple-identifier check). Never interpolate untrusted input into SQL
   or qualify identifiers with a caller-influenced schema.
10. **SSO signatures are verified.** SAML: `wantAssertionsSigned:true` (EntraID signs the assertion).
    OIDC discovery URLs must be **public HTTPS** (SSRF guard rejects loopback/private/link-local/metadata).

---

## 3. Controls currently in place (inventory)

| Area | Control | Where |
|---|---|---|
| Local auth | Rate-limit + progressive lockout on login; reserved-email + promotion safeguards; TOCTOU-safe delete | `auth.service.ts`, `auth.routes.ts` |
| Local auth | Disable local auth (SSO-only) + promote an EntraID user to admin | `settings` + `auth.routes.ts` |
| SSO | SAML assertion-signature verification (`wantAssertionsSigned`, `wantAuthnResponseSigned:false`), multi-cert rollover; `@fastify/formbody` for POST binding | `sso.service.ts`, `app.ts` |
| SSO | OIDC discovery **SSRF guard** (`assertPublicHttpsUrl`); reject `email_verified:false` | `sso.service.ts` |
| SSO→session | One-time **`handoff` code** in redirect (not a raw token) → `POST /api/auth/exchange`, **atomic single-use** | `sso.routes.ts`, `auth.routes.ts` |
| AuthZ | RBAC (admin `*` / editor / viewer) enforced by `authorize()`; `authenticate` rejects scoped tokens | `packages/contracts/src/permissions.ts`, `auth/plugin.ts` |
| AuthZ | **Admin-console gate**: every control-plane route (all use `authorize()`) requires role `admin` OR membership in the Platform Administrator Team. A pure MCP consumer (authenticated, not in the team) is denied the console but can still use chat/MCP. Team is seeded/reconciled with all admins; promotion joins it, demotion leaves it. Chat/MCP/OAuth-consent/`/api/auth/me` are consumer paths and intentionally NOT gated. | `auth/plugin.ts`, `db/repos.ts` (TeamsRepo), `services.ts` |
| AuthZ | Team-roster read requires membership or admin (anti-IDOR) | `teams.routes.ts` |
| MCP data-plane | `mcp.invoke` required; per-server `access` = `public` / `authenticated` / `restricted` (`allowedRoles`/`allowedTeams`) | `mcp.routes.ts`, `chat.routes.ts` |
| RCE surface | stdio create/patch/sync admin-gated + `KRAVN_ALLOW_STDIO`; child env sanitized (`DANGEROUS_ENV`) | `servers.routes.ts`, `mcp/upstream.ts` |
| Logs (SSE) | `logstream` ticket (1-min, **atomic single-use**), never a session token in `?ticket=` | `logs.routes.ts` |
| OAuth 2.1 AS | DCR (RFC 7591) rate-limited + capped; PKCE S256; **atomic** single-use auth codes & rotating hashed refresh tokens (`Store.delCount`); consent **binding cookie** (anti-fixation); `Cache-Control: no-store` | `oauth.routes.ts`, `oauth.service.ts`, `repos.ts` |
| Single-use tokens | `TokensRepo.consume(jti)` — atomic first-wins via `token_revocations` PK, fail-closed | `db/repos.ts` |
| Transport | Security headers every response (`onRequest`): CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options:DENY`, `Referrer-Policy`, `Permissions-Policy` | `app.ts` |
| Transport | CORS allowlist (only `publicUrl`/`clientUrl` origins; `credentials:false`); configurable `trustProxy` (default 1 hop, anti-XFF-forgery) | `app.ts`, `config/env.ts` |
| Secrets | AES-256-GCM `Encryptor` (`enc:v1:`), write-only masking, idempotent | `plugins/manager.ts` |
| Input | zod validation + maxlength; malformed body → 400; DB errors sanitized (`describeSyncError`) | route handlers, `app.ts` |
| Metrics | `/metrics` requires `KRAVN_METRICS_TOKEN` (or auth); 404 when disabled | `system.routes.ts` |
| Logging | Request logs strip the query string (no token/ticket leakage); secrets never logged | `app.ts` |
| DB | Parameterized SQL only; `KRAVN_DB_SCHEMA` validated; identifiers unqualified | `db/store.ts`, `db/knex.ts` |

---

## 4. Known residual risk (accepted / tracked — revisit on relevant change)

1. **Team entitlements cover MCPs + tools, but not resources/prompts (by design).** Per-team access is
   enforced at two levels: level 1 = which virtual servers a team may use (`virtual_servers.allowed_teams`,
   only when `access:'restricted'`); level 2 = which of that server's TOOLS (`team_server_tools`, empty ⇒
   all). Enforcement narrows `scope.tools` in `mcp.routes.ts` + `chat.service.ts` (covers tools/list &
   tools/call); the raw `/api/tools/:id/invoke` playground and the global `/mcp` catalog are admin-only so
   neither bypasses it; membership is loaded **live** from the DB on every request (revoking a member cuts
   an existing OAuth token's access immediately). **Limitation:** a granted team member sees ALL of that
   server's **resources and prompts** — the subset is tools-only. To scope resources/prompts, put them in a
   separate virtual server. Note also `access:'authenticated'` remains open to the whole org; use
   `restricted` (granting a team auto-flips to it) for anything sensitive. Extending level 2 to
   resources/prompts (mirror `team_server_tools`) is a tracked follow-up.
2. **HSTS / `X-Content-Type-Options` at the edge.** The app emits both; they did not surface through
   Cloudflare in a live probe. Confirm at the origin and check Cloudflare Transform/Managed-Headers rules.
   Enable "Always Use HTTPS" + HSTS at the ingress regardless (the app cannot force TLS it doesn't
   terminate).
3. **OIDC deeper SSRF.** Discovery URL is guarded; a restricted dispatcher for `openid-client`'s
   subsequent calls is a follow-up.
4. **Handoff code TTL** is a fixed 2 min (mitigated by atomic single-use). Make configurable if needed.
5. **CORS trailing-dot** normalization is cosmetic (browsers never send a trailing-dot Origin).
6. **Last-admin anti-lockout uses an in-process mutex** (`withAdminLock`) + a count check. It serializes within one gateway process but not across replicas, so two pods concurrently demoting/disabling two *different* admins could in theory drop the count to zero. Acceptable for single-replica or low-concurrency admin ops; a cross-dialect atomic guard (or a DB advisory lock) is the follow-up. Pre-dates the ABM change. Disabling an admin also leaves their Platform-Administrator-Team row (harmless — a disabled user can't authenticate, so the membership is inert).
7. **Cross-replica shared store (rate limit + OIDC login state) is best-effort.** With `KRAVN_REDIS_URL` set (the Helm chart deploys **Dragonfly**, RESP-compatible), the brute-force counters and in-flight OIDC `state` are shared across pods (`cluster/shared-store.ts`) — so login/DCR limits and OIDC callbacks are correct behind N replicas. On a store **outage** each pod transparently degrades to its own in-process counters (per-pod limiting — the single-replica guarantee, never fail-open, never a crash; an unreachable/misconfigured URL only logs and degrades). Two accepted consequences: (a) during an outage the effective login-attempt budget is per-pod × replicas until the store returns; (b) the in-memory **log ring buffer** (`logstore.ts`) remains per-pod (a UI log view shows only the serving pod's slice) — a durable shared event store is a separate follow-up. When `KRAVN_REDIS_URL` is unset (single replica) behavior is unchanged. The OIDC pending claim is atomic and single-use (`GETDEL` / memory get-and-delete), so a replayed/raced `state` cannot be reused; the PKCE verifier is stored server-side only. A brownout (store reachable but slow) is bounded by a circuit breaker (one timed-out probe per cooldown, not per request). Redis key growth under a spray is bounded by short TTLs + the per-IP login limit + the 254-char email cap; the memory fallback additionally hard-caps entry count. Two accepted follow-ups on the **bundled** Dragonfly: it has **no `requirepass`** (a same-namespace pod is fenced off by an optional NetworkPolicy, default-on, but not authenticated — use an external managed store with a `redis://:password@` URL for real auth), and it runs `noeviction` (an OOM flood rejects writes → the safe per-pod degrade, never a crash).

---

## 5. When a change is "security-sensitive" (triggers the full review)

Treat a change as security-sensitive — and run the adversarial review in §7 — if it touches **any** of:

- Authentication, sessions, JWTs, tokens, tickets, or the `consume()`/revocation path.
- Authorization: routes, `authorize()`/permissions, roles, team/ownership checks, the MCP `access` policy.
- The OAuth AS, SSO/SAML/OIDC, or any redirect/callback.
- MCP invocation, virtual-server config, upstream connection, stdio, or the plugin system.
- Any new route, or a change to CORS, security headers, `trustProxy`, error handling, or logging.
- DB access (new SQL, new columns), secret handling, or `KRAVN_DB_SCHEMA` usage.
- Anything parsing untrusted input (bodies, files, SSO/OAuth payloads, upstream tool output).

If in doubt, it's sensitive.

---

## 6. Per-change security checklist (run against your diff, every time)

- [ ] **New/changed routes** are behind `authenticate` + the correct `authorize(<perm>)`; mutating routes are not reachable by viewer/editor unless intended.
- [ ] **Ownership/membership** is enforced on every per-user/per-team read & write (not just the permission) — no IDOR by id enumeration.
- [ ] **No token in any URL**; SSE/redirect uses a scoped, **atomically** single-use ticket/code (`consume()`), fail-closed. No new `.catch(()=>{})` that swallows a uniqueness/consume failure.
- [ ] **Scope**: control-plane paths reject scoped tokens; a scoped token can't reach a new surface.
- [ ] **No secret + caller URL**; no redirect origin from `Host`/`X-Forwarded-*`.
- [ ] **stdio/plugin/exec** paths stay admin-gated; child env stays sanitized.
- [ ] **Secrets** you add are `secret:true` (encrypted, masked, never returned/logged).
- [ ] **Input** validated (zod + limits); malformed → 4xx; **errors leak nothing** (no stack/DB/schema/`ZodError.issues`).
- [ ] **SQL** parameterized; no schema/identifier interpolation; migration append-only.
- [ ] **Headers/CORS/trustProxy** unaffected or correctly updated; new response types still get security headers.
- [ ] **Runtime-validated** the specific control you touched (positive **and** negative case).
- [ ] If §5 sensitive: **adversarial review run**, confirmed findings fixed, refuted ones noted.

---

## 7. How to re-validate (the process that found and killed real bugs)

1. **Non-intrusive live probes** (authorized asset only, read-only, low volume — no brute force, no
   writes): security headers present, `/metrics` 401, CORS rejects a foreign `Origin`, protected route 401,
   discovery issuer HTTPS, malformed body 400, no version leak.
2. **Adversarial white-box review** (the pattern that surfaced the RCE, the JWT-in-URL, and the two TOCTOU
   races): fan out readers by lens (access-control / auth-changes / OAuth / MCP authz) → collect candidate
   findings → **adversarially verify each** (default to *refuted* unless a concrete exploit path is traced
   in code) → fix only what survives, at corrected severity. Do not trust a finding you haven't traced.
3. **Runtime tests** for the exact controls changed — e.g. concurrent single-use (exactly one winner),
   scope rejection (403 on control plane), non-member roster read (403), editor→stdio (403).

Findings are ranked by verified severity and fixed **before** release. Perimeter probes confirm the fix is
actually live (a git push is not a deploy).

---

## 8. Security change log (audit trail)

| Version | Security work |
|---|---|
| v0.1.11 | Local-login rate-limit + lockout hardening; SSO-only mode; EntraID admin promotion; 12 findings fixed (account-takeover-on-promotion, reserved_email, victim-lockout DoS, bounded eviction, TOCTOU delete mutex). |
| v0.1.13 | SAML signature root-cause fix (`wantAuthnResponseSigned:false`, keep `wantAssertionsSigned:true`). |
| v0.1.14 | OAuth 2.1 AS hardening: atomic single-use codes/refresh (`delCount`), consent binding cookie, DCR rate-limit + cap, refresh revoke-on-delete, `Cache-Control: no-store`. |
| v0.1.17 | Plugin secret fields encrypted at rest (idempotent, write-only masking). |
| v0.1.20 | White-box audit: editor→stdio **RCE** closed (admin-gate + `sanitizeChildEnv`); **JWT-in-URL** removed (logstream ticket + handoff exchange + scope rejection); `trustProxy` configurable; OIDC SSRF guard; `email_verified` check; security headers (`onRequest`); `/metrics` auth; CORS allowlist; 4xx passthrough; query-string stripped from logs. |
| v0.1.21 | Re-audit: **TOCTOU** in handoff exchange (**critical**) and logstream ticket (**high**) fixed with atomic `consume(jti)` (jti-PK first-wins, fail-closed); team-roster **IDOR** fixed (membership/admin check); `ZodError` detail leak removed. |
| v0.1.22 | Per-team MCP + tool entitlements (`team_server_tools`, `allowedToolIdsForUser`, enforced by narrowing `scope.tools` in mcp.routes + chat). Corollaries: `viewer` gains `mcp.invoke` (the WHICH is now decided by team policy, not role); global `/mcp` made **admin-only**; admin bypasses the restricted gate. Adversarial review found + fixed a **critical** invocation bypass — the raw `/api/tools/:id/invoke` playground ignored VS/team gating; now admin-only (UI button gated too). |
| v0.1.24 | **Admin-console gate**: access to the whole control-plane now requires role admin OR Platform Administrator Team membership (seeded at setup/promotion, reconciled at boot, removed on demotion), closing the hole where any authenticated MCP consumer could enter the admin web. Adversarial review found + fixed: `/api/overview` was `authenticate`-only (leaked dashboard) → gated; `/api/tools/:id/invoke` now also goes through `authorize()`. Refuted 3 false positives that would have broken consumers (gating `/api/oauth/consent`, `/api/auth/me`, `/api/logs/*`). Role-admin backstop eliminates the team-membership lockout class. |
| v0.1.25 | Native **Jira** plugin (`plugins/jira.ts`, credential-bearing external integration, same pattern as SharePoint: `apiToken` is `secret:true` → encrypted at rest + write-only-masked). Security review found + fixed: the `baseUrl` SSRF guard missed IPv6 literals (WHATWG normalizes `::ffff:127.0.0.1` to hex) → now rejects all IPv6 literals + loopback/link-local; added `redirect: 'error'`, a 20s timeout and a 10 MB response cap + error-message truncation. JQL/issue-keys are body/`encodeURIComponent`-safe. `baseUrl` is admin-config (behind the console gate), not caller-supplied. |
| v0.1.26 | **Confluence** plugin (shares the hardened `plugins/atlassian.ts` SSRF guard + auth with Jira). **User ABM**: edit name/email/role/password + a `disabled` flag (migration 006); `login`/`authenticate`/`authenticateToken` reject disabled, so deactivation cuts sessions live. Anti-lockout (can't demote/disable/self-disable the last admin), email uniqueness, promote↔demote syncs the Platform Administrator Team. **SCIM 2.0** provisioning (`/scim/v2/*`, `scim/scim.service.ts`): bearer token stored as a SHA-256 hash, timing-safe + enabled-gated; a MACHINE path (not behind the console gate) that provisions users at a clamped role (**never admin**) and **never deactivates/deletes an admin** (anti-lockout); admin token mgmt under `/api/scim/*` (users.write). Review found + fixed: `disabled` was not checked in the token-**issuance** paths → added to `/api/auth/exchange` and OAuth `issueTokens` (covers code + refresh); SCIM list now paginates (`startIndex`/`count` clamp); Confluence echoes a clipped CQL + encodes `pageId`. |
| v0.1.29 | **Multi-replica prep — cross-replica shared store** (`cluster/shared-store.ts`, opt-in via `KRAVN_REDIS_URL`; Helm deploys **Dragonfly**, RESP-compatible). The brute-force **rate-limit** counters (login + OAuth DCR, `LoginRateLimiter` now async + namespaced) and **in-flight OIDC login state** (PKCE verifier + `state`, previously per-process Maps) move into the shared store, so both are correct behind N pods (validated: a lockout raised on pod A blocks pod B; the counter lives in Dragonfly with the right TTL). **Fail-safe by construction:** a store outage degrades each pod to its own in-process counters (per-pod limiting — never fail-open, never a crash; an unreachable URL only logs + degrades), and the in-process memory-safety hardening (bounded maps, eviction that never wipes an active block) is preserved in the memory backend. Review found + fixed a regression it introduced: the OIDC `state` claim was `get`+`await`+`del` (a double-use window across replicas) → replaced with an **atomic single-use** `take()` (`GETDEL` / memory get-and-delete), verified single-winner under concurrency. Helm Dragonfly pinned to `--proactor_threads=1` (it refuses to boot unless `maxmemory ≥ threads×256MiB`), ClusterIP-only, non-root. No behavior change when `KRAVN_REDIS_URL` is unset. |

Keep this table current: every release that touches security adds a row.
