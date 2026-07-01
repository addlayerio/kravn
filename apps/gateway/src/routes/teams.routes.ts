import type { FastifyInstance } from 'fastify';
import { createTeamSchema, updateTeamSchema, addTeamMemberSchema } from '@kravn/contracts';
import { newId, slugify } from '../crypto.js';
import { currentUser } from '../auth/plugin.js';
import type { Services } from '../services.js';
import { parse, sendError } from './_helpers.js';

export function teamRoutes(app: FastifyInstance, s: Services): void {
  const read = { preHandler: [app.authenticate, app.authorize('teams.read')] };
  const write = { preHandler: [app.authenticate, app.authorize('teams.write')] };

  async function uniqueSlug(name: string, exceptId?: string): Promise<string> {
    const base = slugify(name);
    let candidate = base;
    let n = 1;
    while (true) {
      const ex = await s.repos.teams.getBySlug(candidate);
      if (!ex || ex.id === exceptId) return candidate;
      n += 1;
      candidate = `${base}-${n}`;
    }
  }

  app.get('/api/teams', read, async () => ({ teams: await s.repos.teams.list() }));

  app.get('/api/teams/:id/members', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await s.repos.teams.getById(id))) return sendError(reply, 404, 'not_found', 'Team not found.');
    // `teams.read` alone is not enough to read a roster: a non-admin may only list members of a team they
    // belong to. Otherwise any viewer could enumerate every team's membership and role assignments by id.
    const me = currentUser(req);
    if (me.role !== 'admin' && !me.teams.includes(id)) {
      return sendError(reply, 403, 'forbidden', 'You are not a member of this team.');
    }
    return { members: await s.repos.teams.members(id) };
  });

  app.post('/api/teams', write, async (req, reply) => {
    const dto = parse(reply, createTeamSchema, req.body);
    if (!dto) return;
    const team = await s.repos.teams.create({ id: newId(), name: dto.name, slug: await uniqueSlug(dto.name), description: dto.description });
    return reply.code(201).send({ team });
  });

  app.patch('/api/teams/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = parse(reply, updateTeamSchema, req.body);
    if (!dto) return;
    const patch: { name?: string; slug?: string; description?: string } = { ...dto };
    if (dto.name) patch.slug = await uniqueSlug(dto.name, id);
    await s.repos.teams.update(id, patch);
    const team = await s.repos.teams.getById(id);
    if (!team) return sendError(reply, 404, 'not_found', 'Team not found.');
    return { team };
  });

  app.delete('/api/teams/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    await s.repos.teams.delete(id);
    return reply.code(204).send();
  });

  app.post('/api/teams/:id/members', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = parse(reply, addTeamMemberSchema, req.body);
    if (!dto) return;
    if (!(await s.repos.teams.getById(id))) return sendError(reply, 404, 'not_found', 'Team not found.');
    if (!(await s.repos.users.getById(dto.userId))) return sendError(reply, 400, 'no_user', 'No such user.');
    await s.repos.teams.addMember(id, dto.userId, dto.role);
    return { members: await s.repos.teams.members(id) };
  });

  app.delete('/api/teams/:id/members/:userId', write, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    await s.repos.teams.removeMember(id, userId);
    return reply.code(204).send();
  });
}
