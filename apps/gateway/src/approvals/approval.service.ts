import type { Logger } from 'pino';
import type { Repos, ToolApproval } from '../db/repos.js';
import type { AuditService } from '../audit/audit.service.js';
import type { EventBus } from '../events/bus.js';
import type { AuthUser } from '../auth/auth.service.js';
import { newId } from '../crypto.js';

export interface ApprovalDeps {
  repos: Repos;
  audit: AuditService;
  events: EventBus;
  log: Logger;
}

const POLL_MS = 1500;

/**
 * Human-in-the-loop maker-checker for tool calls. A held call (from the approval-gate hook) is persisted as a
 * pending row and the caller blocks in {@link waitFor} until an admin decides or it times out. The DB is the
 * source of truth so it works across replicas; an in-process waiter map is a same-process fast-path wakeup.
 */
export class ApprovalService {
  private readonly waiters = new Map<string, () => void>();

  constructor(private readonly d: ApprovalDeps) {}

  /** Create a pending approval for a held call and return its id. Throws if it can't be persisted. */
  async request(input: {
    serverId: string;
    toolName: string;
    mcpEndpointId?: string;
    actor?: Pick<AuthUser, 'id' | 'email'>;
    argsPreview: string;
  }): Promise<string> {
    const id = newId();
    const server = await this.d.repos.servers.getById(input.serverId).catch(() => undefined);
    await this.d.repos.toolApprovals.create({
      id,
      serverId: input.serverId,
      serverName: server?.name ?? input.serverId,
      toolName: input.toolName,
      mcpEndpointId: input.mcpEndpointId ?? null,
      actorId: input.actor?.id ?? null,
      actorEmail: input.actor?.email ?? null,
      argsPreview: input.argsPreview.slice(0, 4000),
      ts: new Date().toISOString(),
    });
    this.d.events.fire('approvals');
    this.d.log.info({ id, tool: input.toolName, actor: input.actor?.email }, 'tool call held for human approval');
    return id;
  }

  /** Block until the approval is resolved or the timeout elapses; returns the terminal row. */
  async waitFor(id: string, timeoutMs: number): Promise<ToolApproval> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await this.d.repos.toolApprovals.get(id);
      if (!row) {
        // The row vanished (shouldn't happen) — treat as expired so the caller fails closed.
        return { id, serverId: '', serverName: '', toolName: '', mcpEndpointId: null, actorId: null, actorEmail: null, argsPreview: '', status: 'expired', reason: 'lost', resolvedBy: null, createdAt: '', resolvedAt: null };
      }
      if (row.status !== 'pending') return row;
      if (Date.now() >= deadline) {
        await this.d.repos.toolApprovals.resolve(id, 'expired', 'system', 'Timed out waiting for approval', new Date().toISOString());
        // resolve() is a no-op if a decision won the race with the timeout — re-read and honor it if so.
        const fresh = await this.d.repos.toolApprovals.get(id);
        this.d.events.fire('approvals');
        if (fresh && fresh.status !== 'pending' && fresh.status !== 'expired') return fresh;
        return { ...row, status: 'expired', reason: 'Timed out waiting for approval', resolvedBy: 'system' };
      }
      await this.sleepOrWake(id, Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  /** Sleep up to `ms`, or resolve early if a same-process decision wakes this id. */
  private sleepOrWake(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const to = setTimeout(() => {
        this.waiters.delete(id);
        resolve();
      }, ms);
      this.waiters.set(id, () => {
        clearTimeout(to);
        this.waiters.delete(id);
        resolve();
      });
    });
  }

  /** Admin approves or denies a pending request. */
  async decide(id: string, approve: boolean, actor: AuthUser, reason: string): Promise<ToolApproval> {
    const row = await this.d.repos.toolApprovals.get(id);
    if (!row) throw new Error('Approval request not found.');
    if (row.status !== 'pending') throw new Error(`This request was already ${row.status}.`);
    // Separation of duties: the requester may not approve their own call (a denial by anyone is always allowed).
    if (approve && row.actorId && row.actorId === actor.id) {
      throw new Error('You cannot approve your own request (separation of duties).');
    }
    const status = approve ? 'approved' : 'denied';
    const ts = new Date().toISOString();
    await this.d.repos.toolApprovals.resolve(id, status, actor.email, reason, ts);
    this.waiters.get(id)?.(); // wake a held call in THIS process immediately (other replicas poll)
    this.d.events.fire('approvals');
    await this.d.audit
      .record({
        category: 'access',
        action: `mcp.tool.approval_${status}`,
        actor: { id: actor.id, email: actor.email, role: actor.role },
        resourceType: 'tool',
        resourceId: row.toolName,
        details: { approvalId: id, server: row.serverName, tool: row.toolName, requestedBy: row.actorEmail, mcpEndpointId: row.mcpEndpointId, reason },
      })
      .catch(() => {});
    return { ...row, status, resolvedBy: actor.email, reason, resolvedAt: ts };
  }

  listPending(): Promise<ToolApproval[]> {
    return this.d.repos.toolApprovals.listPending();
  }
}
