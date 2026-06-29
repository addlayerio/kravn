import type { FastifyInstance } from 'fastify';
import { upsertLocalPromptSchema, previewLocalPromptSchema } from '@kravn/contracts';
import { newId, slugify } from '../crypto.js';
import { renderTemplate } from '../prompts/render.js';
import type { Services } from '../services.js';
import { parse, sendError } from './_helpers.js';

export function localPromptRoutes(app: FastifyInstance, s: Services): void {
  const read = { preHandler: [app.authenticate, app.authorize('registry.read')] };
  const write = { preHandler: [app.authenticate, app.authorize('registry.write')] };

  app.get('/api/local-prompts', read, async () => ({ localPrompts: await s.repos.localPrompts.list() }));

  // Live preview while authoring (no save needed).
  app.post('/api/local-prompts/preview', read, async (req, reply) => {
    const dto = parse(reply, previewLocalPromptSchema, req.body);
    if (!dto) return;
    try {
      return { rendered: renderTemplate(dto.template, dto.values) };
    } catch (err) {
      return sendError(reply, 400, 'render_error', err instanceof Error ? err.message : 'Template error.');
    }
  });

  app.post('/api/local-prompts', write, async (req, reply) => {
    const dto = parse(reply, upsertLocalPromptSchema, req.body);
    if (!dto) return;
    if (await s.repos.localPrompts.getByName(dto.name)) {
      return sendError(reply, 409, 'name_taken', 'A prompt with that name already exists.');
    }
    try {
      renderTemplate(dto.template, {}); // compile check
    } catch (err) {
      return sendError(reply, 400, 'invalid_template', err instanceof Error ? err.message : 'Invalid template.');
    }
    const lp = await s.repos.localPrompts.create({
      id: newId(),
      name: dto.name,
      slug: slugify(dto.name),
      description: dto.description,
      template: dto.template,
      arguments: dto.arguments,
      role: dto.role,
      enabled: dto.enabled,
    });
    return reply.code(201).send({ localPrompt: lp });
  });

  app.patch('/api/local-prompts/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = parse(reply, upsertLocalPromptSchema.partial(), req.body);
    if (!dto) return;
    if (dto.name) {
      const existing = await s.repos.localPrompts.getByName(dto.name);
      if (existing && existing.id !== id) {
        return sendError(reply, 409, 'name_taken', 'A prompt with that name already exists.');
      }
    }
    if (dto.template !== undefined) {
      try {
        renderTemplate(dto.template, {});
      } catch (err) {
        return sendError(reply, 400, 'invalid_template', err instanceof Error ? err.message : 'Invalid template.');
      }
    }
    const patch: Record<string, unknown> = { ...dto };
    if (dto.name) patch.slug = slugify(dto.name);
    await s.repos.localPrompts.update(id, patch);
    const lp = await s.repos.localPrompts.getById(id);
    if (!lp) return sendError(reply, 404, 'not_found', 'Prompt not found.');
    return { localPrompt: lp };
  });

  app.delete('/api/local-prompts/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    await s.repos.localPrompts.delete(id);
    return reply.code(204).send();
  });
}
