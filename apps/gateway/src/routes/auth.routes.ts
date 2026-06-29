import type { FastifyInstance } from 'fastify';
import { loginRequestSchema, registerRequestSchema, type AuthResponse } from '@kravn/contracts';
import type { Services } from '../services.js';
import { toAuthUser, AuthError } from '../auth/auth.service.js';
import { currentUser } from '../auth/plugin.js';
import { parse, sendError } from './_helpers.js';

export function authRoutes(app: FastifyInstance, s: Services): void {
  app.post('/api/auth/login', async (req, reply) => {
    const dto = parse(reply, loginRequestSchema, req.body);
    if (!dto) return;
    try {
      const user = await s.auth.login(dto.email, dto.password);
      const token = await s.jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        s.settings.get().auth.sessionTtlMinutes,
      );
      const teams = await s.repos.teams.teamIdsForUser(user.id);
      const body: AuthResponse = { token, user: toAuthUser(user, teams) };
      return reply.send(body);
    } catch (err) {
      if (err instanceof AuthError) return sendError(reply, err.status, err.code, err.message);
      throw err;
    }
  });

  app.post('/api/auth/register', async (req, reply) => {
    const dto = parse(reply, registerRequestSchema, req.body);
    if (!dto) return;
    try {
      const user = await s.auth.register(dto);
      const token = await s.jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        s.settings.get().auth.sessionTtlMinutes,
      );
      const teams = await s.repos.teams.teamIdsForUser(user.id);
      const body: AuthResponse = { token, user: toAuthUser(user, teams) };
      return reply.code(201).send(body);
    } catch (err) {
      if (err instanceof AuthError) return sendError(reply, err.status, err.code, err.message);
      throw err;
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
