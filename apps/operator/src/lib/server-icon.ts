import { MCP_SERVER_CATALOG } from '@kravn/contracts';

/**
 * Best-effort brand-icon id for an upstream server (a key into BRAND_ICONS / IntegrationIcon `id`).
 *
 * - Native plugin servers are registry rows with id `plg_<pluginId>` (e.g. `plg_kravn-jira`) and
 *   `transport: 'plugin'` — strip the prefix to get the plugin id, which is itself a BRAND_ICONS key.
 * - Remote servers match by endpoint URL against the curated catalog.
 * Returns undefined when no brand logo applies → IntegrationIcon falls back to a monogram.
 */
const catalogIdByUrl = new Map(MCP_SERVER_CATALOG.map((s) => [s.url, s.id]));

export function serverIconId(s: { id?: string; url?: string; transport?: string }): string | undefined {
  if (s.id && s.id.startsWith('plg_')) return s.id.slice(4);
  if (s.transport === 'plugin') return undefined;
  return (s.url && catalogIdByUrl.get(s.url)) || undefined;
}
