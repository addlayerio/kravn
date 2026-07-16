import type { FastifyInstance } from 'fastify';
import { createAgentSchema, updateAgentSchema, type ChatAgent } from '@kravn/contracts';
import { newId } from '../crypto.js';
import type { Services } from '../services.js';
import { parse, sendError } from './_helpers.js';

/**
 * Org-level **Agent** administration (operator / control plane). Agents are reusable chat presets an admin
 * defines here and shares with users/teams; the client only READS the ones a user may use (see chat.routes.ts
 * `/api/chat/agents`). Managing them is gated by `settings.*` — the same axis as other org configuration.
 */
export function agentRoutes(app: FastifyInstance, s: Services): void {
  const read = { preHandler: [app.authenticate, app.authorize('settings.read')] };
  const write = { preHandler: [app.authenticate, app.authorize('settings.write')] };

  app.get('/api/agents', read, async () => ({ agents: await s.repos.chat.listAgents() }));

  app.get('/api/agents/:id', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await s.repos.chat.getAgent(id);
    if (!agent) return sendError(reply, 404, 'not_found', 'Agent not found.');
    return { agent };
  });

  app.post('/api/agents', write, async (req, reply) => {
    const dto = parse(reply, createAgentSchema, req.body);
    if (!dto) return;
    const agent = await s.repos.chat.createAgent(newId(), fromDto(dto));
    return reply.code(201).send({ agent });
  });

  app.put('/api/agents/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = parse(reply, updateAgentSchema, req.body);
    if (!dto) return;
    if (!(await s.repos.chat.getAgent(id))) return sendError(reply, 404, 'not_found', 'Agent not found.');
    await s.repos.chat.updateAgent(id, dto);
    return { agent: await s.repos.chat.getAgent(id) };
  });

  app.delete('/api/agents/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    await s.repos.chat.deleteAgent(id);
    return reply.code(204).send();
  });
}

/** Fill a create DTO to the full stored shape (the DTO leaves optional fields unset; defaults live here). */
function fromDto(dto: import('@kravn/contracts').CreateAgentRequest): Omit<ChatAgent, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: dto.name,
    description: dto.description ?? '',
    instructions: dto.instructions ?? '',
    providerId: dto.providerId ?? '',
    model: dto.model ?? '',
    toolIds: dto.toolIds ?? [],
    access: dto.access ?? 'restricted',
    allowedTeams: dto.allowedTeams ?? [],
    allowedUsers: dto.allowedUsers ?? [],
    enabled: dto.enabled ?? true,
  };
}
