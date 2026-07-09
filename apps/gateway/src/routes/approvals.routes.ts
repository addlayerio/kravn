import type { FastifyInstance } from 'fastify';
import type { Services } from '../services.js';
import { currentUser } from '../auth/plugin.js';
import { sendError } from './_helpers.js';

/**
 * Human-in-the-loop approval queue (maker-checker). An admin lists calls held for approval and approves/denies
 * them; the held call (blocking in the approval-gate hook) is released as soon as the decision lands.
 */
export function approvalRoutes(app: FastifyInstance, s: Services): void {
  const read = { preHandler: [app.authenticate, app.authorize('servers.read')] };
  const write = { preHandler: [app.authenticate, app.authorize('servers.write')] };

  app.get('/api/approvals', read, async () => ({ approvals: await s.approvals.listPending() }));

  app.post('/api/approvals/:id/decision', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { approve?: boolean; reason?: string };
    if (typeof body.approve !== 'boolean') return sendError(reply, 400, 'bad_request', 'Provide { approve: boolean }.');
    try {
      const approval = await s.approvals.decide(id, body.approve, currentUser(req), (body.reason ?? '').slice(0, 500));
      return { approval };
    } catch (err) {
      return sendError(reply, 400, 'decision_failed', err instanceof Error ? err.message : 'Could not resolve the request.');
    }
  });
}
