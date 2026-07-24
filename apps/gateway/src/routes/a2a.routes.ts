import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { permissionMatches, A2A_ERROR } from '@kravn/contracts';
import type { Services } from '../services.js';
import { authenticateToken, bearerToken } from '../auth/plugin.js';
import { deriveBaseUrl } from '../http/baseurl.js';
import { openSse } from './_sse.js';
import { rpcErrorOf } from '../a2a/a2a.service.js';

/**
 * A2A (Agent2Agent) SERVER surface — Kravn published as a governed agent.
 *
 *  - GET  /.well-known/agent-card.json  → public discovery card (restricted skills hidden). 404 when the
 *                                         A2A server is not enabled in Settings.
 *  - POST /a2a                          → A2A JSON-RPC 2.0. Bearer-auth (accepts OAuth mcp-scoped tokens,
 *                                         like the MCP data plane), gated by `a2a.invoke`. Streaming methods
 *                                         (message/stream, tasks/resubscribe) answer over SSE.
 *  - GET  /api/a2a/card                 → operator preview of the published card (control-plane, settings.read).
 *  - GET  /api/a2a/tasks                → recent A2A tasks for the operator's A2A view (settings.read).
 */
export function a2aRoutes(app: FastifyInstance, s: Services): void {
  // RFC 9728: on a 401 from /a2a, advertise the OAuth Protected Resource Metadata so A2A clients can run
  // the same OAuth 2.1 connect flow MCP clients use.
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode === 401 && (req.raw.url ?? '') === '/a2a') {
      const base = deriveBaseUrl(req, s.settings, s.env);
      reply.header('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
    }
    return payload;
  });

  // ── Public discovery card ──────────────────────────────────────────────────────────────────────
  app.get('/.well-known/agent-card.json', async (req, reply) => {
    if (!s.a2a.enabled()) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'A2A is not enabled on this instance.' } });
    }
    reply.header('Cache-Control', 'no-store');
    return s.a2a.buildAgentCard(deriveBaseUrl(req, s.settings, s.env));
  });

  // ── A2A JSON-RPC endpoint ──────────────────────────────────────────────────────────────────────
  app.post('/a2a', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!s.a2a.enabled()) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'A2A is not enabled on this instance.' } });
    }
    // Data-plane auth: manual bearer check (accepts OAuth mcp-scoped tokens, which app.authenticate rejects).
    const token = bearerToken(req);
    const user = token ? await authenticateToken(token, s.jwt, s.repos) : null;
    if (!user) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required.' } });
    }
    if (!permissionMatches(user.permissions, 'a2a.invoke')) {
      const desc = 'Your account is not permitted to delegate A2A tasks.';
      reply.header('WWW-Authenticate', `Bearer error="insufficient_scope", error_description="${desc}"`);
      return reply.code(403).send({ error: { code: 'forbidden', message: desc } });
    }

    const body = (req.body ?? {}) as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    const id = body.id ?? null;
    const method = body.method;
    if (typeof method !== 'string') {
      reply.header('content-type', 'application/json');
      return { jsonrpc: '2.0', id, error: { code: A2A_ERROR.INVALID_REQUEST, message: 'Missing JSON-RPC method.' } };
    }

    // Authenticated extended Agent Card — resolved here because it needs the request base URL.
    if (method === 'agent/getAuthenticatedExtendedCard') {
      reply.header('content-type', 'application/json');
      return { jsonrpc: '2.0', id, result: await s.a2a.buildAgentCard(deriveBaseUrl(req, s.settings, s.env), user) };
    }

    // Streaming methods answer over SSE (one JSON-RPC result frame per event).
    if (method === 'message/stream' || method === 'tasks/resubscribe') {
      const sse = openSse(reply);
      const emit = (result: unknown) => sse.send('message', { jsonrpc: '2.0', id, result });
      try {
        if (method === 'message/stream') await s.a2a.streamSend(body.params, user, req.ip, emit);
        else await s.a2a.resubscribe(body.params, user, emit, () => sse.closed());
      } catch (e) {
        sse.send('message', { jsonrpc: '2.0', id, error: rpcErrorOf(e) });
      } finally {
        sse.close();
      }
      return; // hijacked — Fastify sends nothing further
    }

    const outcome = await s.a2a.dispatch(method, body.params, user, req.ip);
    reply.header('content-type', 'application/json');
    return 'result' in outcome
      ? { jsonrpc: '2.0', id, result: outcome.result }
      : { jsonrpc: '2.0', id, error: outcome.error };
  });

  // ── Operator (control-plane) ─────────────────────────────────────────────────────────────────────
  app.get('/api/a2a/card', { preHandler: [app.authenticate, app.authorize('settings.read')] }, async (req) => {
    // Preview EVERY exposed+enabled skill (not per-caller entitlement) so the operator sees the full surface.
    return { card: await s.a2a.buildAgentCard(deriveBaseUrl(req, s.settings, s.env), undefined, { all: true }), enabled: s.a2a.enabled() };
  });

  app.get('/api/a2a/tasks', { preHandler: [app.authenticate, app.authorize('settings.read')] }, async (req) => {
    const limit = Number((req.query as { limit?: string })?.limit) || 100;
    return { tasks: await s.a2a.listTaskSummaries(limit) };
  });
}
