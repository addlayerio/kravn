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
import { normalizeCerts } from './saml-metadata.js';
import { AuthError, type AuthUser, toAuthUser } from './auth.service.js';
import type { JwtService } from './jwt.js';
import type { Repos, UserRecord } from '../db/repos.js';
import type { SharedStore } from '../cluster/shared-store.js';
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
  /** Lowercased emails that become admin when they sign in via SSO. */
  adminEmails: string[];
}

function defaultConfig(): StoredAuthConfig {
  return {
    oauthProviders: [],
    saml: { enabled: false, label: 'SAML', entryPoint: '', issuer: 'kravn', idpIssuer: '', idpCertEnc: '', emailAttribute: 'email' },
    autoProvision: true,
    defaultRole: 'viewer',
    adminEmails: [],
  };
}

/** In-flight OIDC login state, stored server-side in the SharedStore keyed by `state` (TTL-expiring, single-use). */
interface PendingOAuth {
  providerId: string;
  verifier: string;
  redirectUri: string;
  /** Which SPA initiated the login, so the callback returns the token to the right origin. */
  returnTo: string;
}

/** SharedStore key for a pending OIDC login. `state` is an unguessable random value; the entry is single-use. */
const ssoPendingKey = (state: string): string => `sso:pending:${state}`;
/** OIDC login state lifetime: matches the previous 10-minute in-memory window. */
const SSO_PENDING_TTL_SEC = 10 * 60;

export interface SsoLoginResult {
  user: AuthUser;
  token: string;
  /** Opaque hint of which SPA to return to ('operator' | 'client'); allowlisted by the route. */
  returnTo: string;
}

/** Reject a non-https or private/loopback/link-local/metadata host for a server-side OIDC discovery fetch (SSRF). */
function assertPublicHttpsUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AuthError('bad_discovery', 'Invalid OIDC discovery URL.', 400);
  }
  if (u.protocol !== 'https:') throw new AuthError('bad_discovery', 'OIDC discovery URL must be https.', 400);
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked =
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal') ||
    h.endsWith('.local') ||
    h === '::1' ||
    h.startsWith('fc') ||
    h.startsWith('fd') ||
    h.startsWith('fe80:') ||
    h === '0.0.0.0' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (blocked) throw new AuthError('bad_discovery', 'OIDC discovery URL host is not allowed.', 400);
}

export class SsoService {
  private issuerCache = new Map<string, Issuer<Client>>();

  constructor(
    private repos: Repos,
    private encryptor: Encryptor,
    private jwt: JwtService,
    private settings: SettingsService,
    private log: Logger,
    // Cross-replica store for in-flight OIDC login state (PKCE verifier + returnTo), keyed by `state`.
    // TTL-expiring and single-use (deleted on callback). Memory-backed on a single replica.
    private store: SharedStore,
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
      adminEmails: [...new Set(input.adminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))],
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
        idpCertEnc: input.saml.idpCert ? this.encryptor.encrypt(normalizeCerts(input.saml.idpCert)) : current.saml.idpCertEnc,
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
      adminEmails: c.adminEmails,
      samlCallbackUrl: `${baseUrl}/api/auth/sso/saml/callback`,
    };
  }

  /** True if at least one SSO method is fully configured + enabled (used to prevent passwordless lockout). */
  async hasEnabledProvider(): Promise<boolean> {
    return (await this.methods()).length > 0;
  }

  /** True if `email` (any case) is a designated admin email. */
  async isAdminEmail(email: string): Promise<boolean> {
    return (await this.load()).adminEmails.includes(email.trim().toLowerCase());
  }

  /**
   * True only if an admin can actually reach the system via SSO: at least one enabled provider AND at
   * least one designated admin email. Required before local password login may be disabled, so the
   * operator can never end up with SSO enabled but no admin path.
   */
  async hasReachableAdmin(): Promise<boolean> {
    const c = await this.load();
    return (await this.methods()).length > 0 && c.adminEmails.length > 0;
  }

  /** How many SSO methods WOULD be enabled for a proposed config (mirror of methods(), over the input). */
  enabledCountForInput(input: UpdateAuthConfigRequest, current: AuthConfigView): number {
    const oauth = input.oauthProviders.filter((p) => p.enabled && p.clientId && p.discoveryUrl).length;
    const samlHasCert =
      !!input.saml.idpCert || current.saml.idpCertSet; // cert may already be stored (not re-sent)
    const saml = input.saml.enabled && input.saml.entryPoint && samlHasCert ? 1 : 0;
    return oauth + saml;
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
      assertPublicHttpsUrl(p.discoveryUrl); // block SSRF to loopback/private/metadata via a crafted discovery URL
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

    // returnTo rides in the SERVER-stored state (never the browser/IdP), so it can't be tampered with.
    const pend: PendingOAuth = { providerId, verifier, redirectUri, returnTo };
    await this.store.set(ssoPendingKey(state), JSON.stringify(pend), SSO_PENDING_TTL_SEC);

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
    // Atomic single-use claim (GETDEL): exactly one concurrent/replayed callback for a given state can win.
    // Expiry is enforced by the store TTL (an expired key reads back as null).
    const raw = state ? await this.store.take(ssoPendingKey(state)) : null;
    const pend = raw ? (JSON.parse(raw) as PendingOAuth) : null;
    if (!pend || pend.providerId !== providerId) {
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
    // Only trust a VERIFIED email — account linking + adminEmails promotion key off the email string, so an
    // IdP that lets a user set an arbitrary unverified email must not be able to claim someone else's account.
    if (info.email_verified === false) {
      throw new AuthError('email_unverified', 'Your identity provider has not verified this email address.', 403);
    }

    const user = await this.findOrCreate(c, email, (info.name as string) || email);
    return this.issue(user, pend.returnTo);
  }

  // ─── SAML ────────────────────────────────────────────────────────────────────────────────────

  private async samlInstance(c: StoredAuthConfig, baseUrl: string): Promise<SAML> {
    // Stored as newline-joined base64 certs (IdPs publish several signing keys for rollover). Pass them
    // all to node-saml, which accepts the document signature if it validates against ANY of them.
    const certs = this.encryptor
      .decrypt(c.saml.idpCertEnc)
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    return new SAML({
      entryPoint: c.saml.entryPoint,
      issuer: c.saml.issuer || 'kravn',
      idpCert: certs.length <= 1 ? certs[0] ?? '' : certs,
      callbackUrl: `${baseUrl}/api/auth/sso/saml/callback`,
      // Require the ASSERTION to be signed (the identity is cryptographically verified), but do NOT require
      // a signature on the Response envelope. Entra/Azure AD signs the assertion by default and leaves the
      // response unsigned; node-saml v5 flipped wantAuthnResponseSigned to default true, which rejected
      // those with "Invalid document signature". Assertion-signed-only is the standard, secure SAML mode.
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
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
    const lower = email.trim().toLowerCase();
    const designatedAdmin = c.adminEmails.includes(lower);

    const existing = await this.repos.users.getByEmail(lower);
    if (existing) {
      // Promote a designated admin who currently has a lower role (e.g. replacing the local admin).
      if (designatedAdmin && existing.role !== 'admin') {
        await this.repos.users.setRole(existing.id, 'admin');
        // Invalidate any pre-existing local password: a squatter could have registered this email before
        // it was designated; promotion must not hand them an admin account they can still log into locally.
        await this.repos.users.setPasswordHash(existing.id, hashPassword(crypto.randomBytes(32).toString('hex')));
        // The newly-promoted SSO admin (e.g. replacing the local admin with an EntraID one) must land in
        // the Platform Administrator Team so it keeps access to the admin console.
        await this.repos.teams.ensurePlatformAdminMembership(existing.id);
        this.log.info({ email: lower }, 'SSO user promoted to admin (adminEmails); local password reset');
        return { ...existing, role: 'admin' };
      }
      // Any admin signing in via SSO is (re)affirmed in the console gate team — keeps the roster complete
      // for SSO-provisioned admins and self-heals if they were ever removed.
      if (existing.role === 'admin') await this.repos.teams.ensurePlatformAdminMembership(existing.id);
      return existing;
    }

    // A designated admin is an explicit allowlist, so it is provisioned even if auto-provision is off.
    if (!c.autoProvision && !designatedAdmin) {
      throw new AuthError('not_provisioned', 'No account exists for this identity and auto-provisioning is off.', 403);
    }
    const created = await this.repos.users.create({
      id: newId(),
      email: lower,
      name: name || lower,
      role: designatedAdmin ? 'admin' : c.defaultRole,
      // SSO-only account: random password it can never practically use.
      passwordHash: hashPassword(crypto.randomBytes(32).toString('hex')),
    });
    // A brand-new SSO account that IS a designated admin joins the console gate team; a normal SSO consumer
    // does not (they can use MCPs but not the admin console).
    if (designatedAdmin) await this.repos.teams.ensurePlatformAdminMembership(created.id);
    return created;
  }

  private async issue(user: UserRecord, returnTo = 'operator'): Promise<SsoLoginResult> {
    const token = await this.jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      this.settings.get().auth.sessionTtlMinutes,
    );
    return { user: toAuthUser(user), token, returnTo };
  }
}
