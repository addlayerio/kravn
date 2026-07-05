# Security & compliance

Kravn was born in the compliance world, and it shows in the defaults. This page summarizes the posture
that makes it safe to run inside a regulated network. Every security-relevant release is documented in the
[changelog](https://github.com/addlayerio/kravn/blob/main/SECURITY.md).

## No data leaves your perimeter

Kravn is self-hosted by design. It runs on your servers, in your network, and never phones home. Your
prompts, your context and your data stay inside the corporate boundary — which is the entire reason it
exists.

## Identity you already trust

- **SSO** — SAML and OAuth2/OIDC. Users authenticate with corporate credentials.
- **SCIM 2.0 provisioning** — your IdP creates and disables users automatically; provisioned users are
  clamped to a safe role and an admin is never auto-deactivated.
- **RBAC + teams** — roles gate the control plane; teams gate the data plane.

## Control plane vs data plane

Configuring Kravn and consuming MCPs are separated by design. Being a platform administrator does **not**
grant access to a restricted endpoint — you consume it by team membership, like anyone else. Denials use
the correct HTTP semantics (an authenticated-but-forbidden response, not a credentials error) so clients
surface a clear reason, and every denial is recorded for the operator.

## Governed tool calls

Composable pipelines let you enforce controls on every request and result:

- **Secret & PII redaction** — strip credentials, keys and personal data before they ever reach a model.
- **Prompt-injection defense** — detect and neutralize indirect injection in tool output.
- **Content policy** — deny-lists, safety filters and HTML sanitization.
- **Tamper-evident audit** — a hash-chained record of every tool call: who, what, when.

A global pipeline can enforce an organization-wide control that **no single endpoint can switch off** — an
overlay may only add steps, never remove them.

## Hardened by default

- **Secrets encrypted at rest** — plugin credentials (client secrets, API tokens) are encrypted in the
  database and write-only-masked in the UI. Keep custody of the key in your own **KMS/HSM** (HashiCorp
  Vault or Azure Key Vault) — see [Key management](/guide/key-management).
- **SSRF-safe outbound HTTP** — a configurable policy governs which hosts upstreams may reach; cloud
  metadata IPs stay blocked regardless. Outbound integrations use fixed hosts, per-request timeouts and
  response caps, and refuse redirects that would leak credentials to another host.
- **Standard web hardening** — CSRF protection, rate limiting on auth endpoints, security headers, and
  authenticated metrics.
- **Reviewed releases** — changes ship through an adversarial security review, and the findings and fixes
  are recorded in the public changelog.

## Portability & data ownership

The store is portable across SQLite, PostgreSQL, MySQL/MariaDB and SQL Server, with versioned migrations
and standard backup tooling. Your data lives in your database — there is no proprietary lock-in on the
persistence layer.

## Licensing

Kravn is **source-available** under the Business Source License 1.1 (BSL 1.1), which converts to Apache
2.0 over time. You can read the source, run it, and audit it — which is exactly what a compliance team
needs to trust a piece of infrastructure. See the
[LICENSE](https://github.com/addlayerio/kravn/blob/main/LICENSE).

::: warning Reporting a vulnerability
Found a security issue? Please report it responsibly via the repository's security policy rather than a
public issue.
:::

---

Back to the [Quickstart](/guide/getting-started), or browse the source on
[GitHub](https://github.com/addlayerio/kravn).
