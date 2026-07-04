import type { FastifyInstance } from 'fastify';
import { createTeamSchema, updateTeamSchema, addTeamMemberSchema, setTeamServerAccessSchema, PLATFORM_ADMIN_TEAM_ID } from '@kravn/contracts';
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
    if (id === PLATFORM_ADMIN_TEAM_ID) {
      return sendError(reply, 400, 'protected_team', 'The Platform Administrator Team cannot be deleted; it gates console access.');
    }
    // Strip the team from every virtual server's allowedTeams so no phantom grant lingers (the team's
    // tool-subset rows are cleared inside teams.delete()).
    const servers = await s.repos.mcpEndpoints.list();
    await Promise.all(
      servers
        .filter((vs) => vs.allowedTeams.includes(id))
        .map((vs) => s.repos.mcpEndpoints.update(vs.id, { allowedTeams: vs.allowedTeams.filter((t) => t !== id) })),
    );
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
    // Don't let an admin remove THEMSELVES from the console-gate team (would lock themselves out until the
    // next restart's reconciliation). Removing other members is allowed.
    if (id === PLATFORM_ADMIN_TEAM_ID && userId === currentUser(req).id) {
      return sendError(reply, 400, 'self_lockout', 'You cannot remove yourself from the Platform Administrator Team.');
    }
    await s.repos.teams.removeMember(id, userId);
    return reply.code(204).send();
  });

  // ─── MCP access per team (level 1: which MCPs; level 2: which tools of each MCP) ──────────────────
  // Admin-only. Level 1 is the team's presence in virtual_servers.allowed_teams; level 2 is the optional
  // per-(team, VS) tool subset in team_server_tools. Granting a team also flips the VS to `restricted`
  // (otherwise `authenticated`/`public` would leave it open to everyone and the grant would be moot).

  /** Shape one virtual server for the team-access UI (granted? all tools or a subset? which tools exist). */
  async function serverAccessItem(teamId: string, vs: Awaited<ReturnType<typeof s.repos.mcpEndpoints.getById>>, allTools: { id: string; name: string; serverId: string }[]) {
    if (!vs) return null;
    const subset = await s.repos.teams.serverToolSubset(teamId, vs.id);
    const toolIdSet = new Set(vs.toolIds);
    return {
      id: vs.id,
      name: vs.name,
      slug: vs.slug,
      access: vs.access,
      enabled: vs.enabled,
      granted: vs.allowedTeams.includes(teamId),
      allTools: subset.length === 0,
      toolIds: subset,
      tools: allTools.filter((t) => toolIdSet.has(t.id)).map((t) => ({ id: t.id, name: t.name, serverId: t.serverId })),
    };
  }

  app.get('/api/teams/:id/servers', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await s.repos.teams.getById(id))) return sendError(reply, 404, 'not_found', 'Team not found.');
    const [servers, allTools] = await Promise.all([s.repos.mcpEndpoints.list(), s.repos.registry.listTools()]);
    const items = (await Promise.all(servers.map((vs) => serverAccessItem(id, vs, allTools)))).filter(Boolean);
    return { servers: items };
  });

  app.put('/api/teams/:id/servers/:vsId', write, async (req, reply) => {
    const { id, vsId } = req.params as { id: string; vsId: string };
    const dto = parse(reply, setTeamServerAccessSchema, req.body);
    if (!dto) return;
    if (!(await s.repos.teams.getById(id))) return sendError(reply, 404, 'not_found', 'Team not found.');
    const vs = await s.repos.mcpEndpoints.getById(vsId);
    if (!vs) return sendError(reply, 404, 'not_found', 'Virtual server not found.');

    const teams = new Set(vs.allowedTeams);
    if (dto.granted) {
      teams.add(id);
      const patch: Record<string, unknown> = { allowedTeams: [...teams] };
      if (vs.access !== 'restricted') patch.access = 'restricted'; // team grants only bite in restricted mode
      await s.repos.mcpEndpoints.update(vs.id, patch);
      // Keep only tool ids that actually belong to this virtual server; null/[] ⇒ full server (all tools).
      const valid = dto.toolIds == null ? null : dto.toolIds.filter((t) => vs.toolIds.includes(t));
      await s.repos.teams.setServerToolSubset(id, vs.id, valid);
    } else {
      teams.delete(id);
      await s.repos.mcpEndpoints.update(vs.id, { allowedTeams: [...teams] });
      await s.repos.teams.setServerToolSubset(id, vs.id, null); // clear any subset
    }

    const [updated, allTools] = await Promise.all([s.repos.mcpEndpoints.getById(vs.id), s.repos.registry.listTools()]);
    return { server: await serverAccessItem(id, updated, allTools) };
  });
}
