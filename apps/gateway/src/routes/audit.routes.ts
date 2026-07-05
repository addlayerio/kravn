import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Services } from '../services.js';

/**
 * Read + verify the immutable audit trail. Gated by `audit.read` (admin-only by default; a bank can grant it
 * to a dedicated auditor role for segregation of duties). The trail is append-only — there is deliberately
 * no write/delete endpoint. The authoritative long-term copy lives off-box in the SIEM (see AuditService).
 */
export function auditRoutes(app: FastifyInstance, s: Services): void {
  // Most recent audit events (newest first), for the console. Deep history / long retention lives in the SIEM.
  app.get('/api/audit', { preHandler: [app.authenticate, app.authorize('audit.read')] }, async (req: FastifyRequest) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 200);
    const events = await s.repos.auditLog.recent(Number.isFinite(limit) ? limit : 200);
    return { events, total: await s.repos.auditLog.count() };
  });

  // Verify tamper-evidence: recompute the hash chain over the recent window and report the first break, if any.
  app.post('/api/audit/verify', { preHandler: [app.authenticate, app.authorize('audit.read')] }, async (req: FastifyRequest) => {
    const limit = Number((req.body as { limit?: number } | undefined)?.limit ?? 1000);
    return s.audit.verify(Number.isFinite(limit) ? limit : 1000);
  });
}
