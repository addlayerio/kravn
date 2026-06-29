import type { FastifyInstance } from 'fastify';
import { createLlmProviderSchema, updateLlmProviderSchema, testLlmProviderSchema, discoverLlmModelsSchema } from '@kravn/contracts';
import type { Services } from '../services.js';
import { LlmService } from '../llm/llm.service.js';
import { parse, sendError } from './_helpers.js';

export function llmRoutes(app: FastifyInstance, s: Services): void {
  const llm = new LlmService(s.repos, s.encryptor, s.log);
  const read = { preHandler: [app.authenticate, app.authorize('settings.read')] };
  const write = { preHandler: [app.authenticate, app.authorize('settings.write')] };

  app.get('/api/llm/providers', read, async () => ({ providers: await llm.list() }));

  app.post('/api/llm/providers', write, async (req, reply) => {
    const dto = parse(reply, createLlmProviderSchema, req.body);
    if (!dto) return;
    const provider = await llm.create(dto);
    return reply.code(201).send({ provider });
  });

  app.patch('/api/llm/providers/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = parse(reply, updateLlmProviderSchema, req.body);
    if (!dto) return;
    const provider = await llm.update(id, dto);
    if (!provider) return sendError(reply, 404, 'not_found', 'Provider not found.');
    return { provider };
  });

  app.delete('/api/llm/providers/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    await llm.delete(id);
    return reply.code(204).send();
  });

  // Discover the models a provider exposes (live from its API, else the offline catalog).
  app.post('/api/llm/discover', write, async (req, reply) => {
    const dto = parse(reply, discoverLlmModelsSchema, req.body ?? {});
    if (!dto) return;
    try {
      const result = await llm.discoverModels(dto);
      return { result };
    } catch (err) {
      return sendError(reply, 400, 'discover_failed', err instanceof Error ? err.message : 'Could not discover models.');
    }
  });

  app.post('/api/llm/providers/:id/test', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = parse(reply, testLlmProviderSchema, req.body ?? {});
    if (!dto) return;
    try {
      const result = await llm.test(id, dto.model);
      return { result };
    } catch (err) {
      return sendError(reply, 400, 'test_failed', err instanceof Error ? err.message : 'Test failed.');
    }
  });
}
