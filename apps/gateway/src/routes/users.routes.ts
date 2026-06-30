import type { FastifyInstance } from 'fastify';
import { createUserSchema } from '@kravn/contracts';
import type { Services } from '../services.js';
import { AuthError } from '../auth/auth.service.js';
import { currentUser } from '../auth/plugin.js';
import { parse, sendError } from './_helpers.js';

export function userRoutes(app: FastifyInstance, s: Services): void {
  // Serialize admin-count-sensitive writes within this process so the last-admin check and the delete
  // can't interleave (check-then-act TOCTOU) on concurrent requests / double-submits.
  let adminWriteLock: Promise<unknown> = Promise.resolve();
  const withAdminLock = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = adminWriteLock.then(fn, fn);
    adminWriteLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

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
    const blocked = await withAdminLock(async () => {
      const target = await s.repos.users.getById(id);
      if (!target) return false;
      // Anti-lockout: never delete the last admin (e.g. when replacing the local admin with an SSO admin,
      // promote the SSO user to admin first, then this allows removing the old one).
      if (target.role === 'admin' && (await s.repos.users.countByRole('admin')) <= 1) return true;
      await s.repos.users.delete(id);
      return false;
    });
    if (blocked) {
      return sendError(reply, 400, 'last_admin', 'Cannot delete the last admin. Grant admin to another account first.');
    }
    return reply.code(204).send();
  });
}
