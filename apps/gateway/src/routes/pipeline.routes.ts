import type { FastifyInstance } from 'fastify';
import { updatePipelineSchema, pipelineTraceSchema } from '@kravn/contracts';
import type { Services } from '../services.js';
import { parse, sendError } from './_helpers.js';

/**
 * Hook pipelines: compose, per MCP lifecycle junction, the ordered chain of hook plugins that runs there.
 * Read = settings.read; mutate/trace = settings.write (same gate as the Plugins screen). Ordering affects
 * security-relevant hooks (deny / auth resolve), so writes are admin-only.
 */
export function pipelineRoutes(app: FastifyInstance, s: Services): void {
  const read = { preHandler: [app.authenticate, app.authorize('settings.read')] };
  const write = { preHandler: [app.authenticate, app.authorize('settings.write')] };

  app.get('/api/pipeline', read, async () => s.plugins.pipelineView());

  app.put('/api/pipeline/:hookPoint', write, async (req, reply) => {
    const { hookPoint } = req.params as { hookPoint: string };
    const dto = parse(reply, updatePipelineSchema, req.body);
    if (!dto) return;
    try {
      await s.plugins.setPipeline(hookPoint, dto.steps);
      return s.plugins.pipelineView();
    } catch (err) {
      return sendError(reply, 400, 'pipeline_update_failed', err instanceof Error ? err.message : 'Could not update pipeline.');
    }
  });

  app.post('/api/pipeline/:hookPoint/trace', write, async (req, reply) => {
    const { hookPoint } = req.params as { hookPoint: string };
    const dto = parse(reply, pipelineTraceSchema, req.body);
    if (!dto) return;
    try {
      return await s.plugins.trace(hookPoint, dto.payload, { server: dto.server, tool: dto.tool });
    } catch (err) {
      return sendError(reply, 400, 'pipeline_trace_failed', err instanceof Error ? err.message : 'Trace failed.');
    }
  });
}
