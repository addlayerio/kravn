import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from '../services.js';
import { OAuthError, OAUTH_BINDING_COOKIE } from '../auth/oauth.service.js';
import { LoginRateLimiter } from '../auth/rate-limit.js';
import { deriveBaseUrl } from '../http/baseurl.js';
import { currentUser } from '../auth/plugin.js';

function oauthError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof OAuthError) {
    return reply.code(err.status).send({ error: err.error, error_description: err.description });
  }
  return reply.code(500).send({ error: 'server_error', error_description: 'Unexpected error.' });
}

// Burst protection for the public OAuth endpoints (per IP). The absolute client cap lives in the service.
const OAUTH_WINDOW_SEC = 300;
const REGISTER_MAX = 40;
const FLOW_MAX = 240;

/**
 * OAuth 2.1 authorization-server + discovery endpoints for the MCP resource. Spec-facing endpoints live at
 * the well-known / root paths clients expect; the consent endpoints the SPA drives live under /api (bearer).
 */
export function oauthRoutes(app: FastifyInstance, s: Services): void {
  const limiter = new LoginRateLimiter(s.sharedStore, 'oauth');
  const rateLimited = async (req: FastifyRequest, reply: FastifyReply, bucket: string, max: number): Promise<boolean> => {
    const key = `${bucket}:${req.ip}`;
    await limiter.recordFailure(key, OAUTH_WINDOW_SEC);
    const wait = await limiter.blockedFor(key, max);
    if (wait > 0) {
      reply.header('Retry-After', String(wait));
      reply.code(429).send({ error: 'temporarily_unavailable', error_description: 'Too many requests.' });
      return true;
    }
    return false;
  };

  // ─── Discovery (RFC 8414 / RFC 9728) — public JSON, never cached (anti AS-mixup/cache-poison) ────
  const asMetadata = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    return s.oauth.authServerMetadata(deriveBaseUrl(req, s.settings, s.env));
  };
  app.get('/.well-known/oauth-authorization-server', asMetadata);
  app.get('/.well-known/oauth-authorization-server/*', asMetadata);
  app.get('/.well-known/openid-configuration', asMetadata);

  const prMetadata = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    return s.oauth.protectedResourceMetadata(deriveBaseUrl(req, s.settings, s.env));
  };
  app.get('/.well-known/oauth-protected-resource', prMetadata);
  app.get('/.well-known/oauth-protected-resource/*', prMetadata);

  // ─── Dynamic Client Registration (RFC 7591) — public, rate-limited, absolute-capped in the service ──
  app.post('/oauth/register', async (req, reply) => {
    if (await rateLimited(req, reply, 'oreg', REGISTER_MAX)) return reply;
    try {
      const out = await s.oauth.registerClient((req.body ?? {}) as Record<string, unknown>);
      return reply.code(201).send(out);
    } catch (err) {
      return oauthError(reply, err);
    }
  });

  // ─── Authorize (browser): validate, set the anti-fixation binding cookie, then hand off to login ─────
  app.get('/oauth/authorize', async (req, reply) => {
    if (await rateLimited(req, reply, 'oflow', FLOW_MAX)) return reply;
    void s.oauth.gc();
    const result = await s.oauth.startAuthorize((req.query ?? {}) as Record<string, string>);
    if (result.kind === 'redirect') return reply.redirect(result.url);
    if (result.kind === 'error') {
      return reply
        .code(400)
        .type('text/html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Authorization error</title>` +
            `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;color:#1f2937">` +
            `<h2>Authorization error</h2><p>${escapeHtml(result.message)}</p></body>`,
        );
    }
    // Bind this browser to the request: only a browser holding this cookie can approve the pending id.
    reply.setCookie(OAUTH_BINDING_COOKIE, result.binding, {
      httpOnly: true,
      sameSite: 'lax',
      secure: s.env.isProd,
      path: '/',
      maxAge: 600,
    });
    return reply.redirect(`/oauth/consent?req=${encodeURIComponent(result.pendingId)}`);
  });

  // ─── Token endpoint — public, PKCE-protected ────────────────────────────────────────────────────
  app.post('/oauth/token', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (await rateLimited(req, reply, 'oflow', FLOW_MAX)) return reply;
    try {
      return reply.send(await s.oauth.token((req.body ?? {}) as Record<string, unknown>));
    } catch (err) {
      return oauthError(reply, err);
    }
  });

  // ─── Consent (SPA-driven, bearer + binding-cookie authenticated) ────────────────────────────────
  const binding = (req: FastifyRequest): string =>
    (req.cookies as Record<string, string> | undefined)?.[OAUTH_BINDING_COOKIE] ?? '';

  app.get('/api/oauth/consent/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { consent: await s.oauth.consentInfo(id, binding(req)) };
    } catch (err) {
      return oauthError(reply, err);
    }
  });

  app.post('/api/oauth/consent/:id/decision', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const approve = (req.body as { approve?: boolean })?.approve === true;
    try {
      const out = approve
        ? await s.oauth.approve(id, currentUser(req), binding(req))
        : await s.oauth.deny(id, binding(req));
      return { redirect: out.redirect };
    } catch (err) {
      return oauthError(reply, err);
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
