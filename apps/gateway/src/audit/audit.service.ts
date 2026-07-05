import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { newId } from '../crypto.js';
import type { Repos, AuditRecord } from '../db/repos.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { SsrfGuard } from '../http/ssrf.js';

/**
 * Immutable, exportable audit trail for regulated deployments (bank-grade).
 *
 * Every event is hash-chained (each record's `hash` = sha256(prev_hash + canonical content)) and persisted
 * append-only (the repo has no update/delete), so tampering is detectable. Each event is ALSO exported
 * off-box in real time — a structured stdout line (`audit: true`, for k8s → SIEM log shipping) and, when
 * configured, POSTed to a SIEM webhook (Splunk HEC / generic) — so the record can't be altered after the
 * fact from inside Kravn. Records are serialized so the chain stays consistent, and an audit-write failure
 * never breaks the request path (the event is still exported).
 *
 * Known limits (documented for a compliance reviewer): the in-process chain is per-replica — across N
 * replicas each maintains its own chain (the durable off-box export is the cross-replica tamper-proofing).
 * True WORM at the storage layer (append-only DB grants, log immutability in the SIEM) is deployment config.
 */
export interface AuditEvent {
  category: 'config' | 'auth' | 'access' | 'tool' | 'system';
  action: string;
  actor?: { id: string; email: string; role: string } | null;
  resourceType?: string;
  resourceId?: string;
  outcome?: 'success' | 'failure';
  details?: Record<string, unknown>;
  ip?: string;
}

interface AuditDeps {
  repos: Repos;
  log: Logger;
  ssrf: SsrfGuard;
  settings: SettingsService;
}

// Field-name patterns whose values must never land in the audit trail. Key-based (covers the known
// credential fields on admin config routes — password, authValue, clientSecret, secret, token, apiKey…).
// Residual: a secret placed in an ARBITRARILY-named field would still pass (value-based scanning is a
// follow-up); the known admin secret fields below are all keyed.
const SECRET_KEY = /pass(word|phrase)?|pwd|secret|token|bearer|authorization|cookie|authvalue|api[_-]?key|client_?secret|private|credential|session[_-]?id/i;
const FIELD_SEP = '\u001f';

/** Deep-redact secret material and cap giant strings before an event is stored/exported. */
function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string' && v.length > 2000) return v.slice(0, 2000) + '…';
  return v;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return '"[unserializable]"';
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Canonical, fixed-order string hashed for the chain — reproducible byte-for-byte on verify. */
function canonical(r: AuditRecord): string {
  return [
    r.id, r.ts, r.category, r.action,
    r.actorId ?? '', r.actorEmail ?? '', r.actorRole ?? '',
    r.resourceType ?? '', r.resourceId ?? '', r.outcome, r.ip ?? '', r.details,
  ].join(FIELD_SEP);
}

export class AuditService {
  private lastHash = 'genesis';
  private tail: Promise<unknown> = Promise.resolve();
  private readonly siem: Logger;

  constructor(private d: AuditDeps) {
    this.siem = d.log.child({ audit: true, schema: 'kravn.audit.v1' });
  }

  /** Seed the chain from the stored tail so records continue the chain after a restart. */
  async init(): Promise<void> {
    try {
      this.lastHash = (await this.d.repos.auditLog.lastHash()) ?? 'genesis';
    } catch (err) {
      this.d.log.warn({ err }, 'audit: could not read chain tail; starting from genesis');
    }
  }

  /** Record an event (hash-chain → persist → export). Serialized so the chain stays consistent. */
  record(ev: AuditEvent): Promise<void> {
    const run = this.tail.catch(() => {}).then(() => this.doRecord(ev));
    this.tail = run;
    return run;
  }

  private async doRecord(ev: AuditEvent): Promise<void> {
    const rec: AuditRecord = {
      id: newId(),
      ts: new Date().toISOString(),
      category: ev.category,
      action: ev.action.slice(0, 191),
      actorId: ev.actor?.id ?? null,
      actorEmail: ev.actor?.email ?? null,
      actorRole: ev.actor?.role ?? null,
      resourceType: ev.resourceType ?? null,
      resourceId: ev.resourceId ? ev.resourceId.slice(0, 191) : null,
      outcome: ev.outcome ?? 'success',
      ip: ev.ip ?? null,
      details: safeJson(redact(ev.details ?? {})).slice(0, 50_000),
      prevHash: this.lastHash,
      hash: '',
    };
    rec.hash = sha256(rec.prevHash + FIELD_SEP + canonical(rec));

    try {
      await this.d.repos.auditLog.append(rec);
      this.lastHash = rec.hash; // only advance the chain once the row is durably stored
    } catch (err) {
      this.d.log.error({ err }, 'audit: persist failed (event still exported to SIEM)');
    }

    // Export #1 — structured stdout (always). k8s log collectors ship `audit:true` lines to the SIEM.
    this.siem.info(
      {
        id: rec.id, ts: rec.ts, category: rec.category, action: rec.action,
        actor_id: rec.actorId, actor_email: rec.actorEmail, actor_role: rec.actorRole,
        resource_type: rec.resourceType, resource_id: rec.resourceId,
        outcome: rec.outcome, ip: rec.ip, details: rec.details, prev_hash: rec.prevHash, hash: rec.hash,
      },
      'audit',
    );

    // Export #2 — optional SIEM webhook (fire-and-forget, SSRF-guarded so it can't be pointed at internal IPs).
    const url = this.d.settings.get().observability.auditWebhookUrl?.trim();
    if (url) void this.postWebhook(url, rec);
  }

  private async postWebhook(url: string, rec: AuditRecord): Promise<void> {
    try {
      await this.d.ssrf.assertUrlAllowed(url);
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rec),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.d.log.warn({ err }, 'audit: SIEM webhook delivery failed');
    }
  }

  /** Verify tamper-evidence over the most recent `limit` records (self-hash + in-window continuity). */
  async verify(limit = 1000): Promise<{ ok: boolean; checked: number; total: number; brokenAt?: string }> {
    const total = await this.d.repos.auditLog.count();
    const rows = (await this.d.repos.auditLog.recent(limit)).reverse(); // oldest → newest within the window
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (sha256(r.prevHash + FIELD_SEP + canonical(r)) !== r.hash) return { ok: false, checked: i + 1, total, brokenAt: r.id };
      if (i > 0 && r.prevHash !== rows[i - 1].hash) return { ok: false, checked: i + 1, total, brokenAt: r.id };
    }
    return { ok: true, checked: rows.length, total };
  }
}
