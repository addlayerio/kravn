import type { FastifyInstance, FastifyReply } from 'fastify';
import { updateAuthConfigSchema, importSamlMetadataSchema } from '@kravn/contracts';
import type { Services } from '../services.js';
import { AuthError } from '../auth/auth.service.js';
import { deriveBaseUrl } from '../http/baseurl.js';
import { parseSamlMetadata } from '../auth/saml-metadata.js';
import { safeFetch } from '../http/client.js';
import { parse, sendError } from './_helpers.js';
import type { SsoLoginResult } from '../auth/sso.service.js';

export function ssoRoutes(app: FastifyInstance, s: Services): void {
  // ─── Config (admin) ──────────────────────────────────────────────────────────────────────────
  app.get('/api/auth/config', { preHandler: [app.authenticate, app.authorize('settings.read')] }, async (req) => {
    return { config: await s.sso.view(deriveBaseUrl(req, s.settings, s.env)) };
  });

  app.put('/api/auth/config', { preHandler: [app.authenticate, app.authorize('settings.write')] }, async (req, reply) => {
    const dto = parse(reply, updateAuthConfigSchema, req.body);
    if (!dto) return;
    try {
      await s.sso.save(dto);
      return { config: await s.sso.view(deriveBaseUrl(req, s.settings, s.env)) };
    } catch (err) {
      return sendError(reply, 400, 'save_failed', err instanceof Error ? err.message : 'Could not save config.');
    }
  });

  // Import IdP config from federation metadata (URL fetched SSRF-safe, or pasted XML).
  app.post('/api/auth/sso/saml/import-metadata', { preHandler: [app.authenticate, app.authorize('settings.write')] }, async (req, reply) => {
    const dto = parse(reply, importSamlMetadataSchema, req.body);
    if (!dto) return;
    try {
      let xml = dto.xml.trim();
      if (!xml) {
        if (!dto.url) return sendError(reply, 400, 'no_input', 'Provide a metadata URL or paste the XML.');
        await s.ssrf.assertUrlAllowed(dto.url);
        const res = await safeFetch(dto.url, { headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml, */*' } }, 15_000);
        if (!res.ok) return sendError(reply, 400, 'fetch_failed', `Could not fetch metadata (HTTP ${res.status}).`);
        xml = await res.text();
        if (xml.length > 5_000_000) return sendError(reply, 400, 'too_large', 'Metadata document is too large.');
      }
      const metadata = parseSamlMetadata(xml);
      return { metadata };
    } catch (err) {
      return sendError(reply, 400, 'parse_failed', err instanceof Error ? err.message : 'Could not parse metadata.');
    }
  });

  // ─── OAuth2 / OIDC ──────────────────────────────────────────────────────────────────────────
  app.get('/api/auth/sso/oauth/:id/start', async (req, reply) => {
    const { id } = req.params as { id: string };
    const returnTo = resolveReturnTo((req.query as { returnTo?: string }).returnTo);
    try {
      const url = await s.sso.oauthStart(id, deriveBaseUrl(req, s.settings, s.env), returnTo);
      return reply.redirect(url);
    } catch (err) {
      return ssoError(reply, req, s, err);
    }
  });

  app.get('/api/auth/sso/oauth/:id/callback', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await s.sso.oauthCallback(id, req.query as Record<string, unknown>);
      return redirectWithToken(reply, s, result);
    } catch (err) {
      return ssoError(reply, req, s, err);
    }
  });

  // ─── SAML ───────────────────────────────────────────────────────────────────────────────────
  app.get('/api/auth/sso/saml/start', async (req, reply) => {
    const returnTo = resolveReturnTo((req.query as { returnTo?: string }).returnTo);
    try {
      const url = await s.sso.samlStart(deriveBaseUrl(req, s.settings, s.env), returnTo);
      return reply.redirect(url);
    } catch (err) {
      return ssoError(reply, req, s, err);
    }
  });

  // ACS — the IdP POSTs the SAMLResponse here.
  app.post('/api/auth/sso/saml/callback', async (req, reply) => {
    try {
      const result = await s.sso.samlCallback(deriveBaseUrl(req, s.settings, s.env), req.body as { SAMLResponse?: string; RelayState?: string });
      return redirectWithToken(reply, s, result);
    } catch (err) {
      return ssoError(reply, req, s, err);
    }
  });
}

/** Allowlist the return target. Only the two known SPAs — never a raw URL (prevents open-redirect / token leak). */
function resolveReturnTo(raw: unknown): 'operator' | 'client' {
  return raw === 'client' ? 'client' : 'operator';
}

/**
 * Redirect to a SPA's /login carrying one query param, WITHOUT trusting request headers
 * (the JWT must never be sent to a host-header-derived origin — CWE-644 host-header injection).
 *  - operator: same-origin RELATIVE redirect; the operator SPA is served by the gateway, so the
 *    browser resolves it against the real current origin — unspoofable.
 *  - client: absolute, operator-configured KRAVN_CLIENT_URL (validated as an http(s) URL at boot).
 *    If unset, fail loudly rather than redirect a token to a dead or wrong origin.
 */
function loginRedirect(reply: FastifyReply, s: Services, returnTo: 'operator' | 'client', key: string, value: string) {
  const query = `${key}=${encodeURIComponent(value)}`;
  if (returnTo === 'client') {
    if (!s.env.clientUrl) {
      return reply.code(500).type('text/plain').send('Client SSO return is not configured. Set KRAVN_CLIENT_URL.');
    }
    return reply.redirect(`${s.env.clientUrl}/login?${query}`);
  }
  return reply.redirect(`/login?${query}`);
}

function redirectWithToken(reply: FastifyReply, s: Services, result: SsoLoginResult) {
  // Hand the token to the SPA, which captures it on the login route.
  return loginRedirect(reply, s, resolveReturnTo(result.returnTo), 'token', result.token);
}

function ssoError(reply: FastifyReply, req: any, s: Services, err: unknown) {
  const message = err instanceof AuthError ? err.message : err instanceof Error ? err.message : 'SSO login failed.';
  s.log.warn({ err }, 'SSO login error');
  // On failure the OAuth state is already consumed, so recover returnTo from the start query
  // (?returnTo=) or the SAML ACS RelayState; default to operator. Always allowlisted.
  const hint = (req.query as { returnTo?: string })?.returnTo ?? (req.body as { RelayState?: string })?.RelayState;
  return loginRedirect(reply, s, resolveReturnTo(hint), 'sso_error', message);
}
