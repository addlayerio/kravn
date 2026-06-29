import type { FastifyInstance } from 'fastify';
import { KRAVN_VERSION, type BootstrapInfo } from '@kravn/contracts';
import type { Services } from '../services.js';

export function systemRoutes(app: FastifyInstance, s: Services): void {
  // Public boot state — lets the SPA decide setup vs login without authentication.
  app.get('/api/bootstrap', async (): Promise<BootstrapInfo> => {
    const settings = s.settings.get();
    return {
      instanceName: settings.general.instanceName,
      version: KRAVN_VERSION,
      setupRequired: await s.auth.setupRequired(),
      publicRegistration: settings.auth.publicRegistrationEnabled,
      passwordLoginEnabled: true,
      ssoMethods: await s.sso.methods(),
    };
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => ({ status: 'ok' }));

  app.get('/metrics', async (req, reply) => {
    if (!s.settings.get().observability.metricsEnabled) {
      return reply.code(404).send({ error: { code: 'disabled', message: 'Metrics are disabled.' } });
    }
    const { contentType, body } = await s.metrics.expose();
    reply.header('content-type', contentType).send(body);
  });
}
