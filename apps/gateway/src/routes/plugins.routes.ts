import type { FastifyInstance } from 'fastify';
import { updatePluginSchema, importPluginSchema } from '@kravn/contracts';
import type { Services } from '../services.js';
import { parse, sendError } from './_helpers.js';

export function pluginRoutes(app: FastifyInstance, s: Services): void {
  const read = { preHandler: [app.authenticate, app.authorize('settings.read')] };
  const write = { preHandler: [app.authenticate, app.authorize('settings.write')] };

  app.get('/api/plugins', read, async () => s.plugins.list());

  app.post('/api/plugins/rescan', write, async () => {
    await s.plugins.scan();
    return s.plugins.list();
  });

  app.post('/api/plugins/import', write, async (req, reply) => {
    const dto = parse(reply, importPluginSchema, req.body);
    if (!dto) return;
    try {
      const plugin = await s.plugins.importSource(dto.id, dto.source);
      return reply.code(201).send({ plugin });
    } catch (err) {
      return sendError(reply, 400, 'import_failed', err instanceof Error ? err.message : 'Import failed.');
    }
  });

  app.patch('/api/plugins/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = parse(reply, updatePluginSchema, req.body);
    if (!dto) return;
    try {
      if (dto.config !== undefined) await s.plugins.setConfig(id, dto.config);
      if (dto.enabled !== undefined) await s.plugins.setEnabled(id, dto.enabled);
      return s.plugins.list();
    } catch (err) {
      return sendError(reply, 400, 'update_failed', err instanceof Error ? err.message : 'Update failed.');
    }
  });

  app.delete('/api/plugins/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    await s.plugins.remove(id);
    return reply.code(204).send();
  });
}
