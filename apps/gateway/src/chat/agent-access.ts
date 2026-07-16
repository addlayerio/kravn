import type { ChatAgent } from '@kravn/contracts';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * May this identity USE this org Agent to start a chat?
 *
 * Mirrors `canConsumeMcpEndpoint`: a use-grant, not a management-grant. Managing agents (create/edit/delete in
 * the operator) is a separate control-plane permission checked at the route; being a platform admin does NOT by
 * itself grant USE here. A disabled agent is never usable.
 *
 *   authenticated -> any signed-in user
 *   restricted    -> a member of a team in `allowedTeams`, OR a user in `allowedUsers` (platform role is NOT an axis)
 *
 * This never widens tool access: an Agent's toolIds are re-filtered against the caller's own live entitlement
 * at chat time (resolveProjectTools), so being able to USE an agent is not the same as being granted its tools.
 */
export function canUseAgent(agent: Pick<ChatAgent, 'access' | 'allowedTeams' | 'allowedUsers' | 'enabled'>, user: Pick<AuthUser, 'id' | 'teams'>): boolean {
  if (!agent.enabled) return false;
  if (agent.access === 'authenticated') return true;
  return agent.allowedUsers.includes(user.id) || agent.allowedTeams.some((t) => user.teams.includes(t));
}
