import crypto from 'node:crypto';
import type { JwtService } from './jwt.js';
import type { Repos, OAuthClient, OAuthPending } from '../db/repos.js';
import type { SettingsService } from '../settings/settings.service.js';
import { newId } from '../crypto.js';

/**
 * OAuth 2.1 authorization server for the MCP endpoints, so remote clients (Claude, etc.) connect via the
 * standard OAuth + Dynamic Client Registration flow instead of a hand-pasted token. Kravn is the AS and
 * the resource server; the actual USER authentication is delegated to Kravn's existing login (local
 * password or SAML/EntraID) — the browser is sent to /login and resumes the flow once signed in.
 *
 * Security model: public clients only (no client secret), PKCE S256 mandatory, exact redirect_uri match,
 * single-use short-lived auth codes, rotating hashed refresh tokens. Access tokens are stateless Kravn
 * JWTs carrying the user identity + role, which the MCP endpoints already validate.
 */
const PENDING_TTL_SEC = 600; // 10 min to complete login + consent
const CODE_TTL_SEC = 120; // auth code lifetime
const REFRESH_TTL_SEC = 30 * 24 * 3600;

export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly status = 400,
  ) {
    super(description);
  }
}

export type AuthorizeStart =
  | { kind: 'login'; pendingId: string; binding: string } // binding -> set as an httpOnly cookie by the route
  | { kind: 'redirect'; url: string } // redirectable OAuth error -> back to client with ?error=
  | { kind: 'error'; message: string }; // unsafe to redirect (bad client/redirect_uri) -> show a page

export const OAUTH_BINDING_COOKIE = 'kravn_oauth_binding';
const MAX_CLIENTS = 50_000;

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function isoIn(sec: number): string {
  return new Date(Date.now() + sec * 1000).toISOString();
}
function nowIso(): string {
  return new Date().toISOString();
}
function sha256b64url(s: string): string {
  return crypto.createHash('sha256').update(s).digest('base64url');
}
function sha256hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Allowed redirect targets: https anywhere, or http only on loopback (local dev clients). */
function validRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

function redirectWithError(redirectUri: string, error: string, description: string, state: string): string {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (description) u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

export class OAuthService {
  constructor(
    private readonly repos: Repos,
    private readonly jwt: JwtService,
    private readonly settings: SettingsService,
  ) {}

  // ─── Discovery ────────────────────────────────────────────────────────────────────────────────
  authServerMetadata(baseUrl: string): Record<string, unknown> {
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    };
  }
  protectedResourceMetadata(baseUrl: string): Record<string, unknown> {
    return {
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
    };
  }

  // ─── Dynamic Client Registration (RFC 7591) ────────────────────────────────────────────────────
  async registerClient(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const redirectUris = Array.isArray(body?.redirect_uris) ? (body.redirect_uris as unknown[]) : [];
    if (redirectUris.length === 0) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required.');
    }
    for (const u of redirectUris) {
      if (typeof u !== 'string' || !validRedirectUri(u)) {
        throw new OAuthError('invalid_redirect_uri', `Invalid redirect_uri: ${String(u)}`);
      }
    }
    if (redirectUris.length > 10) throw new OAuthError('invalid_redirect_uri', 'Too many redirect_uris.');
    for (const u of redirectUris) {
      if ((u as string).length > 2048) throw new OAuthError('invalid_redirect_uri', 'redirect_uri too long.');
    }
    if ((await this.repos.oauth.countClients()) >= MAX_CLIENTS) {
      throw new OAuthError('temporarily_unavailable', 'Client registration is temporarily unavailable.', 503);
    }

    const requested = Array.isArray(body?.grant_types) ? (body.grant_types as string[]) : [];
    const grantTypes = requested.filter((g) => g === 'authorization_code' || g === 'refresh_token');
    const client: OAuthClient = {
      id: `mcp_${randomToken(18)}`,
      name: String(body?.client_name ?? 'MCP client').slice(0, 255),
      redirectUris: redirectUris as string[],
      grantTypes: grantTypes.length ? grantTypes : ['authorization_code', 'refresh_token'],
      scope: String(body?.scope ?? 'mcp').slice(0, 200),
      tokenEndpointAuthMethod: 'none',
      createdAt: nowIso(),
    };
    await this.repos.oauth.createClient(client);
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: client.scope,
    };
  }

  // ─── Authorize (browser): validate, then hand off to the login flow ─────────────────────────────
  async startAuthorize(p: AuthorizeParams): Promise<AuthorizeStart> {
    const client = await this.repos.oauth.getClient((p.client_id ?? '').trim());
    if (!client) return { kind: 'error', message: 'Unknown client_id. Reconnect the integration.' };

    const redirectUri = (p.redirect_uri ?? '').trim();
    // Exact match against a registered redirect_uri — never redirect to an unverified URL.
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return { kind: 'error', message: 'redirect_uri does not match the registered client.' };
    }

    const state = p.state ?? '';
    if (p.response_type !== 'code') {
      return { kind: 'redirect', url: redirectWithError(redirectUri, 'unsupported_response_type', 'Only code is supported.', state) };
    }
    if (!p.code_challenge || p.code_challenge_method !== 'S256') {
      return { kind: 'redirect', url: redirectWithError(redirectUri, 'invalid_request', 'PKCE with S256 is required.', state) };
    }
    if (!client.grantTypes.includes('authorization_code')) {
      return { kind: 'redirect', url: redirectWithError(redirectUri, 'unauthorized_client', 'Client may not use authorization_code.', state) };
    }

    // Anti-fixation binding: a secret tied to THIS browser. Its hash is stored on the pending row; the
    // route sets the secret as an httpOnly cookie. Approval requires the cookie to match — so an
    // attacker-initiated request can't be approved by a different (victim) browser.
    const binding = randomToken(24);
    const pending: OAuthPending = {
      id: `pnd_${randomToken(18)}`,
      clientId: client.id,
      redirectUri,
      codeChallenge: p.code_challenge,
      codeChallengeMethod: 'S256',
      scope: (p.scope ?? client.scope).slice(0, 200),
      state,
      resource: (p.resource ?? '').slice(0, 500),
      bindingHash: sha256hex(binding),
      expiresAt: isoIn(PENDING_TTL_SEC),
    };
    await this.repos.oauth.createPending(pending);
    return { kind: 'login', pendingId: pending.id, binding };
  }

  private assertBinding(p: OAuthPending, binding: string): void {
    if (!binding || !p.bindingHash || sha256hex(binding) !== p.bindingHash) {
      throw new OAuthError(
        'access_denied',
        'This authorization request was not started in this browser — reconnect from your client.',
        403,
      );
    }
  }

  /** Consent-screen detail for a pending request (called by the SPA with the signed-in user's bearer). */
  async consentInfo(pendingId: string, binding: string): Promise<{ clientId: string; clientName: string; scope: string; redirectHost: string }> {
    const p = await this.requirePending(pendingId);
    this.assertBinding(p, binding);
    const client = await this.repos.oauth.getClient(p.clientId);
    let redirectHost = '';
    try {
      redirectHost = new URL(p.redirectUri).host;
    } catch {
      /* validated at authorize; ignore */
    }
    return { clientId: p.clientId, clientName: client?.name || p.clientId, scope: p.scope, redirectHost };
  }

  /** User approved: mint a single-use auth code and return the client redirect URL (with code + state). */
  async approve(pendingId: string, user: { id: string }, binding: string): Promise<{ redirect: string }> {
    const p = await this.requirePending(pendingId);
    this.assertBinding(p, binding);
    await this.repos.oauth.deletePending(pendingId);
    const code = `cod_${randomToken(32)}`;
    await this.repos.oauth.createCode({
      code,
      clientId: p.clientId,
      userId: user.id,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      codeChallengeMethod: p.codeChallengeMethod,
      scope: p.scope,
      resource: p.resource,
      expiresAt: isoIn(CODE_TTL_SEC),
    });
    const u = new URL(p.redirectUri);
    u.searchParams.set('code', code);
    if (p.state) u.searchParams.set('state', p.state);
    return { redirect: u.toString() };
  }

  /** User denied: drop the request and bounce back to the client with access_denied. */
  async deny(pendingId: string, binding: string): Promise<{ redirect: string }> {
    const p = await this.requirePending(pendingId);
    this.assertBinding(p, binding);
    await this.repos.oauth.deletePending(pendingId);
    return { redirect: redirectWithError(p.redirectUri, 'access_denied', 'The user denied the request.', p.state) };
  }

  // ─── Token endpoint ─────────────────────────────────────────────────────────────────────────────
  async token(body: Record<string, unknown>): Promise<TokenResponse> {
    const grant = String(body?.grant_type ?? '');
    if (grant === 'authorization_code') return this.exchangeCode(body);
    if (grant === 'refresh_token') return this.exchangeRefresh(body);
    throw new OAuthError('unsupported_grant_type', `Unsupported grant_type: ${grant || '(none)'}`);
  }

  private async exchangeCode(body: Record<string, unknown>): Promise<TokenResponse> {
    const code = String(body?.code ?? '');
    const verifier = String(body?.code_verifier ?? '');
    const redirectUri = String(body?.redirect_uri ?? '');
    const clientId = body?.client_id ? String(body.client_id) : '';
    if (!code || !verifier) throw new OAuthError('invalid_request', 'code and code_verifier are required.');

    const c = await this.repos.oauth.takeCode(code); // single-use: fetched + deleted
    if (!c) throw new OAuthError('invalid_grant', 'Invalid or already-used authorization code.');
    if (c.expiresAt < nowIso()) throw new OAuthError('invalid_grant', 'Authorization code expired.');
    if (clientId && clientId !== c.clientId) throw new OAuthError('invalid_grant', 'client_id mismatch.');
    if (redirectUri !== c.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri mismatch.');
    if (sha256b64url(verifier) !== c.codeChallenge) throw new OAuthError('invalid_grant', 'PKCE verification failed.');

    return this.issueTokens(c.userId, c.clientId, c.scope);
  }

  private async exchangeRefresh(body: Record<string, unknown>): Promise<TokenResponse> {
    const refresh = String(body?.refresh_token ?? '');
    const clientId = body?.client_id ? String(body.client_id) : '';
    if (!refresh) throw new OAuthError('invalid_request', 'refresh_token is required.');

    // Atomic rotate: claimRefresh deletes the row and only the winner gets it back (no concurrent fork).
    const stored = await this.repos.oauth.claimRefresh(sha256hex(refresh));
    if (!stored) throw new OAuthError('invalid_grant', 'Invalid refresh token.');
    if (stored.expiresAt < nowIso()) throw new OAuthError('invalid_grant', 'Refresh token expired.');
    if (clientId && clientId !== stored.clientId) throw new OAuthError('invalid_grant', 'client_id mismatch.');

    return this.issueTokens(stored.userId, stored.clientId, stored.scope);
  }

  private async issueTokens(userId: string, clientId: string, scope: string): Promise<TokenResponse> {
    // Re-read the user so role changes / deletions / deactivations take effect on every (re)issue — this is
    // the single choke point for both the code exchange and refresh grants.
    const user = await this.repos.users.getById(userId);
    if (!user) throw new OAuthError('invalid_grant', 'The account no longer exists.');
    if (user.disabled) throw new OAuthError('invalid_grant', 'The account is disabled.');
    const ttlMin = this.settings.get().auth.sessionTtlMinutes;
    // 'mcp' scope: this token authenticates MCP calls only, never the control-plane /api (see auth plugin).
    const accessToken = await this.jwt.sign({ userId: user.id, email: user.email, role: user.role, scope: 'mcp' }, ttlMin);
    const refreshPlain = `rt_${randomToken(32)}`;
    await this.repos.oauth.createRefresh({
      id: newId(),
      tokenHash: sha256hex(refreshPlain),
      clientId,
      userId,
      scope,
      expiresAt: isoIn(REFRESH_TTL_SEC),
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ttlMin * 60,
      refresh_token: refreshPlain,
      scope,
    };
  }

  private async requirePending(pendingId: string): Promise<OAuthPending> {
    const p = await this.repos.oauth.getPending(pendingId);
    if (!p || p.expiresAt < nowIso()) {
      throw new OAuthError('invalid_request', 'This authorization request expired or was not found — start again from your client.', 400);
    }
    return p;
  }

  /** Best-effort GC of expired rows; cheap to call on the authorize path. */
  async gc(): Promise<void> {
    try {
      await this.repos.oauth.gc(nowIso());
    } catch {
      /* best-effort */
    }
  }
}
