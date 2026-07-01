import type { FastifyInstance } from 'fastify';
import { createUserSchema, updateUserSchema, PLATFORM_ADMIN_TEAM_ID } from '@kravn/contracts';
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
        user: { id: u.id, email: u.email, name: u.name, role: u.role, disabled: u.disabled, createdAt: u.createdAt, updatedAt: u.updatedAt },
      });
    } catch (err) {
      if (err instanceof AuthError) return sendError(reply, err.status, err.code, err.message);
      throw err;
    }
  });

  app.patch('/api/users/:id', { preHandler: [app.authenticate, app.authorize('users.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = parse(reply, updateUserSchema, req.body);
    if (!dto) return;
    const meId = currentUser(req).id;
    type Outcome = 'ok' | 'not_found' | 'last_admin' | 'email_taken' | 'self_disable';
    const outcome = await withAdminLock(async (): Promise<Outcome> => {
      const target = await s.repos.users.getById(id);
      if (!target) return 'not_found';
      // Anti-lockout: don't strip the last admin of admin powers — by demotion OR by disabling.
      const demoting = dto.role !== undefined && dto.role !== 'admin' && target.role === 'admin';
      const disablingAdmin = dto.disabled === true && target.role === 'admin';
      if ((demoting || disablingAdmin) && (await s.repos.users.countByRole('admin')) <= 1) return 'last_admin';
      // Don't let someone disable their own account (self-inflicted lockout).
      if (dto.disabled === true && id === meId) return 'self_disable';
      // Email uniqueness (case-insensitive) against OTHER users.
      if (dto.email && (await s.auth.isEmailTaken(dto.email, id))) return 'email_taken';
      await s.auth.updateUser(id, dto);
      // Keep console access aligned with the admin role: promoting to admin joins the Platform Administrator
      // Team; demoting FROM admin removes them from it. (See the console gate.)
      if (dto.role === 'admin') await s.repos.teams.ensurePlatformAdminMembership(id);
      else if (dto.role !== undefined && target.role === 'admin') await s.repos.teams.removeMember(PLATFORM_ADMIN_TEAM_ID, id);
      return 'ok';
    });
    if (outcome === 'not_found') return sendError(reply, 404, 'not_found', 'User not found.');
    if (outcome === 'last_admin') {
      return sendError(reply, 400, 'last_admin', 'Cannot remove or disable the last admin. Promote or enable another admin first.');
    }
    if (outcome === 'email_taken') return sendError(reply, 409, 'email_taken', 'That email is already registered.');
    if (outcome === 'self_disable') return sendError(reply, 400, 'self_disable', 'You cannot disable your own account.');
    const u = (await s.repos.users.getById(id))!;
    return { user: { id: u.id, email: u.email, name: u.name, role: u.role, disabled: u.disabled, createdAt: u.createdAt, updatedAt: u.updatedAt } };
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
      // Revoke the user's OAuth grants so a connected client (e.g. Claude) can't keep acting as them.
      await s.repos.oauth.deleteRefreshForUser(id);
      return false;
    });
    if (blocked) {
      return sendError(reply, 400, 'last_admin', 'Cannot delete the last admin. Grant admin to another account first.');
    }
    return reply.code(204).send();
  });
}
