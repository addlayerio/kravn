import type { FastifyInstance, FastifyRequest } from 'fastify';
import { permissionMatches, permissionsForRole } from '@kravn/contracts';
import type { Services } from '../services.js';
import { currentUser } from '../auth/plugin.js';

/**
 * EventSource can't send an Authorization header, so the stream authenticates via a query PARAMETER. To keep
 * a full session bearer out of the URL (server/proxy access logs, browser history), the SPA first exchanges
 * its session for a short-lived, purpose-scoped 'logstream' TICKET (below) and passes THAT as ?ticket=.
 */
async function verifyStreamTicket(req: FastifyRequest, s: Services): Promise<boolean> {
  const ticket = (req.query as { ticket?: string })?.ticket ?? '';
  if (!ticket) return false;
  try {
    const claims = await s.jwt.verify(ticket);
    if (claims.scope !== 'logstream') return false; // never accept a session/mcp token here
    if (await s.repos.tokens.isRevoked(claims.jti)) return false;
    const user = await s.repos.users.getById(claims.sub);
    if (!user) return false;
    return permissionMatches(permissionsForRole(user.role), 'logs.read');
  } catch {
    return false;
  }
}

export function logRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/logs', { preHandler: [app.authenticate, app.authorize('logs.read')] }, async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 200);
    return { logs: s.logstore.recent(Number.isFinite(limit) ? limit : 200) };
  });

  // Exchange the session for a 60s, logs-scoped ticket the EventSource can carry in the URL safely.
  app.post('/api/logs/stream-ticket', { preHandler: [app.authenticate, app.authorize('logs.read')] }, async (req) => {
    const u = currentUser(req);
    const ticket = await s.jwt.sign({ userId: u.id, email: u.email, role: u.role, scope: 'logstream' }, 1);
    return { ticket };
  });

  app.get('/api/logs/stream', async (req, reply) => {
    if (!(await verifyStreamTicket(req, s))) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required.' } });
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const write = (event: unknown) => {
      try {
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* socket closed */
      }
    };

    for (const entry of s.logstore.recent(100)) write(entry);
    const unsubscribe = s.logstore.subscribe(write);
    const keepalive = setInterval(() => {
      try {
        raw.write(`event: keepalive\ndata: {}\n\n`);
      } catch {
        /* ignore */
      }
    }, 30_000);

    const cleanup = () => {
      clearInterval(keepalive);
      unsubscribe();
      try {
        raw.end();
      } catch {
        /* ignore */
      }
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });
}
