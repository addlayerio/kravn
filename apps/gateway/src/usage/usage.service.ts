import type { Logger } from 'pino';
import type { Repos, UsageRow } from '../db/repos.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { Metrics } from '../metrics.js';
import type { AuditService } from '../audit/audit.service.js';

export interface UsageDeps {
  repos: Repos;
  settings: SettingsService;
  metrics: Metrics;
  audit: AuditService;
  log: Logger;
}

/** Thrown to block a call when a budget is exceeded and the action is `block`. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

const utcDay = (): string => new Date().toISOString().slice(0, 10);

/**
 * Cost / quota governance. Meters tool calls and LLM tokens into per-period usage counters (global + user +
 * endpoint + model, for chargeback), and enforces org-wide daily budgets. Metering is best-effort — it must
 * never break a call; enforcement is a pre-flight check that can block when configured to.
 */
export class UsageService {
  constructor(private readonly d: UsageDeps) {}

  /** Meter one proxied tool call against global + user + endpoint scopes. */
  async meterToolCall(actor?: { id: string } | null, mcpEndpointId?: string): Promise<void> {
    const day = utcDay();
    const w: Promise<unknown>[] = [this.d.repos.usage.add(day, 'global', '', 1, 0, 0)];
    if (actor?.id) w.push(this.d.repos.usage.add(day, 'user', actor.id, 1, 0, 0));
    if (mcpEndpointId) w.push(this.d.repos.usage.add(day, 'endpoint', mcpEndpointId, 1, 0, 0));
    await Promise.allSettled(w);
  }

  /** Meter LLM tokens against global + user + model scopes (and Prometheus). */
  async meterTokens(actor: { id: string } | undefined, model: string, inTok: number, outTok: number): Promise<void> {
    if (inTok <= 0 && outTok <= 0) return;
    const day = utcDay();
    if (inTok > 0) this.d.metrics.llmTokens.inc({ kind: 'input', model }, inTok);
    if (outTok > 0) this.d.metrics.llmTokens.inc({ kind: 'output', model }, outTok);
    const w: Promise<unknown>[] = [this.d.repos.usage.add(day, 'global', '', 0, inTok, outTok)];
    if (actor?.id) w.push(this.d.repos.usage.add(day, 'user', actor.id, 0, inTok, outTok));
    if (model) w.push(this.d.repos.usage.add(day, 'model', model.slice(0, 64), 0, inTok, outTok));
    await Promise.allSettled(w);
  }

  /** Pre-flight: enforce the org-wide daily tool-call budget (0 = off). */
  async assertCallBudget(): Promise<void> {
    const g = this.d.settings.get().governance;
    const budget = g?.dailyCallBudget ?? 0;
    if (budget <= 0) return;
    const row = await this.d.repos.usage.get(utcDay(), 'global', '').catch(() => undefined);
    if ((row?.calls ?? 0) >= budget) this.enforce('calls', g.budgetAction, `Daily tool-call budget of ${budget} reached.`);
  }

  /** Pre-flight: enforce the org-wide daily LLM-token budget (0 = off). */
  async assertTokenBudget(): Promise<void> {
    const g = this.d.settings.get().governance;
    const budget = g?.dailyTokenBudget ?? 0;
    if (budget <= 0) return;
    const row = await this.d.repos.usage.get(utcDay(), 'global', '').catch(() => undefined);
    const used = (row?.inputTokens ?? 0) + (row?.outputTokens ?? 0);
    if (used >= budget) this.enforce('tokens', g.budgetAction, `Daily LLM token budget of ${budget} reached.`);
  }

  private enforce(kind: 'calls' | 'tokens', action: 'warn' | 'block', message: string): void {
    this.d.metrics.budgetBlocks.inc({ kind, action });
    this.d.audit
      .record({ category: 'system', action: 'governance.budget_exceeded', outcome: action === 'block' ? 'failure' : 'success', details: { kind, action, message } })
      .catch(() => {});
    if (action === 'block') throw new BudgetExceededError(message);
    this.d.log.warn({ kind, message }, 'cost budget exceeded (warn mode — not blocking)');
  }

  /** Today's usage counters, for the admin report — with user/endpoint ids resolved to human-readable names
   *  (user email, endpoint name) so the Governance table shows who/what, not an opaque id. Best-effort: a
   *  deleted user/endpoint (or a model row, whose id is already its name) just leaves `name` undefined. */
  async report(): Promise<Array<UsageRow & { name?: string }>> {
    const rows = await this.d.repos.usage.list(utcDay());
    const userIds = [...new Set(rows.filter((r) => r.scopeType === 'user').map((r) => r.scopeId))];
    const epIds = [...new Set(rows.filter((r) => r.scopeType === 'endpoint').map((r) => r.scopeId))];
    const [users, eps] = await Promise.all([
      Promise.all(userIds.map(async (id) => [id, await this.d.repos.users.getById(id).catch(() => undefined)] as const)),
      Promise.all(epIds.map(async (id) => [id, await this.d.repos.mcpEndpoints.getById(id).catch(() => undefined)] as const)),
    ]);
    const userName = new Map(users.map(([id, u]) => [id, u ? u.email || u.name : undefined]));
    const epName = new Map(eps.map(([id, e]) => [id, e?.name]));
    return rows.map((r) => ({
      ...r,
      name: r.scopeType === 'user' ? userName.get(r.scopeId) : r.scopeType === 'endpoint' ? epName.get(r.scopeId) : undefined,
    }));
  }
}
