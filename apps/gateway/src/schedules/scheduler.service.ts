import parser from 'cron-parser';
import type { Logger } from 'pino';
import type { Repos } from '../db/repos.js';
import type { SharedStore } from '../cluster/shared-store.js';
import type { ChatService } from '../chat/chat.service.js';
import type { ChatSchedule } from '@kravn/contracts';
import { toAuthUser } from '../auth/auth.service.js';
import { newId } from '../crypto.js';

/**
 * Next fire time for a schedule, or null = "will never run again".
 * - once: the runAt instant, but only while it's in the future (so it fires exactly once).
 * - cron: the next occurrence after `from`, in the schedule's timezone. Invalid cron → null.
 */
export function computeNextRun(kind: string, cron: string, runAt: string, timezone: string, from: Date): string | null {
  const tz = timezone || 'UTC';
  if (kind === 'once') {
    const t = new Date(runAt);
    if (isNaN(t.getTime())) return null;
    return t > from ? t.toISOString() : null;
  }
  try {
    const it = parser.parseExpression(cron, { currentDate: from, tz });
    return it.next().toDate().toISOString();
  } catch {
    return null;
  }
}

/**
 * Runs scheduled tasks. Every replica ticks, but each due fire is CLAIMED via the shared store
 * (`incr` returns 1 to exactly one replica), so a task runs once even behind N pods. A slow run can't
 * double-fire: the next_run_at is advanced BEFORE the prompt runs. The result lands in a new conversation
 * owned by the schedule's creator, with that user's tool/endpoint access.
 */
export class SchedulerService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private d: { repos: Repos; sharedStore: SharedStore; chat: ChatService; log: Logger },
  ) {}

  start(intervalMs = 30_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    this.d.log.info('scheduler started');
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // never overlap ticks
    this.ticking = true;
    try {
      const nowD = new Date();
      const due = await this.d.repos.schedules.due(nowD.toISOString());
      for (const s of due) {
        // Atomic claim: only the replica that gets count===1 runs THIS fire (keyed by the exact due time).
        const { count } = await this.d.sharedStore.incr(`sched:${s.id}:${s.nextRunAt}`, 300);
        if (count !== 1) continue;
        await this.runOne(s, nowD);
      }
    } catch (err) {
      this.d.log.warn({ err }, 'scheduler tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private async runOne(s: ChatSchedule & { userId: string }, nowD: Date): Promise<void> {
    // Advance the next fire time FIRST so a slow run can't be re-claimed on the following tick.
    const next = computeNextRun(s.kind, s.cron, s.runAt, s.timezone, nowD);
    await this.d.repos.schedules.advance(s.id, next, nowD.toISOString());
    try {
      const conversationId = await this.execute(s, nowD);
      await this.d.repos.schedules.finish(s.id, 'ok', null, conversationId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.d.repos.schedules.finish(s.id, 'error', msg.slice(0, 500), null);
      this.d.log.warn({ err, schedule: s.id }, 'scheduled task failed');
    }
  }

  private async execute(s: ChatSchedule & { userId: string }, nowD: Date): Promise<string> {
    const user = await this.d.repos.users.getById(s.userId);
    if (!user) throw new Error('Schedule owner no longer exists.');
    const teams = await this.d.repos.teams.teamIdsForUser(user.id);
    const actor = toAuthUser(user, teams); // run with the owner's role + team access
    const convId = newId();
    const stamp = nowD.toISOString().replace('T', ' ').slice(0, 16);
    await this.d.repos.chat.createConversation(actor.id, {
      id: convId,
      projectId: s.projectId || null,
      title: `⏱ ${s.name} · ${stamp}`,
      providerId: s.providerId,
      model: s.model,
      vserverSlug: s.vserverSlug || '',
    });
    await this.d.chat.send(actor, convId, s.prompt);
    return convId;
  }
}
