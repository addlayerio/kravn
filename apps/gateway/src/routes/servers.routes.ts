import type { FastifyInstance } from 'fastify';
import { createServerSchema, updateServerSchema } from '@kravn/contracts';
import type { Services } from '../services.js';
import { parse, sendError } from './_helpers.js';

export function serverRoutes(app: FastifyInstance, s: Services): void {
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
    const server = await s.registry.connectAndSync(id);
    if (!server) return sendError(reply, 404, 'not_found', 'Server not found.');
    return { server };
  });
}
