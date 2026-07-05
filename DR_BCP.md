# Disaster Recovery & Business Continuity (DR/BCP)

This runbook is the authoritative procedure for backing up and restoring Kravn, and the continuity posture
for running it in a regulated environment. Treat it as the source of truth for your RPO/RTO commitments.

> **Golden rule:** a backup you have never restored is not a backup. Test the restore end-to-end on a
> schedule (below), not only during an incident.

---

## 1. What Kravn persists (and therefore what you must protect)

Everything Kravn keeps lives in **two** places — the database and the encryption key. Losing either loses
data; losing the key makes the database's secrets unrecoverable.

| Asset | Where it lives | Contains | If lost |
|---|---|---|---|
| **Database** | External DB (Postgres/MySQL/SQL Server) **or** the SQLite file on the data PVC | All state: users, teams, RBAC, MCP servers, virtual endpoints, **plugin credentials (encrypted)**, the **`app_keyring`** (KMS-wrapped DEKs), the hash-chained **audit log**, settings | Total loss of configuration & history |
| **Bootstrap secret** (`KRAVN_SECRET`) | A Kubernetes Secret, or `secret.key` in `KRAVN_DATA_DIR` (`/data`) when auto-generated | The symmetric key that decrypts `enc:v1:` data and signs sessions | **Encrypted secrets become unrecoverable** even with a full DB |
| **External KMS key** (only if KMS is enabled) | Your HashiCorp Vault / Azure Key Vault (the **KEK**) | Wraps the DEKs stored as `enc:v2:` in `app_keyring` | The KMS-wrapped secrets become unrecoverable |

**Implication:** back up the **database and the key together and in sync.** A DB restored against the wrong
key cannot decrypt its own credentials. See [KEY_MANAGEMENT.md](./KEY_MANAGEMENT.md) for key custody.

---

## 2. Backups

### 2.1 Database

Use your database's native, point-in-time-capable tooling — it is battle-tested and integrates with your
existing backup infrastructure.

- **PostgreSQL:** `pg_dump` for logical dumps, or continuous archiving / a managed provider's PITR.
  ```sh
  pg_dump --format=custom --no-owner "$DATABASE_URL" > kravn-$(date +%F).dump
  ```
- **MySQL / MariaDB:**
  ```sh
  mysqldump --single-transaction --routines --triggers -h HOST -u USER -p DB > kravn-$(date +%F).sql
  ```
- **SQL Server:** `BACKUP DATABASE` to a `.bak`, or your managed instance's automated backups.
- **Embedded SQLite:** the whole `KRAVN_DATA_DIR` (default `/data`) — the DB file **and** `secret.key`.
  Snapshot the PVC, or copy with the DB quiesced:
  ```sh
  # From a shell in the pod (or a job mounting the PVC):
  sqlite3 /data/kravn.sqlite ".backup '/data/backup/kravn-$(date +%F).sqlite'"
  cp /data/secret.key /data/backup/secret.key   # keep the key with the snapshot
  ```

An **optional backup CronJob is shipped in the Helm chart** (`backup.enabled`, §4) to automate this.

### 2.2 The encryption key

- **`KRAVN_SECRET` provided via a Secret** (recommended for production): it is already in your cluster's
  Secret store — ensure that store is in your backup/DR scope (etcd backup, sealed-secrets repo, or your
  secrets manager). **Store a copy in your organization's secrets vault / escrow**, offline from the DB.
- **Auto-generated `secret.key`** (single-replica SQLite default): it lives on the data PVC, so a PVC/SQLite
  backup that includes it (as above) covers it. Also escrow a copy — if the PVC is lost, the key is gone.
- **External KMS enabled:** the KEK never leaves your KMS. Follow **your KMS's own DR** (Vault snapshot +
  unseal keys / auto-unseal recovery; Azure Key Vault soft-delete + purge-protection + geo-redundancy).
  Kravn only stores KMS-*wrapped* DEKs in the DB backup — safe at rest, useless without the KMS.

### 2.3 Recommended cadence

| RPO target | Do this |
|---|---|
| ≤ 24h | Nightly logical dump (CronJob or managed PITR), retained ≥ 30 days. |
| ≤ 1h | Managed DB with continuous archiving / PITR. |
| Key | Escrow `KRAVN_SECRET` once, re-escrow on any rotation; KMS per its own geo-redundant DR. |

Encrypt backups at rest and restrict access — a DB backup contains encrypted-but-sensitive credentials and
the audit trail.

---

## 3. Restore

1. **Provision** a database (same engine/version range) and a cluster to run Kravn.
2. **Restore the database** from the dump (`pg_restore` / `mysql <` / `RESTORE DATABASE` / copy the SQLite
   file back into `KRAVN_DATA_DIR`).
3. **Restore the key**: set `KRAVN_SECRET` to the **same** value the backup was written with (from your
   escrow / Secret store), or place the `secret.key` back on the PVC. If KMS was used, restore KMS access
   (unseal Vault / recover the Key Vault) so `enc:v2:` DEKs can be unwrapped.
4. **Point Kravn at the restored DB** (`DATABASE_URL`) and deploy the **same or newer** app version.
   Migrations are append-only and run automatically (a pre-upgrade Job for external DBs).
5. **Verify**:
   - Log in; the dashboard loads and shows your servers/endpoints/teams.
   - Open a plugin with a stored credential and confirm it still connects (proves the key matched).
   - Run `audit.verify()` (audit log integrity) — the hash chain should validate.

**RTO** is dominated by DB restore time + image pull. For a fast RTO, keep a warm standby DB and pre-pulled
images. Kravn itself is stateless beyond the DB + key, so pods come up in seconds.

---

## 4. Automated backup CronJob (Helm)

The chart ships an **optional** backup CronJob, off by default. Enable it and provide a command + a
destination volume appropriate to your database:

```yaml
backup:
  enabled: true
  schedule: "0 2 * * *"          # nightly at 02:00
  # An image that has your DB client (pg_dump / mysqldump / sqlite3). Defaults to the app image (SQLite).
  image: postgres:16-alpine
  # The backup command. $DATABASE_URL / the /data mount are available.
  command:
    - /bin/sh
    - -c
    - 'pg_dump --format=custom "$DATABASE_URL" > /backup/kravn-$(date +%F-%H%M).dump'
  retentionDays: 30             # a companion prune step deletes older files
  # Where dumps land. Provide a PVC (recommended: a different storage class / off-cluster export target).
  destination:
    existingClaim: kravn-backups
    mountPath: /backup
```

For SQLite, leave `image` empty (uses the app image, which bundles `sqlite3`) and back up `/data`. For
managed databases, prefer the provider's native automated backups and leave this disabled.

---

## 5. Business continuity (HA)

- **Multi-replica:** run `replicaCount > 1` with an external database and a **shared store** (the chart's
  Dragonfly option, or your Redis-protocol endpoint) so the rate-limiter and in-flight OIDC login state are
  cross-pod. A stable `KRAVN_SECRET` (Secret, not the per-PVC auto key) is required so all pods share one key.
- **Multi-zone / multi-region:** Kravn is stateless beyond the DB + key — spread replicas across zones and
  fail over the database with your DB's HA. For multi-region, replicate the DB and the key escrow.
- **Health probes:** `/healthz` (liveness) and `/readyz` (readiness, gated on DB connectivity) drive
  rollout and failover.

---

## 6. Continuity checklist

- [ ] Nightly DB backup running and **restore-tested** (quarterly at minimum).
- [ ] `KRAVN_SECRET` escrowed offline from the DB; re-escrowed after any rotation.
- [ ] KMS (if used) has geo-redundant DR + recovery keys documented and tested.
- [ ] Backups encrypted at rest with restricted access.
- [ ] RPO/RTO written down and agreed with the business; the last successful restore test recorded.
- [ ] Multi-replica + shared store + stable secret verified for the HA tier.
