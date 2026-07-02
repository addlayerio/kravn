import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
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
import { pipelineRoutes } from './routes/pipeline.routes.js';
import { llmRoutes } from './routes/llm.routes.js';
import { teamRoutes } from './routes/teams.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { userRoutes } from './routes/users.routes.js';
import { logRoutes } from './routes/logs.routes.js';
import { mcpRoutes } from './routes/mcp.routes.js';
import { overviewRoutes } from './routes/overview.routes.js';
import { oauthRoutes } from './routes/oauth.routes.js';
import { scimRoutes } from './routes/scim.routes.js';
import type { Services } from './services.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// NB: '/oauth' is intentionally NOT here. The real /oauth/{register,authorize,token} are registered routes
// (matched before the catch-all), while /oauth/consent is an SPA (Vue) route that MUST fall through to
// index.html. '/.well-known' is safe: all of its routes are server JSON, and there are no SPA routes under it.
const API_PREFIXES = ['/api', '/mcp', '/scim', '/metrics', '/healthz', '/readyz', '/.well-known'];

function resolveStaticDir(envStaticDir: string): string | null {
  if (envStaticDir) return path.resolve(envStaticDir);
  const candidate = path.resolve(__dirname, '../public'); // where Docker copies the built SPA
  return fs.existsSync(candidate) ? candidate : null;
}

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      // Strip the query string from request logs so a token/ticket carried as ?param= never lands in logs.
      serializers: {
        req(req: { method: string; url?: string; ip?: string }) {
          return { method: req.method, url: (req.url || '').split('?')[0], remoteAddress: req.ip };
        },
      },
      ...(services.env.isProd
        ? {}
        : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }),
    },
    bodyLimit: 5 * 1024 * 1024,
    // NOT `true` (which trusts a client-forgeable X-Forwarded-For, defeating IP rate limits). Default trusts
    // exactly one proxy hop (KRAVN_TRUST_PROXY); set 'false' for direct exposure or a CIDR list behind a CDN.
    trustProxy: services.env.trustProxy,
  });

  app.decorate('services', services);

  await app.register(cookie);

  // CORS: reflect ONLY the configured app origins (public URL + separate client SPA), never an arbitrary
  // Origin. Same-origin and server-to-server requests (no Origin header) are always allowed; the API is
  // Bearer-based with credentials:false, so a cross-origin site can't attach a victim's token.
  const allowedOrigins = new Set<string>();
  const addOrigin = (u: string) => {
    try {
      if (u) allowedOrigins.add(new URL(u).origin);
    } catch {
      /* ignore malformed */
    }
  };
  addOrigin(services.env.publicUrl);
  addOrigin(services.env.clientUrl);
  if (!services.env.isProd) {
    allowedOrigins.add('http://localhost:5173');
    allowedOrigins.add('http://localhost:5174');
  }
  await app.register(cors, {
    credentials: false,
    origin(origin, cb) {
      if (!origin || allowedOrigins.has(origin)) return cb(null, true);
      cb(null, false); // no Access-Control-Allow-Origin -> browser blocks the cross-origin read
    },
  });

  // Security headers on every response (defense-in-depth — the product must be safe without a CDN/WAF). Set
  // at onRequest (not onSend) so they're already staged before a streamed/hijacked response flushes headers.
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
  });
  // Parse application/x-www-form-urlencoded — the SAML HTTP-POST binding posts SAMLResponse/RelayState
  // as form fields to the ACS callback; without this Fastify rejects it with 415 Unsupported Media Type.
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 8 } });
  // SCIM clients (Entra ID) send `Content-Type: application/scim+json`; Fastify only parses
  // `application/json` by default, so SCIM POST/PUT/PATCH bodies would 415 ("UnsupportedMediaType").
  // Parse it as JSON, tolerating an empty body (→ {}), which also avoids the empty-JSON-body 400.
  app.addContentTypeParser('application/scim+json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const s = typeof body === 'string' ? body.trim() : '';
      done(null, s ? JSON.parse(s) : {});
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

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
      // Don't echo err.issues — it leaks field names/schema shape. Route handlers that want field-level
      // feedback use zod safeParse + the `parse()` helper, which returns a curated message.
      return reply.code(400).send({ error: { code: 'validation', message: 'Invalid request.' } });
    }
    // Client errors (e.g. malformed JSON body -> Fastify 400) should surface as 4xx, not a generic 500.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'bad_request', message: 'Malformed or invalid request.' } });
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
  oauthRoutes(app, services);

  // Control-plane + MCP gateway surface.
  if (wantGateway) {
    settingsRoutes(app, services);
    serverRoutes(app, services);
    registryRoutes(app, services);
    localPromptRoutes(app, services);
    pluginRoutes(app, services);
    pipelineRoutes(app, services);
    llmRoutes(app, services);
    teamRoutes(app, services);
    userRoutes(app, services);
    scimRoutes(app, services);
    logRoutes(app, services);
    mcpRoutes(app, services);
    overviewRoutes(app, services);
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
