import crypto from 'node:crypto';
import type { Logger } from 'pino';
import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
  AuthorizationServerMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { UpstreamServer } from '@kravn/contracts';
import type { Repos } from '../db/repos.js';
import type { Encryptor } from '../crypto.js';
import type { SsrfGuard } from '../http/ssrf.js';

/**
 * Upstream OAuth 2.1 CLIENT — lets Kravn connect to a remote MCP server that requires OAuth 2.1
 * (Notion, Linear, Stripe, …). Protocol correctness (metadata discovery, Dynamic Client Registration,
 * PKCE, token exchange/refresh) is delegated to the MCP SDK's auth toolkit; this service owns the storage,
 * the state/CSRF anchor, and encryption-at-rest of the client secret + tokens.
 *
 * Security posture: the authorization round-trip is bound only by an unguessable, single-use, expiring
 * `state` (the callback has no Kravn session). All server-side fetches are SSRF-guarded — the server URL
 * and the discovered authorization-server URL are asserted, and every SDK fetch also flows through the
 * globally-installed SSRF dispatcher (pinned-IP lookup blocks private/metadata ranges). Tokens, the PKCE
 * verifier and the registered client are never stored or logged in the clear.
 */
const PENDING_TTL_SEC = 600;
const REFRESH_SKEW_SEC = 60; // refresh this long before the token actually expires

/**
 * Thrown when the authorization server can't auto-register a client (no Dynamic Client Registration — e.g.
 * GitHub) and the operator hasn't supplied one. The operator must register an OAuth app at the provider
 * (with `redirectUri`) and provide its Client ID (+ secret). Surfaced to the UI as `oauth_needs_client`.
 */
export class OAuthClientRequiredError extends Error {
  constructor(readonly redirectUri: string) {
    super(
      `This provider needs manual OAuth configuration (it doesn't advertise metadata or support automatic ` +
        `app registration). Register an OAuth app with redirect URL ${redirectUri}, then provide the ` +
        `Authorization URL, Token URL, scopes and Client ID (and secret) to connect.`,
    );
    this.name = 'OAuthClientRequiredError';
  }
}

/**
 * Operator-provided OAuth configuration that overrides auto-discovery (mirrors a full manual OAuth form):
 * an authorization-server issuer, explicit endpoints, scopes, and client credentials. Any field may be set;
 * the rest is discovered.
 */
export interface UpstreamOAuthInput {
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string; // authorization_endpoint
  tokenUrl?: string; // token_endpoint
  issuer?: string; // authorization server URL (for discovery, or as the AS identity)
  scope?: string; // space-separated scopes
}

interface Deps {
  repos: Repos;
  encryptor: Encryptor;
  ssrf: SsrfGuard;
  log: Logger;
}

export class UpstreamOAuthService {
  constructor(private d: Deps) {}

  /**
   * Discover (or use operator-provided endpoints), obtain a client, build the authorization URL, and persist
   * the pending round-trip. Parity with a full manual OAuth config: `cfg` may carry an authorization-server
   * issuer, explicit authorization/token endpoints, scopes, and client credentials — any of which override
   * auto-discovery, for providers that don't advertise protected-resource metadata or DCR (e.g. GitHub).
   * When nothing is supplied and the server can't be auto-configured, throws OAuthClientRequiredError so the
   * UI collects the config.
   */
  async startAuthorization(server: UpstreamServer, redirectUri: string, cfg: UpstreamOAuthInput = {}): Promise<string> {
    if (server.transport === 'stdio' || server.transport === 'plugin' || !server.url) {
      throw new Error('OAuth is only available for remote (HTTP/SSE) MCP servers.');
    }

    // Merge the operator config saved on the server (editable, persistent) with any values passed to this call.
    const eff = await this.effectiveConfig(server.id, cfg);

    let asMeta: AuthorizationServerMetadata;
    let authServerUrl: string;
    let discoveredScopes: string[] | undefined;

    if (eff.authorizationUrl && eff.tokenUrl) {
      // Fully manual endpoints — no discovery (the provider doesn't advertise metadata).
      await this.d.ssrf.assertUrlAllowed(eff.authorizationUrl);
      await this.d.ssrf.assertUrlAllowed(eff.tokenUrl);
      authServerUrl = (eff.issuer?.trim() || originOf(eff.authorizationUrl)).replace(/\/$/, '');
      asMeta = {
        issuer: authServerUrl,
        authorization_endpoint: eff.authorizationUrl,
        token_endpoint: eff.tokenUrl,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      } as AuthorizationServerMetadata;
    } else if (eff.issuer) {
      // Discover from an explicit issuer URL.
      await this.d.ssrf.assertUrlAllowed(eff.issuer);
      authServerUrl = eff.issuer.trim().replace(/\/$/, '');
      const m = await discoverAuthorizationServerMetadata(authServerUrl);
      if (!m) throw new Error('Could not discover authorization-server metadata at the issuer URL.');
      asMeta = m;
    } else {
      // Auto-discovery from the MCP server's protected-resource metadata.
      await this.d.ssrf.assertUrlAllowed(server.url);
      const resourceMeta = await discoverOAuthProtectedResourceMetadata(server.url).catch(() => undefined);
      const found = resourceMeta?.authorization_servers?.[0];
      if (!found) throw new OAuthClientRequiredError(redirectUri); // can't discover → UI collects manual config
      await this.d.ssrf.assertUrlAllowed(found);
      const m = await discoverAuthorizationServerMetadata(found);
      if (!m) throw new OAuthClientRequiredError(redirectUri);
      authServerUrl = found;
      asMeta = m;
      discoveredScopes = resourceMeta?.scopes_supported;
    }

    const scope = eff.scope?.trim() || (discoveredScopes ?? asMeta.scopes_supported ?? []).join(' ') || undefined;

    let clientInfo: OAuthClientInformationFull;
    const existing = await this.d.repos.serverOAuth.getConfig(server.id);
    if (eff.clientId) {
      // Operator-registered OAuth app (provider without DCR, or a preferred fixed app).
      clientInfo = {
        client_id: eff.clientId,
        ...(eff.clientSecret ? { client_secret: eff.clientSecret } : {}),
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: eff.clientSecret ? 'client_secret_post' : 'none',
      } as OAuthClientInformationFull;
    } else if (existing && existing.authServerUrl === authServerUrl && existing.clientInfoEnc) {
      clientInfo = JSON.parse(this.d.encryptor.decrypt(existing.clientInfoEnc)) as OAuthClientInformationFull;
    } else if (asMeta.registration_endpoint) {
      const clientMetadata: OAuthClientMetadata = {
        client_name: 'Kravn',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(scope ? { scope } : {}),
      };
      try {
        clientInfo = await registerClient(authServerUrl, { metadata: asMeta, clientMetadata, scope, fetchFn: jsonFetch });
      } catch {
        throw new OAuthClientRequiredError(redirectUri);
      }
    } else {
      throw new OAuthClientRequiredError(redirectUri);
    }

    const state = randomToken(32);
    const { authorizationUrl, codeVerifier } = await startAuthorization(authServerUrl, {
      metadata: asMeta,
      clientInformation: clientInfo,
      redirectUrl: redirectUri,
      scope,
      state,
      resource: new URL(server.url),
    });

    await this.d.repos.serverOAuth.upsertConfig({
      serverId: server.id,
      authServerUrl,
      metadataJson: JSON.stringify(asMeta),
      clientInfoEnc: this.d.encryptor.encrypt(JSON.stringify(clientInfo)),
      resource: server.url,
      scope: scope ?? '',
    });
    await this.d.repos.serverOAuth.createPending({
      state,
      serverId: server.id,
      codeVerifierEnc: this.d.encryptor.encrypt(codeVerifier),
      redirectUri,
      expiresAt: isoIn(PENDING_TTL_SEC),
    });
    await this.d.repos.serverOAuth.gc(new Date().toISOString());

    return authorizationUrl.toString();
  }

  /** Decrypt the persisted operator OAuth config for a server ('{}' if none/unreadable). */
  private async readOperatorConfig(serverId: string): Promise<UpstreamOAuthInput> {
    const existing = await this.d.repos.serverOAuth.getConfig(serverId);
    if (!existing?.operatorConfigEnc) return {};
    try {
      return JSON.parse(this.d.encryptor.decrypt(existing.operatorConfigEnc)) as UpstreamOAuthInput;
    } catch {
      return {};
    }
  }

  /** Stored operator config as the base, overridden by any non-empty field passed to this call. */
  private async effectiveConfig(serverId: string, cfg: UpstreamOAuthInput): Promise<UpstreamOAuthInput> {
    const out: UpstreamOAuthInput = { ...(await this.readOperatorConfig(serverId)) };
    for (const k of ['clientId', 'clientSecret', 'authorizationUrl', 'tokenUrl', 'issuer', 'scope'] as const) {
      const v = cfg[k];
      if (v != null && String(v).trim() !== '') out[k] = v;
    }
    return out;
  }

  /** Persist the operator OAuth config so it survives failed Connects and is editable from the server form.
   * A blank client secret keeps the previously-stored one; the other fields are replaced by the form values. */
  async saveConfig(serverId: string, input: UpstreamOAuthInput): Promise<void> {
    const stored = await this.readOperatorConfig(serverId);
    const merged: UpstreamOAuthInput = {
      clientId: input.clientId ?? '',
      authorizationUrl: input.authorizationUrl ?? '',
      tokenUrl: input.tokenUrl ?? '',
      issuer: input.issuer ?? '',
      scope: input.scope ?? '',
      clientSecret: input.clientSecret && input.clientSecret !== '' ? input.clientSecret : stored.clientSecret,
    };
    await this.d.repos.serverOAuth.saveOperatorConfig(serverId, this.d.encryptor.encrypt(JSON.stringify(merged)));
  }

  /** The saved OAuth config for display/editing — never returns the client secret, only whether one is set. */
  async getConfigForDisplay(serverId: string): Promise<{
    clientId: string;
    authorizationUrl: string;
    tokenUrl: string;
    issuer: string;
    scope: string;
    clientSecretSet: boolean;
  } | null> {
    const o = await this.readOperatorConfig(serverId);
    if (!Object.keys(o).length) return null;
    return {
      clientId: o.clientId ?? '',
      authorizationUrl: o.authorizationUrl ?? '',
      tokenUrl: o.tokenUrl ?? '',
      issuer: o.issuer ?? '',
      scope: o.scope ?? '',
      clientSecretSet: !!o.clientSecret,
    };
  }

  /** Complete the round-trip: single-use state → exchange the code for tokens → store them. Returns serverId. */
  async completeAuthorization(state: string, code: string): Promise<string> {
    const pending = await this.d.repos.serverOAuth.takePending(state);
    if (!pending) throw new Error('Invalid or already-used authorization state.');
    if (new Date(pending.expiresAt).getTime() < Date.now()) throw new Error('The authorization request expired.');

    const cfg = await this.d.repos.serverOAuth.getConfig(pending.serverId);
    if (!cfg) throw new Error('No OAuth configuration for this server.');
    await this.d.ssrf.assertUrlAllowed(cfg.authServerUrl);

    const asMeta = JSON.parse(cfg.metadataJson) as AuthorizationServerMetadata;
    const clientInfo = JSON.parse(this.d.encryptor.decrypt(cfg.clientInfoEnc)) as OAuthClientInformationFull;
    const codeVerifier = this.d.encryptor.decrypt(pending.codeVerifierEnc);

    const tokens = await exchangeAuthorization(cfg.authServerUrl, {
      metadata: asMeta,
      clientInformation: clientInfo,
      authorizationCode: code,
      codeVerifier,
      redirectUri: pending.redirectUri,
      resource: new URL(cfg.resource),
      fetchFn: jsonFetch,
    });
    await this.persistTokens(pending.serverId, tokens);
    return pending.serverId;
  }

  /** Whether a server has completed an OAuth authorization (has a stored access token). */
  async isAuthorized(serverId: string): Promise<boolean> {
    const cfg = await this.d.repos.serverOAuth.getConfig(serverId);
    return !!cfg?.accessTokenEnc;
  }

  /** A valid access token, refreshing (and rotating the refresh token) when near expiry. */
  async accessTokenFor(serverId: string): Promise<string> {
    const cfg = await this.d.repos.serverOAuth.getConfig(serverId);
    if (!cfg || !cfg.accessTokenEnc) throw new Error('This server is not authorized yet — click Connect to sign in.');

    const stillValid = !cfg.expiresAt || new Date(cfg.expiresAt).getTime() > Date.now() + REFRESH_SKEW_SEC * 1000;
    if (stillValid) return this.d.encryptor.decrypt(cfg.accessTokenEnc);

    if (!cfg.refreshTokenEnc) throw new Error('The access token expired and there is no refresh token — click Connect to re-authorize.');
    await this.d.ssrf.assertUrlAllowed(cfg.authServerUrl);
    const asMeta = JSON.parse(cfg.metadataJson) as AuthorizationServerMetadata;
    const clientInfo = JSON.parse(this.d.encryptor.decrypt(cfg.clientInfoEnc)) as OAuthClientInformationFull;
    const tokens = await refreshAuthorization(cfg.authServerUrl, {
      metadata: asMeta,
      clientInformation: clientInfo,
      refreshToken: this.d.encryptor.decrypt(cfg.refreshTokenEnc),
      resource: new URL(cfg.resource),
      fetchFn: jsonFetch,
    });
    await this.persistTokens(serverId, tokens, cfg.refreshTokenEnc);
    return tokens.access_token;
  }

  /** Forget all OAuth material for a server (on delete, or an explicit disconnect). */
  async forget(serverId: string): Promise<void> {
    await this.d.repos.serverOAuth.deleteConfig(serverId);
  }

  private async persistTokens(serverId: string, tokens: OAuthTokens, keepRefreshEnc = ''): Promise<void> {
    // A refresh response may omit refresh_token (keep the prior one) or rotate it (store the new one).
    const refreshEnc = tokens.refresh_token ? this.d.encryptor.encrypt(tokens.refresh_token) : keepRefreshEnc;
    await this.d.repos.serverOAuth.saveTokens(serverId, {
      accessTokenEnc: this.d.encryptor.encrypt(tokens.access_token),
      refreshTokenEnc: refreshEnc,
      expiresAt: tokens.expires_in ? isoIn(tokens.expires_in) : '',
    });
  }
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
function originOf(url: string): string {
  return new URL(url).origin;
}
/**
 * Force `Accept: application/json` on token/registration requests. Some providers (notably GitHub) otherwise
 * return `application/x-www-form-urlencoded` bodies that the token parser reads as empty — surfacing as
 * "access_token: expected string, received undefined".
 */
const jsonFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('accept', 'application/json');
  return fetch(input, { ...(init ?? {}), headers });
};
function isoIn(sec: number): string {
  return new Date(Date.now() + sec * 1000).toISOString();
}
