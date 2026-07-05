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

interface Deps {
  repos: Repos;
  encryptor: Encryptor;
  ssrf: SsrfGuard;
  log: Logger;
}

export class UpstreamOAuthService {
  constructor(private d: Deps) {}

  /** Discover, (re)register a client, build the authorization URL, and persist the pending round-trip. */
  async startAuthorization(server: UpstreamServer, redirectUri: string): Promise<string> {
    if (server.transport === 'stdio' || server.transport === 'plugin' || !server.url) {
      throw new Error('OAuth is only available for remote (HTTP/SSE) MCP servers.');
    }
    await this.d.ssrf.assertUrlAllowed(server.url);

    const resourceMeta = await discoverOAuthProtectedResourceMetadata(server.url);
    const authServerUrl = resourceMeta.authorization_servers?.[0];
    if (!authServerUrl) throw new Error('This server did not advertise an OAuth authorization server.');
    await this.d.ssrf.assertUrlAllowed(authServerUrl);

    const asMeta = await discoverAuthorizationServerMetadata(authServerUrl);
    if (!asMeta) throw new Error('Could not discover the authorization-server metadata.');

    const scope = (resourceMeta.scopes_supported ?? asMeta.scopes_supported ?? []).join(' ') || undefined;

    // Reuse a client already registered for this exact authorization server; otherwise register one (DCR).
    let clientInfo: OAuthClientInformationFull;
    const existing = await this.d.repos.serverOAuth.getConfig(server.id);
    if (existing && existing.authServerUrl === authServerUrl && existing.clientInfoEnc) {
      clientInfo = JSON.parse(this.d.encryptor.decrypt(existing.clientInfoEnc)) as OAuthClientInformationFull;
    } else {
      const clientMetadata: OAuthClientMetadata = {
        client_name: 'Kravn',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(scope ? { scope } : {}),
      };
      clientInfo = await registerClient(authServerUrl, { metadata: asMeta, clientMetadata, scope });
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
function isoIn(sec: number): string {
  return new Date(Date.now() + sec * 1000).toISOString();
}
