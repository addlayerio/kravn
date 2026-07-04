import type { FastifyInstance } from 'fastify';
import { invokeToolSchema, upsertMcpEndpointSchema } from '@kravn/contracts';
import { newId, slugify } from '../crypto.js';
import type { Services } from '../services.js';
import { currentUser } from '../auth/plugin.js';
import { parse, sendError } from './_helpers.js';

export function registryRoutes(app: FastifyInstance, s: Services): void {
  const authRead = { preHandler: [app.authenticate, app.authorize('registry.read')] };
  const authWrite = { preHandler: [app.authenticate, app.authorize('registry.write')] };

  // ─── Tools / Resources / Prompts (read-only catalog views) ──────────────────────────────────
  app.get('/api/tools', authRead, async () => ({ tools: await s.repos.registry.listTools() }));
  app.get('/api/resources', authRead, async () => ({ resources: await s.repos.registry.listResources() }));
  app.get('/api/prompts', authRead, async () => ({ prompts: await s.repos.registry.listPrompts() }));

  app.patch('/api/tools/:id', authWrite, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled === 'boolean') await s.repos.registry.setToolEnabled(id, body.enabled);
    const tool = await s.repos.registry.getTool(id);
    if (!tool) return sendError(reply, 404, 'not_found', 'Tool not found.');
    return { tool };
  });

  // Invoke a tool from the UI playground. Goes through authorize() (so the Platform-Administrator-Team gate
  // applies like every control-plane route) AND is further restricted to admins inline: it invokes a tool by
  // id with NO mcp-endpoint context, so it bypasses the per-VS access policy AND the per-team tool subset.
  // It must NOT be opened to editors (registry.write) or that bypass returns. Non-admins invoke through a
  // virtual server (/servers/:slug/mcp) or chat, where both entitlement levels are enforced.
  app.post('/api/tools/:id/invoke', { preHandler: [app.authenticate, app.authorize()] }, async (req, reply) => {
    const actor = currentUser(req);
    if (actor.role !== 'admin') {
      return sendError(reply, 403, 'forbidden', 'The raw tool playground is admin-only; invoke via a virtual server.');
    }
    const { id } = req.params as { id: string };
    const dto = parse(reply, invokeToolSchema, req.body ?? {});
    if (!dto) return;
    try {
      const result = await s.registry.invokeTool(id, dto.arguments, actor);
      return { result };
    } catch (err) {
      return sendError(reply, 400, 'invoke_failed', err instanceof Error ? err.message : 'Tool invocation failed.');
    }
  });

  // ─── Virtual servers ────────────────────────────────────────────────────────────────────────
  const vsRead = { preHandler: [app.authenticate, app.authorize('endpoints.read')] };
  const vsWrite = { preHandler: [app.authenticate, app.authorize('endpoints.write')] };

  async function uniqueVsSlug(name: string, exceptId?: string): Promise<string> {
    const base = slugify(name);
    let candidate = base;
    let n = 1;
    while (true) {
      const existing = await s.repos.mcpEndpoints.getBySlug(candidate);
      if (!existing || existing.id === exceptId) return candidate;
      n += 1;
      candidate = `${base}-${n}`;
    }
  }

  app.get('/api/mcp-endpoints', vsRead, async () => ({ mcpEndpoints: await s.repos.mcpEndpoints.list() }));

  app.post('/api/mcp-endpoints', vsWrite, async (req, reply) => {
    const dto = parse(reply, upsertMcpEndpointSchema, req.body);
    if (!dto) return;
    const vs = await s.repos.mcpEndpoints.create({
      id: newId(),
      name: dto.name,
      slug: await uniqueVsSlug(dto.name),
      description: dto.description,
      toolIds: dto.toolIds,
      resourceIds: dto.resourceIds,
      promptIds: dto.promptIds,
      access: dto.access,
      allowedRoles: dto.allowedRoles,
      allowedTeams: dto.allowedTeams,
      enabled: dto.enabled,
    });
    return reply.code(201).send({ mcpEndpoint: vs });
  });

  app.patch('/api/mcp-endpoints/:id', vsWrite, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = parse(reply, upsertMcpEndpointSchema.partial(), req.body);
    if (!dto) return;
    const patch: Record<string, unknown> = { ...dto };
    if (dto.name) patch.slug = await uniqueVsSlug(dto.name, id);
    await s.repos.mcpEndpoints.update(id, patch);
    const vs = await s.repos.mcpEndpoints.getById(id);
    if (!vs) return sendError(reply, 404, 'not_found', 'Virtual server not found.');
    return { mcpEndpoint: vs };
  });

  app.delete('/api/mcp-endpoints/:id', { preHandler: [app.authenticate, app.authorize('endpoints.delete')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await s.repos.teams.clearServerGrants(id); // drop any per-team tool grants for this server
    await s.repos.pipeline.deleteByScope(id); // drop this VS's hook-pipeline overlay
    await s.repos.mcpEndpoints.delete(id);
    await s.plugins.reloadPipeline(); // refresh the in-memory chains so the removed overlay is gone
    return reply.code(204).send();
  });
}
