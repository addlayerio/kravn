import type { McpEndpoint } from '@kravn/contracts';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * DATA-PLANE authorization: may this identity CONSUME this MCP endpoint (virtual server)?
 *
 * This is deliberately independent of the CONTROL-PLANE (who may configure Kravn — the `admin` role /
 * Platform Administrator Team). Being a platform admin does NOT, by itself, grant consumption; an admin
 * consumes an endpoint the same way anyone does — because it's open, or because they're a member of a team
 * it's granted to. So one identity can be both a Kravn admin AND an MCP consumer, but the two are separate
 * axes. The baseline "is a consumer at all" capability is the `mcp.invoke` permission (checked by the caller);
 * this function decides WHICH endpoints, by team membership only.
 *
 *   public        -> anyone (caller doesn't even authenticate)
 *   authenticated -> any signed-in consumer
 *   restricted    -> only members of a team in `allowedTeams` (platform role is NOT an axis here)
 */
export function canConsumeMcpEndpoint(vs: Pick<McpEndpoint, 'access' | 'allowedTeams'>, user: Pick<AuthUser, 'teams'>): boolean {
  if (vs.access === 'public' || vs.access === 'authenticated') return true;
  return vs.allowedTeams.some((t) => user.teams.includes(t));
}
