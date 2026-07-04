import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { permissionMatches } from '@kravn/contracts';
import type { Services } from '../services.js';
import type { JsonRpcRequest, McpScope } from '../mcp/downstream.js';
import { authenticateToken, bearerToken } from '../auth/plugin.js';
import type { AuthUser } from '../auth/auth.service.js';
import { canConsumeMcpEndpoint } from '../mcp/endpoint-access.js';
import { deriveBaseUrl } from '../http/baseurl.js';

/**
 * Deny with 403 + the RFC 6750 `insufficient_scope` challenge. This tells an MCP client (Claude, ChatGPT,
 * Gemini, …) that the failure is an AUTHORIZATION one — a valid token that simply lacks the required
 * permission — not a credentials problem, so it can surface the reason instead of a generic
 * "check your credentials". The message is echoed as `error_description`, sanitised to a valid
 * quoted-string so it can't break (or inject into) the header.
 */
function forbidden(reply: FastifyReply, message: string) {
  const desc = message.replace(/[\r\n"\\]/g, ' ').trim();
  reply.header('WWW-Authenticate', `Bearer error="insufficient_scope", error_description="${desc}"`);
  return reply.code(403).send({ error: { code: 'forbidden', message } });
}

/**
 * Downstream MCP endpoints (Kravn AS an MCP server).
 *  - POST /mcp               -> the global catalog (the whole registry). ADMIN ONLY — it is not an
 *                              entitlement boundary, so exposing it to every mcp.invoke holder would let a
 *                              non-admin sidestep per-mcp-endpoint / per-team restrictions. Consumers use
 *                              a specific virtual server instead.
 *  - POST /servers/:slug/mcp -> a virtual server, gated by ITS OWN access policy
 *      public        -> no auth
 *      authenticated -> any signed-in user (mcp.invoke)
 *      restricted    -> a member of a team in allowedTeams (platform role/admin is NOT an axis — data plane);
 *                       the tools exposed are then narrowed to that user's per-team tool grant (all, or subset)
 */
export function mcpRoutes(app: FastifyInstance, s: Services): void {
  // RFC 9728: on a 401 from an MCP endpoint, point clients (Claude, etc.) at the Protected Resource
  // Metadata so they can discover the OAuth authorization server and run the connect flow.
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode === 401) {
      const url = req.raw.url ?? '';
      if (url === '/mcp' || /^\/(?:servers|endpoints)\/[^/]+\/mcp\b/.test(url)) {
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
      return forbidden(reply, 'Your account is not permitted to invoke MCP tools.');
    }
    // The global catalog is the whole registry — not entitlement-scoped. Only admins may use it; everyone
    // else must go through a specific virtual server, where the access policy + per-team tool grant apply.
    if (user.role !== 'admin') {
      return forbidden(reply, 'The global MCP catalog is admin-only. Connect to a specific MCP endpoint (/endpoints/<slug>/mcp) instead.');
    }
    const scope = await s.downstream.buildScope(null);
    return handle(scope, req.body, reply, user);
  });

  // Per-MCP-endpoint route with its own access policy. The canonical path is /endpoints/:slug/mcp;
  // /servers/:slug/mcp is kept as a backward-compatible alias for clients configured before the rename.
  const endpointHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const { slug } = req.params as { slug: string };
    const vs = await s.repos.mcpEndpoints.getBySlug(slug);
    if (!vs || !vs.enabled) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such MCP endpoint.' } });
    }

    let actor: AuthUser | undefined;
    if (vs.access !== 'public') {
      const token = bearerToken(req);
      const user = token ? await authenticateToken(token, s.jwt, s.repos) : null;
      if (!user) {
        return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required.' } });
      }
      if (!permissionMatches(user.permissions, 'mcp.invoke')) {
        return forbidden(reply, 'Your account is not permitted to invoke MCP tools.');
      }
      // DATA-PLANE gate: consumption is by team membership only (see endpoint-access.ts). Platform role /
      // admin-ness is NOT an axis here — an admin consumes a restricted endpoint by being in its team.
      if (!canConsumeMcpEndpoint(vs, user)) {
        // Record the denial so an admin can diagnose it from the Logs view (who, their teams, which endpoint,
        // which teams it requires) — turning an opaque client-side "authorization failed" into a clear cause.
        s.logstore.add('warn', `MCP access denied: "${user.email}" is not in a team allowed to use endpoint "${slug}"`, {
          event: 'mcp.access.denied',
          endpoint: slug,
          userId: user.id,
          userEmail: user.email,
          userTeams: user.teams,
          allowedTeams: vs.allowedTeams,
        });
        return forbidden(
          reply,
          `Access to the MCP endpoint "${slug}" is restricted to specific teams and your account is not a member of one. ` +
            'Ask a Kravn administrator to grant one of your teams access to this endpoint.',
        );
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
  };
  app.post('/endpoints/:slug/mcp', endpointHandler);
  app.post('/servers/:slug/mcp', endpointHandler);
}
