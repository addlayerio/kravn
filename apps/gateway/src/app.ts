import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { registerAuth } from './auth/plugin.js';
import { AuthError } from './auth/auth.service.js';
import { systemRoutes } from './routes/system.routes.js';
import { setupRoutes } from './routes/setup.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { settingsRoutes } from './routes/settings.routes.js';
import { serverRoutes } from './routes/servers.routes.js';
import { registryRoutes } from './routes/registry.routes.js';
import { localPromptRoutes } from './routes/local-prompts.routes.js';
import { ssoRoutes } from './routes/sso.routes.js';
import { pluginRoutes } from './routes/plugins.routes.js';
import { llmRoutes } from './routes/llm.routes.js';
import { teamRoutes } from './routes/teams.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { userRoutes } from './routes/users.routes.js';
import { logRoutes } from './routes/logs.routes.js';
import { mcpRoutes } from './routes/mcp.routes.js';
import type { Services } from './services.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_PREFIXES = ['/api', '/mcp', '/metrics', '/healthz', '/readyz'];

function resolveStaticDir(envStaticDir: string): string | null {
  if (envStaticDir) return path.resolve(envStaticDir);
  const candidate = path.resolve(__dirname, '../public'); // where Docker copies the built SPA
  return fs.existsSync(candidate) ? candidate : null;
}

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      ...(services.env.isProd
        ? {}
        : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }),
    },
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  });

  app.decorate('services', services);

  await app.register(cookie);
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 8 } });

  registerAuth(app, {
    jwt: services.jwt,
    repos: services.repos,
    settings: services.settings,
    log: services.log,
    plugins: services.plugins,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AuthError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'validation', message: 'Invalid request.', details: err.issues } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error.' } });
  });

  // Route registration is gated by KRAVN_ROLE so the same image can run as a control-plane
  // pod (gateway), a dedicated end-user chat pod (chat), or everything (all, the default).
  const role = services.env.role;
  const wantGateway = role === 'all' || role === 'gateway';
  const wantChat = role === 'all' || role === 'chat';

  // Shared by every role: identity (auth/SSO), first-run setup, public bootstrap, health/metrics.
  systemRoutes(app, services);
  setupRoutes(app, services);
  authRoutes(app, services);
  ssoRoutes(app, services);

  // Control-plane + MCP gateway surface.
  if (wantGateway) {
    settingsRoutes(app, services);
    serverRoutes(app, services);
    registryRoutes(app, services);
    localPromptRoutes(app, services);
    pluginRoutes(app, services);
    llmRoutes(app, services);
    teamRoutes(app, services);
    userRoutes(app, services);
    logRoutes(app, services);
    mcpRoutes(app, services);
  }

  // End-user chat surface (the dedicated chat pod serves only this + the shared routes above).
  if (wantChat) {
    chatRoutes(app, services);
  }

  services.log.info({ role }, 'HTTP routes registered for role');
  if (wantChat && !wantGateway && !services.env.clientUrl) {
    services.log.warn('KRAVN_ROLE=chat without KRAVN_CLIENT_URL: SSO sign-in from the client app will fail until it is set.');
  }

  // Static operator SPA (single container) with history-mode fallback — gateway/all only.
  // A chat-role pod is API-only; the end-user client SPA is a separate deployable.
  const staticDir = wantGateway ? resolveStaticDir(services.env.staticDir) : null;
  if (staticDir) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    const indexHtml = path.join(staticDir, 'index.html');
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? '';
      if (API_PREFIXES.some((p) => url.startsWith(p))) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
      }
      try {
        return reply.type('text/html').send(fs.readFileSync(indexHtml));
      } catch {
        return reply.code(404).send({ error: { code: 'no_ui', message: 'Admin UI not built.' } });
      }
    });
  } else {
    services.log.warn('admin UI static directory not found; API-only mode (run the Vite dev server for the UI)');
    app.setNotFoundHandler((_req, reply) =>
      reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } }),
    );
  }

  return app;
}
