import type { FastifyInstance } from 'fastify';
import type { Services } from '../services.js';

/**
 * PUBLIC upstream-OAuth callback. The authorization server redirects the admin's browser here after sign-in.
 * It carries no Kravn session, so its ONLY trust anchor is the single-use, unguessable `state` (validated in
 * completeAuthorization). No inline script (the global CSP is `script-src 'self'`); the page is a static
 * notice and all reflected values are HTML-escaped to prevent a reflected-XSS via `error_description`.
 */
export function serverOAuthRoutes(app: FastifyInstance, s: Services): void {
  app.get('/oauth/upstream/callback', { logLevel: 'warn' }, async (req, reply) => {
    // Coerce every query param to a single string — a repeated param arrives as an array, which must not
    // reach escapeHtml (would throw) or completeAuthorization (would corrupt the state lookup).
    const raw = (req.query ?? {}) as Record<string, unknown>;
    const first = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v));
    const code = first(raw.code);
    const state = first(raw.state);
    const error = first(raw.error);
    const errorDescription = first(raw.error_description);

    if (error) return reply.type('text/html').send(page(false, errorDescription || error));
    if (!code || !state) return reply.type('text/html').send(page(false, 'Missing authorization code or state.'));

    try {
      const serverId = await s.upstreamOAuth.completeAuthorization(state, code);
      // We now hold a token — connect + import the catalog in the background.
      s.registry.connectAndSync(serverId).catch((err) => s.log.warn({ err }, 'post-OAuth connect failed'));
      return reply.type('text/html').send(page(true, ''));
    } catch (err) {
      return reply.type('text/html').send(page(false, err instanceof Error ? err.message : 'Authorization failed.'));
    }
  });
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(ok: boolean, message: string): string {
  const title = ok ? 'Connected' : 'Authorization failed';
  const detail = ok
    ? 'Kravn is now authorized for this MCP server. You can close this window and return to the console.'
    : escapeHtml(message.slice(0, 500));
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${title} · Kravn</title>` +
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e6e6;' +
    'display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}' +
    '.card{max-width:420px;padding:32px;text-align:center}h1{font-size:1.25rem;margin:0 0 8px}' +
    `.mark{font-size:2.5rem}p{color:#9aa0aa;line-height:1.5}</style></head><body><div class="card">` +
    `<div class="mark">${ok ? '🐦‍⬛' : '⚠️'}</div><h1>${title}</h1><p>${detail}</p></div></body></html>`
  );
}
