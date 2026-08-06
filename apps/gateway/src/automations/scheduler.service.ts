import parser from 'cron-parser';
import type { Logger } from 'pino';
import type { Repos } from '../db/repos.js';
import type { SharedStore } from '../cluster/shared-store.js';
import type { ChatAutomation } from '@kravn/contracts';
import type { AutomationRunner } from './runner.service.js';

/**
 * Next fire time for a time-triggered automation, or null = "will never run again".
 * - once:  the runAt instant, but only while it's in the future (so it fires exactly once).
 * - cron:  the next occurrence after `from`, in the automation's timezone. Invalid cron → null.
 * - event: never fires by the clock — its trigger is an inbound webhook, so the scheduler skips it.
 */
export function computeNextRun(kind: string, cron: string, runAt: string, timezone: string, from: Date): string | null {
  if (kind === 'event') return null;
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
 * The **time** trigger for automations. Every replica ticks, but each due fire is CLAIMED via the shared store
 * (`incr` returns 1 to exactly one replica), so an automation runs once even behind N pods. A slow run can't
 * double-fire: the next_run_at is advanced BEFORE the run starts.
 *
 * Executing the run is the AutomationRunner's job — the same code path an inbound webhook takes.
 */
export class SchedulerService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private d: { repos: Repos; sharedStore: SharedStore; runner: AutomationRunner; log: Logger },
  ) {}

  start(intervalMs = 30_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    this.d.log.info('automation scheduler started');
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // never overlap ticks
    this.ticking = true;
    try {
      const nowD = new Date();
      const due = await this.d.repos.automations.due(nowD.toISOString());
      for (const a of due) {
        // Atomic claim: only the replica that gets count===1 runs THIS fire (keyed by the exact due time).
        const { count } = await this.d.sharedStore.incr(`sched:${a.id}:${a.nextRunAt}`, 300);
        if (count !== 1) continue;
        await this.runOne(a, nowD);
      }
    } catch (err) {
      this.d.log.warn({ err }, 'scheduler tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private async runOne(a: ChatAutomation & { userId: string }, nowD: Date): Promise<void> {
    // Advance the next fire time FIRST so a slow run can't be re-claimed on the following tick.
    const next = computeNextRun(a.kind, a.cron, a.runAt, a.timezone, nowD);
    await this.d.repos.automations.advance(a.id, next, nowD.toISOString());
    await this.d.runner.run(a, a.userId, a.kind); // records its own outcome; never throws
  }
}
