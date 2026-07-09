import type { FastifyInstance } from 'fastify';
import type { Services } from '../services.js';

/**
 * Live updates over Server-Sent Events — the standard way the operator learns of changes, instead of polling
 * an API on a timer. Authenticated (Bearer, via a fetch-based EventSource on the client, so the token rides
 * the Authorization header). Emits named events from the in-process EventBus; a heartbeat comment keeps the
 * connection open through proxies.
 */
export function eventRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/events', { preHandler: [app.authenticate], logLevel: 'warn' }, async (req, reply) => {
    reply.hijack(); // we own the socket; Fastify won't send a response
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // don't let nginx buffer the stream
    });
    raw.write('retry: 3000\n\n'); // client reconnect hint
    raw.write(': connected\n\n');

    const send = (event: string) => {
      try {
        raw.write(`event: ${event}\ndata: {}\n\n`);
      } catch {
        /* socket closed */
      }
    };
    const onRegistry = () => send('registry');
    const onApprovals = () => send('approvals');
    s.events.on('registry', onRegistry);
    s.events.on('approvals', onApprovals);
    const heartbeat = setInterval(() => {
      try {
        raw.write(': hb\n\n');
      } catch {
        /* socket closed */
      }
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      s.events.off('registry', onRegistry);
      s.events.off('approvals', onApprovals);
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });
}
