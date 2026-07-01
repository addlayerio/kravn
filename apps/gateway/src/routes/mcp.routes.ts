import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { permissionMatches } from '@kravn/contracts';
import type { Services } from '../services.js';
import type { JsonRpcRequest, McpScope } from '../mcp/downstream.js';
import { authenticateToken, bearerToken } from '../auth/plugin.js';
import type { AuthUser } from '../auth/auth.service.js';
import { deriveBaseUrl } from '../http/baseurl.js';

/**
 * Downstream MCP endpoints (Kravn AS an MCP server).
 *  - POST /mcp               -> the global catalog (the whole registry). ADMIN ONLY — it is not an
 *                              entitlement boundary, so exposing it to every mcp.invoke holder would let a
 *                              non-admin sidestep per-virtual-server / per-team restrictions. Consumers use
 *                              a specific virtual server instead.
 *  - POST /servers/:slug/mcp -> a virtual server, gated by ITS OWN access policy
 *      public        -> no auth
 *      authenticated -> any signed-in user (mcp.invoke)
 *      restricted    -> user is admin, OR role ∈ allowedRoles, OR a member of a team in allowedTeams; the
 *                       tools exposed are then narrowed to that user's per-team tool grant (all, or a subset)
 */
export function mcpRoutes(app: FastifyInstance, s: Services): void {
  // RFC 9728: on a 401 from an MCP endpoint, point clients (Claude, etc.) at the Protected Resource
  // Metadata so they can discover the OAuth authorization server and run the connect flow.
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode === 401) {
      const url = req.raw.url ?? '';
      if (url === '/mcp' || /^\/servers\/[^/]+\/mcp\b/.test(url)) {
        const base = deriveBaseUrl(req, s.settings, s.env);
        reply.header('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
      }
    }
    return payload;
  });

  async function handle(scope: McpScope | null, body: unknown, reply: FastifyReply, actor?: AuthUser) {
    if (!scope) return reply.code(404).send({ error: { code: 'not_found', message: 'No such MCP endpoint.' } });
    const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[];
    const responses = [];
    for (const m of messages) {
      const r = await s.downstream.dispatch(scope, m, actor);
      if (r) responses.push(r);
    }
    if (responses.length === 0) return reply.code(202).send();
    reply.header('content-type', 'application/json');
    return Array.isArray(body) ? responses : responses[0];
  }

  // Global endpoint: any signed-in user with mcp.invoke (accepts OAuth mcp-scoped tokens too — which is
  // why this uses a manual token check rather than app.authenticate, which rejects mcp-scoped tokens).
  app.post('/mcp', async (req, reply) => {
    const token = bearerToken(req);
    const user = token ? await authenticateToken(token, s.jwt, s.repos) : null;
    if (!user) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required.' } });
    }
    if (!permissionMatches(user.permissions, 'mcp.invoke')) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Not allowed to invoke MCP.' } });
    }
    // The global catalog is the whole registry — not entitlement-scoped. Only admins may use it; everyone
    // else must go through a specific virtual server, where the access policy + per-team tool grant apply.
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Use a specific virtual server; the global catalog is admin-only.' } });
    }
    const scope = await s.downstream.buildScope(null);
    return handle(scope, req.body, reply, user);
  });

  // Per-virtual-server endpoint with its own access policy.
  app.post('/servers/:slug/mcp', async (req: FastifyRequest, reply) => {
    const { slug } = req.params as { slug: string };
    const vs = await s.repos.virtualServers.getBySlug(slug);
    if (!vs || !vs.enabled) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such virtual server.' } });
    }

    let actor: AuthUser | undefined;
    if (vs.access !== 'public') {
      const token = bearerToken(req);
      const user = token ? await authenticateToken(token, s.jwt, s.repos) : null;
      if (!user) {
        return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required.' } });
      }
      if (!permissionMatches(user.permissions, 'mcp.invoke')) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'Not allowed to invoke MCP.' } });
      }
      if (vs.access === 'restricted' && user.role !== 'admin') {
        const roleOk = vs.allowedRoles.includes(user.role as any);
        const teamOk = vs.allowedTeams.some((t) => user.teams.includes(t));
        if (!roleOk && !teamOk) {
          return reply.code(403).send({ error: { code: 'forbidden', message: 'Your role/team cannot access this server.' } });
        }
      }
      actor = user;
    }

    const scope = await s.downstream.buildScope(slug);
    // Level-2 entitlement: narrow the exposed tools to this actor's per-team grant. Filtering scope.tools
    // covers BOTH tools/list and tools/call (dispatch resolves a call by finding the tool in scope.tools).
    if (scope && actor) {
      const allowed = await s.repos.teams.allowedToolIdsForUser(actor, vs);
      if (allowed) scope.tools = scope.tools.filter((t) => allowed.has(t.id));
    }
    return handle(scope, req.body, reply, actor);
  });
}
