import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createServerSchema, updateServerSchema } from '@kravn/contracts';
import type { Services } from '../services.js';
import { currentUser } from '../auth/plugin.js';
import { deriveBaseUrl } from '../http/baseurl.js';
import { OAuthClientRequiredError } from '../auth/upstream-oauth.service.js';
import { parse, sendError } from './_helpers.js';

export function serverRoutes(app: FastifyInstance, s: Services): void {
  // A stdio upstream server spawns a LOCAL PROCESS on the gateway host — arbitrary command execution. Only
  // an admin (the instance owner) may create/run one, and only when the deployment allows it. This closes the
  // editor -> RCE path (servers.write is held by editors, but stdio must never be reachable by them).
  const stdioBlocked = (req: FastifyRequest, reply: FastifyReply, isStdio: boolean): boolean => {
    if (!isStdio) return false;
    if (!s.env.allowStdio) {
      sendError(reply, 403, 'stdio_disabled', 'Local (stdio) MCP servers are disabled on this deployment.');
      return true;
    }
    if (currentUser(req).role !== 'admin') {
      sendError(reply, 403, 'stdio_forbidden', 'Only an admin can create or run a local (stdio) MCP server.');
      return true;
    }
    return false;
  };

  app.get('/api/servers', { preHandler: [app.authenticate, app.authorize('servers.read')] }, async () => {
    return { servers: await s.registry.listServers() };
  });

  app.get('/api/servers/:id', { preHandler: [app.authenticate, app.authorize('servers.read')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const server = await s.registry.getServer(id);
    if (!server) return sendError(reply, 404, 'not_found', 'Server not found.');
    return { server };
  });

  app.post('/api/servers', { preHandler: [app.authenticate, app.authorize('servers.write')] }, async (req, reply) => {
    const dto = parse(reply, createServerSchema, req.body);
    if (!dto) return;
    if (stdioBlocked(req, reply, dto.transport === 'stdio')) return;
    try {
      const server = await s.registry.createServer(dto);
      return reply.code(201).send({ server });
    } catch (err) {
      return sendError(reply, 400, 'create_failed', err instanceof Error ? err.message : 'Could not create server.');
    }
  });

  app.patch('/api/servers/:id', { preHandler: [app.authenticate, app.authorize('servers.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = parse(reply, updateServerSchema, req.body);
    if (!dto) return;
    const existing = await s.registry.getServer(id);
    if (!existing) return sendError(reply, 404, 'not_found', 'Server not found.');
    if (stdioBlocked(req, reply, existing.transport === 'stdio')) return;
    try {
      const server = await s.registry.updateServer(id, dto);
      if (!server) return sendError(reply, 404, 'not_found', 'Server not found.');
      return { server };
    } catch (err) {
      return sendError(reply, 400, 'update_failed', err instanceof Error ? err.message : 'Could not update server.');
    }
  });

  app.delete('/api/servers/:id', { preHandler: [app.authenticate, app.authorize('servers.delete')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await s.registry.deleteServer(id);
    return reply.code(204).send();
  });

  app.post('/api/servers/:id/sync', { preHandler: [app.authenticate, app.authorize('servers.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await s.registry.getServer(id);
    if (!existing) return sendError(reply, 404, 'not_found', 'Server not found.');
    if (stdioBlocked(req, reply, existing.transport === 'stdio')) return;
    const server = await s.registry.connectAndSync(id);
    if (!server) return sendError(reply, 404, 'not_found', 'Server not found.');
    return { server };
  });

  // Begin an upstream OAuth 2.1 authorization for an OAuth-protected remote MCP server. Returns the URL the
  // admin's browser must visit to sign in; the AS then redirects to the public /oauth/upstream/callback.
  app.post('/api/servers/:id/oauth/authorize', { preHandler: [app.authenticate, app.authorize('servers.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as {
      clientId?: string;
      clientSecret?: string;
      authorizationUrl?: string;
      tokenUrl?: string;
      issuer?: string;
      scope?: string;
      tokenAuthMethod?: string;
    };
    const server = await s.registry.getServer(id);
    if (!server) return sendError(reply, 404, 'not_found', 'Server not found.');
    const redirectUri = `${deriveBaseUrl(req, s.settings, s.env)}/oauth/upstream/callback`;
    try {
      const authorizationUrl = await s.upstreamOAuth.startAuthorization(server, redirectUri, {
        clientId: b.clientId,
        clientSecret: b.clientSecret,
        authorizationUrl: b.authorizationUrl,
        tokenUrl: b.tokenUrl,
        issuer: b.issuer,
        scope: b.scope,
        tokenAuthMethod: b.tokenAuthMethod,
      });
      return { authorizationUrl };
    } catch (err) {
      // No auto-registration + no client provided → ask the UI to collect client credentials.
      if (err instanceof OAuthClientRequiredError) return sendError(reply, 400, 'oauth_needs_client', err.message);
      return sendError(reply, 400, 'oauth_start_failed', err instanceof Error ? err.message : 'Could not start OAuth authorization.');
    }
  });

  // Read the saved OAuth config for a server (never returns the client secret) — for the edit form.
  app.get('/api/servers/:id/oauth/config', { preHandler: [app.authenticate, app.authorize('servers.read')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await s.registry.getServer(id))) return sendError(reply, 404, 'not_found', 'Server not found.');
    return { config: await s.upstreamOAuth.getConfigForDisplay(id) };
  });

  // Persist the OAuth config (endpoints + client) so it survives failed Connects and is editable.
  app.put('/api/servers/:id/oauth/config', { preHandler: [app.authenticate, app.authorize('servers.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { clientId?: string; clientSecret?: string; authorizationUrl?: string; tokenUrl?: string; issuer?: string; scope?: string; tokenAuthMethod?: string };
    if (!(await s.registry.getServer(id))) return sendError(reply, 404, 'not_found', 'Server not found.');
    await s.upstreamOAuth.saveConfig(id, b);
    return reply.code(204).send();
  });

  // ── Native plugin INSTANCES ──────────────────────────────────────────────────────────────────────
  // A native integration (Azure, Outlook, …) can be added more than once: each instance is a plugin-backed
  // server with its own credentials, composable into different endpoints. This creates one.
  app.post('/api/servers/plugin-instance', { preHandler: [app.authenticate, app.authorize('servers.write')] }, async (req, reply) => {
    const b = (req.body ?? {}) as { typeId?: string; name?: string; config?: Record<string, unknown> };
    if (!b.typeId || !b.name) return sendError(reply, 400, 'invalid', 'typeId and name are required.');
    try {
      const server = await s.registry.createPluginInstance(b.typeId, String(b.name), b.config ?? {});
      return reply.code(201).send({ server });
    } catch (err) {
      return sendError(reply, 400, 'create_failed', err instanceof Error ? err.message : 'Could not create instance.');
    }
  });

  // Masked config for a plugin instance's edit form (secret values are blanked; secretsSet says which are set).
  app.get('/api/servers/:id/plugin-config', { preHandler: [app.authenticate, app.authorize('servers.read')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = await s.registry.getInstanceConfigView(id);
    if (!view) return sendError(reply, 404, 'not_found', 'Plugin instance not found.');
    return view;
  });

  // Update a plugin instance's config (secrets are write-only: leave blank to keep the stored value).
  app.patch('/api/servers/:id/plugin-config', { preHandler: [app.authenticate, app.authorize('servers.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { config?: Record<string, unknown> };
    try {
      const server = await s.registry.setInstanceConfig(id, b.config ?? {});
      if (!server) return sendError(reply, 404, 'not_found', 'Plugin instance not found.');
      return { server };
    } catch (err) {
      return sendError(reply, 400, 'update_failed', err instanceof Error ? err.message : 'Could not update config.');
    }
  });
}
