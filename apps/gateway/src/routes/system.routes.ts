import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { type BootstrapInfo } from '@kravn/contracts';
import type { Services } from '../services.js';
import { bearerToken, authenticateToken } from '../auth/plugin.js';
import { APP_VERSION } from '../version.js';

function tokenMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function systemRoutes(app: FastifyInstance, s: Services): void {
  // Public boot state — lets the SPA decide setup vs login without authentication.
  app.get('/api/bootstrap', async (): Promise<BootstrapInfo> => {
    const settings = s.settings.get();
    return {
      instanceName: settings.general.instanceName,
      version: APP_VERSION,
      setupRequired: await s.auth.setupRequired(),
      publicRegistration: settings.auth.publicRegistrationEnabled,
      passwordLoginEnabled: settings.auth.passwordLoginEnabled,
      ssoMethods: await s.sso.methods(),
      // White-label branding for the login + OAuth approval screens (public — only the branding subset).
      branding: settings.branding,
    };
  });

  // Health/readiness probes are hit every few seconds by k8s and flood stdout with request logs — silence
  // them entirely. Metrics is scraped constantly by Prometheus: drop the per-request info noise but keep
  // warn/error so a real problem (auth failure, disabled) still surfaces.
  app.get('/healthz', { logLevel: 'silent' }, async () => ({ status: 'ok' }));
  app.get('/readyz', { logLevel: 'silent' }, async () => ({ status: 'ok' }));

  app.get('/metrics', { logLevel: 'warn' }, async (req, reply) => {
    if (!s.settings.get().observability.metricsEnabled) {
      return reply.code(404).send({ error: { code: 'disabled', message: 'Metrics are disabled.' } });
    }
    // Never public: require the configured Prometheus token, or a signed-in Kravn user if no token is set.
    const token = bearerToken(req);
    const ok = s.env.metricsToken
      ? !!token && tokenMatches(token, s.env.metricsToken)
      : !!token && !!(await authenticateToken(token, s.jwt, s.repos));
    if (!ok) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Metrics require authentication.' } });
    }
    const { contentType, body } = await s.metrics.expose();
    reply.header('content-type', contentType).send(body);
  });
}
