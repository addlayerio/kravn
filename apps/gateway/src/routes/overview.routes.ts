import type { FastifyInstance } from 'fastify';
import { KRAVN_VERSION, type PlatformOverview } from '@kravn/contracts';
import type { Services } from '../services.js';

/**
 * Aggregated platform state for the dashboard "Architecture Flow" panel — one call instead of five.
 * The DB queries double as a liveness probe: if they throw, the database is reported as not connected.
 */
export function overviewRoutes(app: FastifyInstance, s: Services): void {
  app.get('/api/overview', { preHandler: [app.authenticate] }, async (): Promise<PlatformOverview> => {
    let connected = true;
    let servers: Awaited<ReturnType<typeof s.repos.servers.list>> = [];
    let vservers: Awaited<ReturnType<typeof s.repos.virtualServers.list>> = [];
    let tools: Awaited<ReturnType<typeof s.repos.registry.listTools>> = [];
    let resources: Awaited<ReturnType<typeof s.repos.registry.listResources>> = [];
    let prompts: Awaited<ReturnType<typeof s.repos.registry.listPrompts>> = [];
    try {
      [servers, vservers, tools, resources, prompts] = await Promise.all([
        s.repos.servers.list(),
        s.repos.virtualServers.list(),
        s.repos.registry.listTools(),
        s.repos.registry.listResources(),
        s.repos.registry.listPrompts(),
      ]);
    } catch (err) {
      connected = false;
      s.log.warn({ err }, 'overview: database query failed');
    }

    const { plugins } = s.plugins.list();
    const hookCounts = new Map<string, number>();
    for (const p of plugins) {
      if (p.type === 'hook') for (const h of p.hookPoints ?? []) hookCounts.set(h, (hookCounts.get(h) ?? 0) + 1);
    }

    return {
      instanceName: s.settings.get().general.instanceName,
      version: KRAVN_VERSION,
      virtualServers: { total: vservers.length, active: vservers.filter((v) => v.enabled).length },
      plugins: {
        total: plugins.length,
        enabled: plugins.filter((p) => p.enabled).length,
        byHook: [...hookCounts.entries()].map(([hook, count]) => ({ hook, count })).sort((a, b) => b.count - a.count),
      },
      servers: { total: servers.length, online: servers.filter((x) => x.status === 'online').length },
      tools: { total: tools.length, enabled: tools.filter((t) => t.enabled).length },
      prompts: { total: prompts.length, enabled: prompts.filter((p) => p.enabled).length },
      resources: { total: resources.length, enabled: resources.filter((r) => r.enabled).length },
      database: { kind: s.env.db.kind, connected },
    };
  });
}
