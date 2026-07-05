import type { FastifyInstance } from 'fastify';
import { setupRequestSchema, type AuthResponse } from '@kravn/contracts';
import type { Services } from '../services.js';
import { toAuthUser, AuthError } from '../auth/auth.service.js';
import { parse, sendError } from './_helpers.js';

export function setupRoutes(app: FastifyInstance, s: Services): void {
  // First-run setup wizard. Public, but only works while no users exist.
  app.post('/api/setup', async (req, reply) => {
    const dto = parse(reply, setupRequestSchema, req.body);
    if (!dto) return;
    try {
      const user = await s.auth.setup(dto);
      const ttlMin = s.settings.get().auth.sessionTtlMinutes;
      const { token, jti } = await s.jwt.signSession({ userId: user.id, email: user.email, role: user.role }, ttlMin);
      await s.repos.sessions.create({
        jti,
        userId: user.id,
        expiresAt: new Date(Date.now() + ttlMin * 60_000).toISOString(),
        ip: req.ip ?? '',
        userAgent: String(req.headers['user-agent'] ?? ''),
      });
      // Include team membership (setup() joined the admin to the Platform Administrator Team) so the
      // operator recognises the new admin as a console user immediately — otherwise its gate would bounce it.
      const teams = await s.repos.teams.teamIdsForUser(user.id);
      const body: AuthResponse = { token, user: toAuthUser(user, teams) };
      return reply.code(201).send(body);
    } catch (err) {
      if (err instanceof AuthError) return sendError(reply, err.status, err.code, err.message);
      throw err;
    }
  });
}
