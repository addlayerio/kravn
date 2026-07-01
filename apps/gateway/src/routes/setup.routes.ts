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
      const token = await s.jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        s.settings.get().auth.sessionTtlMinutes,
      );
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
