import type { FastifyInstance, FastifyRequest } from 'fastify';
import { permissionMatches, permissionsForRole } from '@kravn/contracts';
import type { Services } from '../services.js';

/** EventSource cannot send Authorization headers, so the stream authenticates via a query token. */
async function authViaQuery(req: FastifyRequest, s: Services): Promise<boolean> {
  const q = req.query as { token?: string };
  const header = req.headers.authorization;
  const token = q.token || (header?.startsWith('Bearer ') ? header.slice(7) : '');
  if (!token) return false;
  try {
    const claims = await s.jwt.verify(token);
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

  app.get('/api/logs/stream', async (req, reply) => {
    if (!(await authViaQuery(req, s))) {
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
