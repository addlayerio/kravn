import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { permissionMatches, PLATFORM_ADMIN_TEAM_ID } from '@kravn/contracts';
import { toAuthUser, type AuthUser } from './auth.service.js';
import type { JwtService } from './jwt.js';
import type { Repos } from '../db/repos.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { PluginManager } from '../plugins/manager.js';
import type { Logger } from 'pino';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    tokenJti?: string;
  }
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
    authorize: (...permissions: string[]) => preHandlerHookHandler;
  }
}

export interface AuthDeps {
  jwt: JwtService;
  repos: Repos;
  settings: SettingsService;
  log: Logger;
  plugins?: PluginManager;
}

export const COOKIE_NAME = 'kravn_token';
const CSRF_COOKIE = 'kravn_csrf';

function extractToken(req: FastifyRequest): { token: string; fromCookie: boolean } | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return { token: auth.slice(7).trim(), fromCookie: false };
  const cookie = (req.cookies as Record<string, string> | undefined)?.[COOKIE_NAME];
  if (cookie) return { token: cookie, fromCookie: true };
  return null;
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  app.decorateRequest('user', null);

  app.decorate('authenticate', async function (req: FastifyRequest, reply: FastifyReply) {
    const extracted = extractToken(req);
    if (!extracted) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required.' } });

    try {
      const claims = await deps.jwt.verify(extracted.token);

      // Only an UNSCOPED session token authenticates the control-plane API. Any scoped token — 'mcp' (OAuth),
      // 'logstream' (SSE ticket) or 'handoff' (SSO one-time code) — is restricted to its own narrow endpoint.
      if (claims.scope) {
        return reply.code(403).send({ error: { code: 'wrong_scope', message: 'This token cannot access the control-plane API.' } });
      }

      // Fail-closed revocation: if the check errors, treat as revoked.
      let revoked = true;
      try {
        revoked = await deps.repos.tokens.isRevoked(claims.jti);
      } catch (err) {
        deps.log.error({ err }, 'revocation check failed; denying');
        revoked = true;
      }
      if (revoked) return reply.code(401).send({ error: { code: 'token_revoked', message: 'Session expired.' } });

      // Idle timeout + session tracking. Tokens issued before session-tracking existed have no row, so they
      // are left alone (upgrade-safe). A tracked session past its idle window is revoked and rejected;
      // otherwise its last-seen is refreshed (throttled to ≤ once/minute to avoid a write per request).
      const session = await deps.repos.sessions.get(claims.jti).catch(() => undefined);
      if (session) {
        // Defense in depth: reject a revoked session even if its jti isn't in token_revocations.
        if (session.revoked) return reply.code(401).send({ error: { code: 'token_revoked', message: 'Session expired.' } });
        const idleMin = deps.settings.get().auth.idleTimeoutMinutes ?? 0;
        const idleMs = Date.now() - Date.parse(session.lastSeenAt);
        if (idleMin > 0 && idleMs > idleMin * 60_000) {
          await deps.repos.tokens.revoke(claims.jti).catch(() => {});
          await deps.repos.sessions.revoke(claims.jti).catch(() => {});
          return reply.code(401).send({ error: { code: 'session_idle', message: 'Session timed out due to inactivity.' } });
        }
        if (idleMs > 60_000) void deps.repos.sessions.touch(claims.jti, new Date().toISOString());
      }

      const user = await deps.repos.users.getById(claims.sub);
      if (!user) return reply.code(401).send({ error: { code: 'unknown_user', message: 'Account no longer exists.' } });
      if (user.disabled) return reply.code(403).send({ error: { code: 'account_disabled', message: 'This account is disabled.' } });

      // CSRF (double-submit) only matters for cookie-authenticated mutating requests.
      if (
        extracted.fromCookie &&
        deps.settings.get().security.csrfEnabled &&
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      ) {
        const csrfCookie = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
        const csrfHeader = req.headers['x-csrf-token'];
        if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
          return reply.code(403).send({ error: { code: 'csrf', message: 'Invalid or missing CSRF token.' } });
        }
      }

      req.user = toAuthUser(user, await deps.repos.teams.teamIdsForUser(user.id));
      req.tokenJti = claims.jti;

      // Plugin "auth resolve user" hooks may remap/augment the user, or deny access.
      if (deps.plugins?.hasResolveUser()) {
        try {
          req.user = await deps.plugins.applyResolveUser(req.user);
        } catch (err) {
          return reply.code(403).send({ error: { code: 'forbidden', message: err instanceof Error ? err.message : 'Access denied by policy.' } });
        }
      }
    } catch (err) {
      return reply.code(401).send({ error: { code: 'invalid_token', message: 'Invalid or expired token.' } });
    }
  });

  app.decorate('authorize', function (...permissions: string[]): preHandlerHookHandler {
    return async function (req: FastifyRequest, reply: FastifyReply) {
      const user = req.user;
      if (!user) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required.' } });
      // Admin-console gate: EVERY control-plane route goes through authorize(), so this one check confines
      // the whole administration platform to the Platform Administrator Team. A user who only consumes MCPs
      // (not in the team, not an admin) is rejected here regardless of their role's permissions. The chat and
      // MCP data-plane use app.authenticate / authenticateToken, not authorize(), so they're unaffected.
      // A role='admin' user is always allowed (they're the system administrators, and are seeded into the
      // team anyway) — this is the anti-lockout backstop: no team-membership edge case can bar an admin from
      // their own console. The team is what additionally grants console access to NON-admin (editor/viewer)
      // users and is the canonical roster.
      if (user.role !== 'admin' && !user.teams.includes(PLATFORM_ADMIN_TEAM_ID)) {
        return reply.code(403).send({
          error: { code: 'not_platform_admin', message: 'Access to the administration console is restricted to the Platform Administrator Team.' },
        });
      }
      const ok = permissions.every((p) => permissionMatches(user.permissions, p));
      if (!ok) return reply.code(403).send({ error: { code: 'forbidden', message: 'You do not have permission to do that.' } });
    };
  });
}

/** Helper for route handlers: the authenticated user is guaranteed by the `authenticate` preHandler. */
export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new Error('currentUser() called without authenticate preHandler');
  return req.user;
}

/** Manually verify a bearer token (for routes with conditional auth, e.g. per-VS MCP endpoints). */
export async function authenticateToken(token: string, jwt: JwtService, repos: Repos): Promise<AuthUser | null> {
  try {
    const claims = await jwt.verify(token);
    if (await repos.tokens.isRevoked(claims.jti)) return null;
    const user = await repos.users.getById(claims.sub);
    if (!user || user.disabled) return null;
    return toAuthUser(user, await repos.teams.teamIdsForUser(user.id));
  } catch {
    return null;
  }
}

export function bearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  return auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}
