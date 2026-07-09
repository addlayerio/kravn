# Kravn Helm chart

Deploy Kravn — a seamless, self-configuring MCP gateway — onto Kubernetes.

## Install from the published chart (GHCR, OCI)

CI publishes the image and chart to the repo owner's GHCR. On any cluster:

```bash
helm install kravn oci://ghcr.io/<owner>/charts/kravn --version 0.1.0
kubectl port-forward svc/kravn 8080:80
# open http://localhost:8080 and complete the setup wizard
```

(`<owner>` = your GitHub account — the chart's default image already points at `ghcr.io/<owner>/kravn`.)
If the GHCR packages are private, either make them public on the repo's Packages page, or create an
image pull secret and pass `--set imagePullSecrets[0].name=ghcr-creds`.

## Zero-config local install (from source)

```bash
helm install kravn ./charts/kravn
kubectl port-forward svc/kravn 8080:80
```

No required values. It boots with embedded SQLite on a 1Gi PVC, an auto-generated signing key, no
Ingress, no ServiceMonitor, and no CRD dependencies.

## Pure MCP gateway (minimal)

To run only the control-plane + MCP endpoint + operator UI (no end-user chat / Python interpreter,
lower memory):

```yaml
role: gateway
resources: { limits: { memory: 512Mi } }
```

## Common upgrades

Expose via Ingress:

```yaml
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: kravn.example.com
      paths: [{ path: /, pathType: Prefix }]
```

Use external Postgres + scale to multiple replicas (requires a shared secret **and** a shared store). With an
external database the chart **automatically** runs a `pre-install`/`pre-upgrade` hook Job that migrates the
schema **once** before the pods roll (Helm waits for it) — no configuration needed:

```yaml
replicaCount: 3
persistence:
  enabled: false
database:
  enabled: true
  url: postgres://user:pass@pg:5432/kravn?sslmode=require
  schema: kravn          # optional: build tables in a dedicated schema (see values.yaml)
secret: "a-32+char-random-string-shared-by-all-pods"
redis:
  enabled: true          # deploys Dragonfly (Redis-wire-compatible) as the cross-replica shared store
```

> **`redis.enabled` deploys Dragonfly, not Redis.** Kravn speaks the Redis protocol; the chart provisions a
> single in-memory [Dragonfly](https://www.dragonflydb.io/) node for the cross-replica state that must be shared
> when `replicaCount > 1`: the brute-force rate-limit counters and in-flight OIDC login state. Without it each
> pod limits independently and an OIDC callback can land on the wrong pod. It's best-effort — if the store is
> unreachable the app degrades to per-pod limiting, it never crashes. To use your own managed Redis/Valkey/
> Dragonfly instead, set `redis.externalUrl` (or `redis.existingSecret`) and leave `redis.enabled: false`.

> The migration Job is on by default whenever a database is configured. `migrations.job.enabled: false` is
> only for operators who apply migrations out-of-band (e.g. from CI). Pods still self-migrate on boot too
> (a no-op once the Job has run), so a standalone container without Helm is also fine.

Scrape metrics (only if the Prometheus Operator is installed):

```yaml
metrics:
  serviceMonitor:
    enabled: true
```

## Values

See [values.yaml](values.yaml) — every option is documented inline. Note that **application**
configuration (SSRF policy, CSRF, rate limits, transports, federation, OAuth, log level) is NOT
here: it lives in the app and is edited from the Settings page at runtime.
