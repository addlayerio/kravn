import type { FastifyInstance } from 'fastify';
import { SETTINGS_UI } from '@kravn/contracts';
import type { Services } from '../services.js';
import { sendError } from './_helpers.js';

export function settingsRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/settings', { preHandler: [app.authenticate, app.authorize('settings.read')] }, async () => {
    return { settings: s.settings.get(), ui: SETTINGS_UI };
  });

  app.put('/api/settings', { preHandler: [app.authenticate, app.authorize('settings.write')] }, async (req, reply) => {
    // Anti-lockout: never let an operator disable local password login unless an admin can still reach the
    // system via SSO — i.e. at least one SSO provider is enabled AND at least one admin email is designated.
    const wantPasswordOff =
      (req.body as { auth?: { passwordLoginEnabled?: boolean } })?.auth?.passwordLoginEnabled === false;
    if (wantPasswordOff && !(await s.sso.hasReachableAdmin())) {
      return sendError(
        reply,
        400,
        'passwordless_lockout',
        'Cannot disable local password login: first enable an SSO provider AND designate at least one admin email (Authentication page), or you would lock everyone out.',
      );
    }
    try {
      const updated = await s.settings.update(req.body);
      return { settings: updated };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid settings.';
      return sendError(reply, 400, 'invalid_settings', message);
    }
  });
}
