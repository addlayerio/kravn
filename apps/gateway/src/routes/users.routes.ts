import type { FastifyInstance } from 'fastify';
import { createUserSchema } from '@kravn/contracts';
import type { Services } from '../services.js';
import { AuthError } from '../auth/auth.service.js';
import { currentUser } from '../auth/plugin.js';
import { parse, sendError } from './_helpers.js';

export function userRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/users', { preHandler: [app.authenticate, app.authorize('users.read')] }, async () => {
    return { users: await s.repos.users.list() };
  });

  app.post('/api/users', { preHandler: [app.authenticate, app.authorize('users.write')] }, async (req, reply) => {
    const dto = parse(reply, createUserSchema, req.body);
    if (!dto) return;
    try {
      const u = await s.auth.createUser(dto);
      return reply.code(201).send({
        user: { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt, updatedAt: u.updatedAt },
      });
    } catch (err) {
      if (err instanceof AuthError) return sendError(reply, err.status, err.code, err.message);
      throw err;
    }
  });

  app.delete('/api/users/:id', { preHandler: [app.authenticate, app.authorize('users.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (currentUser(req).id === id) {
      return sendError(reply, 400, 'self_delete', 'You cannot delete your own account.');
    }
    await s.repos.users.delete(id);
    return reply.code(204).send();
  });
}
