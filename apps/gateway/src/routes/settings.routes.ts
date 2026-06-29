import type { FastifyInstance } from 'fastify';
import { SETTINGS_UI } from '@kravn/contracts';
import type { Services } from '../services.js';
import { sendError } from './_helpers.js';

export function settingsRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/settings', { preHandler: [app.authenticate, app.authorize('settings.read')] }, async () => {
    return { settings: s.settings.get(), ui: SETTINGS_UI };
  });

  app.put('/api/settings', { preHandler: [app.authenticate, app.authorize('settings.write')] }, async (req, reply) => {
    try {
      const updated = await s.settings.update(req.body);
      return { settings: updated };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid settings.';
      return sendError(reply, 400, 'invalid_settings', message);
    }
  });
}
