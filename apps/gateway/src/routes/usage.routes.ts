import type { FastifyInstance } from 'fastify';
import type { Services } from '../services.js';

/** Cost / quota governance report — today's usage counters plus the configured budgets. */
export function usageRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/usage', { preHandler: [app.authenticate, app.authorize('settings.read')] }, async () => {
    const g = s.settings.get().governance;
    return {
      usage: await s.usage.report(),
      budgets: { dailyTokenBudget: g.dailyTokenBudget, dailyCallBudget: g.dailyCallBudget, budgetAction: g.budgetAction },
    };
  });
}
