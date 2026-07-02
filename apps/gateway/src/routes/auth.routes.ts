import type { FastifyInstance } from 'fastify';
import { loginRequestSchema, registerRequestSchema, type AuthResponse } from '@kravn/contracts';
import type { Services } from '../services.js';
import { toAuthUser, AuthError } from '../auth/auth.service.js';
import { currentUser } from '../auth/plugin.js';
import { LoginRateLimiter } from '../auth/rate-limit.js';
import { parse, sendError } from './_helpers.js';

export function authRoutes(app: FastifyInstance, s: Services): void {
  const limiter = new LoginRateLimiter(s.sharedStore, 'login');

  app.post('/api/auth/login', async (req, reply) => {
    const auth = s.settings.get().auth;
    if (!auth.passwordLoginEnabled) {
      return sendError(reply, 403, 'password_login_disabled', 'Local password login is disabled. Use single sign-on.');
    }
    const dto = parse(reply, loginRequestSchema, req.body);
    if (!dto) return;

    const rl = auth.loginRateLimit;
    const ipKey = `ip:${req.ip}`;
    const emailKey = `email:${dto.email.toLowerCase()}`;
    // Hard pre-block on the IP key ONLY. This stops a single-source brute force and avoids amplifying a
    // scrypt-verify DoS. We do NOT pre-block on the email key, because a request that presents the correct
    // password must always succeed — otherwise a third party could lock a victim out by spraying their
    // email. The email key is consulted only AFTER a failed attempt (below), so the success path bypasses it.
    if (rl.enabled) {
      const wait = await limiter.blockedFor(ipKey, rl.maxAttempts);
      if (wait > 0) {
        reply.header('Retry-After', String(wait));
        return sendError(reply, 429, 'too_many_attempts', `Too many login attempts. Try again in ${wait}s.`);
      }
    }

    try {
      const user = await s.auth.login(dto.email, dto.password);
      if (rl.enabled) {
        await limiter.clear(ipKey);
        await limiter.clear(emailKey);
      }
      const token = await s.jwt.sign({ userId: user.id, email: user.email, role: user.role }, auth.sessionTtlMinutes);
      const teams = await s.repos.teams.teamIdsForUser(user.id);
      const body: AuthResponse = { token, user: toAuthUser(user, teams) };
      return reply.send(body);
    } catch (err) {
      if (err instanceof AuthError) {
        // Count only credential failures (401); never on the disabled/validation paths.
        if (rl.enabled && err.status === 401) {
          await limiter.recordFailure(ipKey, rl.windowSeconds);
          await limiter.recordFailure(emailKey, rl.windowSeconds);
          // After a wrong password, throttle further guessing on this IP or this account. A legitimate
          // user never reaches here (their correct password returns above), so this can't lock them out.
          const wait = Math.max(await limiter.blockedFor(ipKey, rl.maxAttempts), await limiter.blockedFor(emailKey, rl.maxAttempts));
          if (wait > 0) {
            reply.header('Retry-After', String(wait));
            return sendError(reply, 429, 'too_many_attempts', `Too many login attempts. Try again in ${wait}s.`);
          }
        }
        return sendError(reply, err.status, err.code, err.message);
      }
      throw err;
    }
  });

  app.post('/api/auth/register', async (req, reply) => {
    const auth = s.settings.get().auth;
    if (!auth.passwordLoginEnabled) {
      return sendError(reply, 403, 'password_login_disabled', 'Local accounts are disabled. Use single sign-on.');
    }
    const rl = auth.loginRateLimit;
    // Separate key namespace so registration pressure can never consume the login budget (and vice versa).
    const regKey = `reg:${req.ip}`;
    if (rl.enabled) {
      const wait = await limiter.blockedFor(regKey, rl.maxAttempts);
      if (wait > 0) {
        reply.header('Retry-After', String(wait));
        return sendError(reply, 429, 'too_many_attempts', `Too many attempts. Try again in ${wait}s.`);
      }
    }
    const dto = parse(reply, registerRequestSchema, req.body);
    if (!dto) return;
    // Never let a self-service registration claim an email reserved as an SSO admin — that email's account
    // must only ever be created/owned through SSO (otherwise a squatter could pre-seed a local credential).
    if (await s.sso.isAdminEmail(dto.email)) {
      return sendError(reply, 403, 'reserved_email', 'This email is reserved for single sign-on.');
    }
    try {
      const user = await s.auth.register(dto);
      const token = await s.jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        auth.sessionTtlMinutes,
      );
      const teams = await s.repos.teams.teamIdsForUser(user.id);
      const body: AuthResponse = { token, user: toAuthUser(user, teams) };
      return reply.code(201).send(body);
    } catch (err) {
      if (err instanceof AuthError) {
        if (rl.enabled) await limiter.recordFailure(regKey, rl.windowSeconds);
        return sendError(reply, err.status, err.code, err.message);
      }
      throw err;
    }
  });

  // Exchange a one-time SSO 'handoff' code (delivered in the post-login redirect URL) for a real session
  // token. Keeps a full session bearer out of the redirect URL (browser history / proxy logs).
  app.post('/api/auth/exchange', async (req, reply) => {
    const code = (req.body as { code?: string })?.code ?? '';
    if (!code) return sendError(reply, 400, 'invalid_request', 'Missing code.');
    try {
      const claims = await s.jwt.verify(code);
      if (claims.scope !== 'handoff') return sendError(reply, 401, 'invalid_code', 'Invalid handoff code.');
      // Atomic single-use claim: exactly one concurrent exchange of a given code wins (jti PK). A stolen
      // code racing the legitimate login can no longer both succeed.
      if (!(await s.repos.tokens.consume(claims.jti))) return sendError(reply, 401, 'invalid_code', 'Code already used.');
      const user = await s.repos.users.getById(claims.sub);
      if (!user) return sendError(reply, 401, 'invalid_code', 'Account no longer exists.');
      if (user.disabled) return sendError(reply, 403, 'account_disabled', 'This account is disabled.');
      const token = await s.jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        s.settings.get().auth.sessionTtlMinutes,
      );
      const teams = await s.repos.teams.teamIdsForUser(user.id);
      const body: AuthResponse = { token, user: toAuthUser(user, teams) };
      return reply.send(body);
    } catch {
      return sendError(reply, 401, 'invalid_code', 'Invalid or expired handoff code.');
    }
  });

  app.get('/api/auth/me', { preHandler: [app.authenticate] }, async (req) => {
    return { user: currentUser(req) };
  });

  app.post('/api/auth/logout', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.tokenJti) await s.repos.tokens.revoke(req.tokenJti);
    return reply.send({ ok: true });
  });
}
