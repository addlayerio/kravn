# Kravn Helm chart

Deploy Kravn — a seamless, self-configuring MCP gateway — onto Kubernetes.

## Install from the published chart (GHCR, OCI)

CI publishes the image and chart to the repo owner's GHCR. On any cluster (e.g. Worldsys):

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

Use external Postgres + scale to multiple replicas (requires a shared secret). Enabling the migration Job
makes the schema migrate **once** in a `pre-install`/`pre-upgrade` hook (Helm waits for it) before the pods
roll, and the pods start with `KRAVN_MIGRATE=skip` instead of each contending on the migration lock:

```yaml
replicaCount: 3
persistence:
  enabled: false
database:
  enabled: true
  url: postgres://user:pass@pg:5432/kravn?sslmode=require
  schema: kravn          # optional: build tables in a dedicated schema (see values.yaml)
secret: "a-32+char-random-string-shared-by-all-pods"
migrations:
  job:
    enabled: true
```

> Without `migrations.job.enabled`, every pod still runs migrations on boot — Knex's lock serializes them,
> which is safe but means the pods contend on the lock at startup. The Job is the cleaner pattern at scale.

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
