import type { FastifyInstance } from 'fastify';
import { updatePipelineSchema, pipelineTraceSchema } from '@kravn/contracts';
import type { Services } from '../services.js';
import { parse, sendError } from './_helpers.js';

/**
 * Hook pipelines: compose, per MCP lifecycle junction, the ordered chain of hook plugins that runs there —
 * for the GLOBAL base (`scope=global`, runs for all traffic) or a per-mcp-endpoint OVERLAY (`scope=<vsId>`,
 * runs only for calls routed through that VS, after the global base). Read = settings.read; mutate/trace =
 * settings.write (same admin gate as the Plugins screen). Ordering affects deny/auth hooks, so writes are
 * admin-only; the manager validates the scope + hook point before any DB/exec use.
 */
export function pipelineRoutes(app: FastifyInstance, s: Services): void {
  const read = { preHandler: [app.authenticate, app.authorize('settings.read')] };
  const write = { preHandler: [app.authenticate, app.authorize('settings.write')] };

  app.get('/api/pipeline', read, async (req) => {
    const scope = (req.query as { scope?: string })?.scope || 'global';
    return s.plugins.pipelineView(scope);
  });

  app.put('/api/pipeline/:scope/:hookPoint', write, async (req, reply) => {
    const { scope, hookPoint } = req.params as { scope: string; hookPoint: string };
    const dto = parse(reply, updatePipelineSchema, req.body);
    if (!dto) return;
    try {
      await s.plugins.setPipeline(scope, hookPoint, dto.steps);
      return s.plugins.pipelineView(scope);
    } catch (err) {
      return sendError(reply, 400, 'pipeline_update_failed', err instanceof Error ? err.message : 'Could not update pipeline.');
    }
  });

  app.post('/api/pipeline/:scope/:hookPoint/trace', write, async (req, reply) => {
    const { scope, hookPoint } = req.params as { scope: string; hookPoint: string };
    const dto = parse(reply, pipelineTraceSchema, req.body);
    if (!dto) return;
    try {
      return await s.plugins.trace(scope, hookPoint, dto.payload, { server: dto.server, tool: dto.tool });
    } catch (err) {
      return sendError(reply, 400, 'pipeline_trace_failed', err instanceof Error ? err.message : 'Trace failed.');
    }
  });
}
