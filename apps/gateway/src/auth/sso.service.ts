import { Issuer, generators, type Client } from 'openid-client';
import { SAML } from '@node-saml/node-saml';
import type {
  UpdateAuthConfigRequest,
  AuthConfigView,
  SsoMethod,
  Role,
} from '@kravn/contracts';
import crypto from 'node:crypto';
import { newId, hashPassword, type Encryptor } from '../crypto.js';
import { AuthError, type AuthUser, toAuthUser } from './auth.service.js';
import type { JwtService } from './jwt.js';
import type { Repos, UserRecord } from '../db/repos.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { Logger } from 'pino';

interface StoredOAuthProvider {
  id: string;
  label: string;
  discoveryUrl: string;
  clientId: string;
  clientSecretEnc: string;
  scopes: string[];
  enabled: boolean;
}
interface StoredSaml {
  enabled: boolean;
  label: string;
  entryPoint: string;
  issuer: string;
  idpIssuer: string;
  idpCertEnc: string;
  emailAttribute: string;
}
interface StoredAuthConfig {
  oauthProviders: StoredOAuthProvider[];
  saml: StoredSaml;
  autoProvision: boolean;
  defaultRole: Role;
}

function defaultConfig(): StoredAuthConfig {
  return {
    oauthProviders: [],
    saml: { enabled: false, label: 'SAML', entryPoint: '', issuer: 'kravn', idpIssuer: '', idpCertEnc: '', emailAttribute: 'email' },
    autoProvision: true,
    defaultRole: 'viewer',
  };
}

interface PendingOAuth {
  providerId: string;
  verifier: string;
  redirectUri: string;
  expires: number;
  /** Which SPA initiated the login, so the callback returns the token to the right origin. */
  returnTo: string;
}

export interface SsoLoginResult {
  user: AuthUser;
  token: string;
  /** Opaque hint of which SPA to return to ('operator' | 'client'); allowlisted by the route. */
  returnTo: string;
}

export class SsoService {
  private issuerCache = new Map<string, Issuer<Client>>();
  private pending = new Map<string, PendingOAuth>();

  constructor(
    private repos: Repos,
    private encryptor: Encryptor,
    private jwt: JwtService,
    private settings: SettingsService,
    private log: Logger,
  ) {}

  // ─── Config ──────────────────────────────────────────────────────────────────────────────────

  private async load(): Promise<StoredAuthConfig> {
    const raw = await this.repos.authConfig.getRaw();
    if (!raw) return defaultConfig();
    try {
      return { ...defaultConfig(), ...(JSON.parse(raw) as StoredAuthConfig) };
    } catch {
      return defaultConfig();
    }
  }

  async save(input: UpdateAuthConfigRequest): Promise<void> {
    const current = await this.load();
    const next: StoredAuthConfig = {
      autoProvision: input.autoProvision,
      defaultRole: input.defaultRole,
      oauthProviders: input.oauthProviders.map((p) => {
        const prev = current.oauthProviders.find((x) => x.id === p.id);
        const clientSecretEnc = p.clientSecret
          ? this.encryptor.encrypt(p.clientSecret)
          : prev?.clientSecretEnc ?? '';
        return {
          id: p.id,
          label: p.label,
          discoveryUrl: p.discoveryUrl,
          clientId: p.clientId,
          clientSecretEnc,
          scopes: p.scopes,
          enabled: p.enabled,
        };
      }),
      saml: {
        enabled: input.saml.enabled,
        label: input.saml.label,
        entryPoint: input.saml.entryPoint,
        issuer: input.saml.issuer,
        idpIssuer: input.saml.idpIssuer,
        emailAttribute: input.saml.emailAttribute,
        idpCertEnc: input.saml.idpCert ? this.encryptor.encrypt(input.saml.idpCert) : current.saml.idpCertEnc,
      },
    };
    // Invalidate cached OIDC issuers so config changes take effect immediately.
    this.issuerCache.clear();
    await this.repos.authConfig.setRaw(JSON.stringify(next));
    this.log.info('SSO/auth configuration updated');
  }

  async view(baseUrl: string): Promise<AuthConfigView> {
    const c = await this.load();
    return {
      oauthProviders: c.oauthProviders.map((p) => ({
        id: p.id,
        label: p.label,
        discoveryUrl: p.discoveryUrl,
        clientId: p.clientId,
        clientSecretSet: !!p.clientSecretEnc,
        scopes: p.scopes,
        enabled: p.enabled,
      })),
      saml: {
        enabled: c.saml.enabled,
        label: c.saml.label,
        entryPoint: c.saml.entryPoint,
        issuer: c.saml.issuer,
        idpIssuer: c.saml.idpIssuer,
        idpCertSet: !!c.saml.idpCertEnc,
        emailAttribute: c.saml.emailAttribute,
      },
      autoProvision: c.autoProvision,
      defaultRole: c.defaultRole,
      samlCallbackUrl: `${baseUrl}/api/auth/sso/saml/callback`,
    };
  }

  /** Public login methods for the SPA (no secrets). */
  async methods(): Promise<SsoMethod[]> {
    const c = await this.load();
    const list: SsoMethod[] = c.oauthProviders
      .filter((p) => p.enabled && p.clientId && p.discoveryUrl)
      .map((p) => ({ kind: 'oauth' as const, id: p.id, label: p.label }));
    if (c.saml.enabled && c.saml.entryPoint && c.saml.idpCertEnc) {
      list.push({ kind: 'saml', id: 'saml', label: c.saml.label || 'SAML' });
    }
    return list;
  }

  // ─── OIDC (OAuth2) ─────────────────────────────────────────────────────────────────────────────

  private async oidcClient(p: StoredOAuthProvider, redirectUri: string): Promise<Client> {
    let issuer = this.issuerCache.get(p.discoveryUrl);
    if (!issuer) {
      issuer = await Issuer.discover(p.discoveryUrl);
      this.issuerCache.set(p.discoveryUrl, issuer);
    }
    return new issuer.Client({
      client_id: p.clientId,
      client_secret: this.encryptor.decrypt(p.clientSecretEnc),
      redirect_uris: [redirectUri],
      response_types: ['code'],
    });
  }

  async oauthStart(providerId: string, baseUrl: string, returnTo = 'operator'): Promise<string> {
    const c = await this.load();
    const p = c.oauthProviders.find((x) => x.id === providerId && x.enabled);
    if (!p) throw new AuthError('unknown_provider', 'Unknown or disabled provider.', 404);

    const redirectUri = `${baseUrl}/api/auth/sso/oauth/${providerId}/callback`;
    const client = await this.oidcClient(p, redirectUri);
    const state = generators.state();
    const verifier = generators.codeVerifier();
    const challenge = generators.codeChallenge(verifier);

    this.gc();
    // returnTo rides in the SERVER-stored state (never the browser/IdP), so it can't be tampered with.
    this.pending.set(state, { providerId, verifier, redirectUri, expires: nowMs() + 10 * 60_000, returnTo });

    return client.authorizationUrl({
      scope: (p.scopes.length ? p.scopes : ['openid', 'email', 'profile']).join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: redirectUri,
    });
  }

  async oauthCallback(providerId: string, query: Record<string, unknown>): Promise<SsoLoginResult> {
    const state = String(query.state ?? '');
    const pend = this.pending.get(state);
    this.pending.delete(state);
    if (!pend || pend.providerId !== providerId || pend.expires < nowMs()) {
      throw new AuthError('invalid_state', 'Login session expired, please retry.', 400);
    }
    const c = await this.load();
    const p = c.oauthProviders.find((x) => x.id === providerId);
    if (!p) throw new AuthError('unknown_provider', 'Unknown provider.', 404);

    const client = await this.oidcClient(p, pend.redirectUri);
    const tokenSet = await client.callback(pend.redirectUri, query as any, { state, code_verifier: pend.verifier });
    const info = await client.userinfo(tokenSet);
    const email = (info.email as string) || '';
    if (!email) throw new AuthError('no_email', 'The identity provider did not return an email.', 400);

    const user = await this.findOrCreate(c, email, (info.name as string) || email);
    return this.issue(user, pend.returnTo);
  }

  // ─── SAML ────────────────────────────────────────────────────────────────────────────────────

  private async samlInstance(c: StoredAuthConfig, baseUrl: string): Promise<SAML> {
    return new SAML({
      entryPoint: c.saml.entryPoint,
      issuer: c.saml.issuer || 'kravn',
      idpCert: this.encryptor.decrypt(c.saml.idpCertEnc),
      callbackUrl: `${baseUrl}/api/auth/sso/saml/callback`,
      wantAssertionsSigned: true,
      ...(c.saml.idpIssuer ? { idpIssuer: c.saml.idpIssuer } : {}),
    });
  }

  async samlStart(baseUrl: string, returnTo = 'operator'): Promise<string> {
    const c = await this.load();
    if (!c.saml.enabled) throw new AuthError('saml_disabled', 'SAML is not enabled.', 404);
    const saml = await this.samlInstance(c, baseUrl);
    // RelayState is echoed back by the IdP on the ACS POST. It is UNTRUSTED on return, so the
    // route allowlists it before using it as a redirect target — we only carry a short enum here.
    return saml.getAuthorizeUrlAsync(returnTo, '', {});
  }

  async samlCallback(baseUrl: string, body: { SAMLResponse?: string; RelayState?: string }): Promise<SsoLoginResult> {
    const c = await this.load();
    if (!c.saml.enabled) throw new AuthError('saml_disabled', 'SAML is not enabled.', 404);
    const saml = await this.samlInstance(c, baseUrl);
    const { profile } = await saml.validatePostResponseAsync(body as { SAMLResponse: string });
    if (!profile) throw new AuthError('saml_invalid', 'Invalid SAML response.', 400);
    const attr = c.saml.emailAttribute || 'email';
    const email =
      (profile[attr] as string) || (profile.email as string) || (profile.nameID as string) || '';
    if (!email) throw new AuthError('no_email', 'SAML assertion did not include an email.', 400);
    const name = (profile.displayName as string) || (profile.cn as string) || email;
    const user = await this.findOrCreate(c, email, name);
    return this.issue(user, typeof body.RelayState === 'string' ? body.RelayState : 'operator');
  }

  // ─── Shared ──────────────────────────────────────────────────────────────────────────────────

  private async findOrCreate(c: StoredAuthConfig, email: string, name: string): Promise<UserRecord> {
    const existing = await this.repos.users.getByEmail(email);
    if (existing) return existing;
    if (!c.autoProvision) {
      throw new AuthError('not_provisioned', 'No account exists for this identity and auto-provisioning is off.', 403);
    }
    return this.repos.users.create({
      id: newId(),
      email,
      name: name || email,
      role: c.defaultRole,
      // SSO-only account: random password it can never practically use.
      passwordHash: hashPassword(crypto.randomBytes(32).toString('hex')),
    });
  }

  private async issue(user: UserRecord, returnTo = 'operator'): Promise<SsoLoginResult> {
    const token = await this.jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      this.settings.get().auth.sessionTtlMinutes,
    );
    return { user: toAuthUser(user), token, returnTo };
  }

  private gc(): void {
    const t = nowMs();
    for (const [k, v] of this.pending) if (v.expires < t) this.pending.delete(k);
  }
}

function nowMs(): number {
  return Date.now();
}
