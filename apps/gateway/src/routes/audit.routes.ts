import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Services } from '../services.js';
import { sendError } from './_helpers.js';

/**
 * Read + verify the immutable audit trail. Gated by `audit.read` (admin-only by default; a bank can grant it
 * to a dedicated auditor role for segregation of duties). The trail is append-only — there is deliberately
 * no write/delete endpoint. The authoritative long-term copy lives off-box in the SIEM (see AuditService).
 */
export function auditRoutes(app: FastifyInstance, s: Services): void {
  // Filtered, paged audit events (newest first) for the console. Deep history / long retention lives in the SIEM.
  // `total` reflects the SAME filter, so the pager describes the filtered set, not the whole table.
  app.get('/api/audit', { preHandler: [app.authenticate, app.authorize('audit.read')] }, async (req: FastifyRequest, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    /** Thrown for a malformed filter; converted to a 400 below rather than silently returning an empty page. */
    class BadFilter extends Error {}
    const str = (v: string | undefined, max = 191): string | undefined => {
      const t = String(v ?? '').trim();
      return t ? t.slice(0, max) : undefined;
    };
    // The trail stores UTC ISO-8601. A bare calendar day (YYYY-MM-DD) is widened to a UTC day so the range is
    // unambiguous: `from` → start of that day, `to` → start of the NEXT day (the repo compares half-open, so
    // "to = today" still includes today). A full instant is passed through. Anything else is a 400.
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const bound = (v: string | undefined, endExclusive: boolean): string | undefined => {
      const t = str(v, 40);
      if (!t) return undefined;
      if (day.test(t)) {
        const d = new Date(`${t}T00:00:00.000Z`);
        if (Number.isNaN(d.getTime())) throw new BadFilter('invalid date');
        if (endExclusive) d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString();
      }
      const d = new Date(t);
      if (Number.isNaN(d.getTime())) throw new BadFilter('invalid date');
      return d.toISOString();
    };
    const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined => {
      const t = str(v);
      if (!t) return undefined;
      if (!(allowed as readonly string[]).includes(t)) throw new BadFilter('invalid filter value');
      return t as T;
    };

    let filter;
    try {
      filter = {
      category: str(q.category, 32),
      action: str(q.action),
      actor: str(q.actor, 255), // actor_email is varchar(255)
      actorMode: oneOf(q.actorMode, ['user', 'system'] as const),
      resourceType: str(q.resourceType, 64),
      resource: str(q.resource),
      outcome: oneOf(q.outcome, ['success', 'failure'] as const),
      from: bound(q.from, false),
      to: bound(q.to, true),
      };
    } catch (e) {
      if (e instanceof BadFilter) return sendError(reply, 400, 'invalid_filter', e.message);
      throw e;
    }
    // Clamp here too (not just in the repo) so the response can echo the values the client should page with.
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(q.limit ?? 100)) || 100));
    const offset = Math.max(0, Math.trunc(Number(q.offset ?? 0)) || 0);
    const [events, total] = await Promise.all([
      s.repos.auditLog.search(filter, limit, offset),
      s.repos.auditLog.countFiltered(filter),
    ]);
    return { events, total, limit, offset };
  });

  // Distinct values present in the trail, so the console's dropdowns only offer filters that can match.
  app.get('/api/audit/facets', { preHandler: [app.authenticate, app.authorize('audit.read')] }, async () => {
    return s.repos.auditLog.facets();
  });

  // Verify tamper-evidence: recompute the hash chain over the recent window and report the first break, if any.
  app.post('/api/audit/verify', { preHandler: [app.authenticate, app.authorize('audit.read')] }, async (req: FastifyRequest) => {
    const limit = Number((req.body as { limit?: number } | undefined)?.limit ?? 1000);
    return s.audit.verify(Number.isFinite(limit) ? limit : 1000);
  });
}
