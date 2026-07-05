---
title: Disaster recovery & continuity
description: How to back up and restore Kravn, protect the encryption key, and run it highly available — the DR/BCP posture a regulated environment needs.
---

# Disaster recovery & business continuity

Kravn is built to fit a regulated organization's continuity requirements. This page is the summary; the
full, step-by-step runbook lives in
[`DR_BCP.md`](https://github.com/addlayerio/kravn/blob/main/DR_BCP.md) in the repository.

::: tip The one rule
A backup you have never restored is not a backup. Test the restore end-to-end on a schedule.
:::

## What to protect

Everything Kravn keeps lives in **two** places — protect them **together and in sync**:

- **The database** — all state: users, teams, RBAC, servers, endpoints, **encrypted plugin credentials**,
  the KMS-wrapped key material, and the hash-chained audit log. Back it up with your database's native
  tooling (`pg_dump`, `mysqldump`, `BACKUP DATABASE`, or a PVC snapshot for embedded SQLite).
- **The encryption key** (`KRAVN_SECRET`, or the external **KMS** key when enabled) — it decrypts the
  database's secrets. **A database restored against the wrong key cannot decrypt its own credentials.**
  Escrow the key offline from the database; for a KMS, follow its own geo-redundant DR.

## Backups

- **Managed database:** prefer the provider's native automated backups / point-in-time recovery.
- **Self-run database:** schedule logical dumps (nightly for an RPO ≤ 24h, retained ≥ 30 days), encrypted at
  rest with restricted access.
- **Automated:** the Helm chart ships an optional **backup CronJob** (`backup.enabled`) that runs your dump
  command against the configured database on a schedule.

## Restore

Restore the database, set `KRAVN_SECRET` back to the **same** value the backup was written with (and restore
KMS access if used), point Kravn at the restored database, and deploy the same-or-newer version — migrations
run automatically. Then verify: log in, confirm a stored plugin credential still connects (proves the key
matched), and run the audit-log integrity check.

## High availability

Run multiple replicas with an external database and a shared store (the chart's Dragonfly option or your
Redis-protocol endpoint), and a stable `KRAVN_SECRET`, so the rate-limiter and login state are cross-pod.
Kravn is stateless beyond the database + key, so pods come up in seconds and spread across zones.

See the full runbook — including per-engine backup commands, the CronJob values, RPO/RTO guidance and the
continuity checklist — in [`DR_BCP.md`](https://github.com/addlayerio/kravn/blob/main/DR_BCP.md).
