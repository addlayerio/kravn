import type { Logger } from 'pino';
import type { Repos } from '../db/repos.js';
import type { ChatService } from '../chat/chat.service.js';
import type { ChatAutomation } from '@kravn/contracts';
import { toAuthUser } from '../auth/auth.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import { newId } from '../crypto.js';

/** Whole-payload placeholder budget. Webhook bodies routinely run to tens of KB; pasting one raw burns tokens
 *  and buries the actual ask under boilerplate the agent doesn't need. */
const MAX_PAYLOAD_CHARS = 8_000;
/** Cap for a single `{{ field }}` substitution, so one giant description can't blow out the prompt either. */
const MAX_FIELD_CHARS = 2_000;

/**
 * Resolve a dot path against the payload: `data.title`, `changes.items.0.field` — any shape a sender emits.
 * Returns undefined for anything missing — a template that references a field the sender didn't send
 * renders as empty rather than throwing a delivery away.
 */
export function resolvePath(payload: unknown, path: string): unknown {
  const parts = path.split('.').map((p) => p.trim()).filter(Boolean);
  let cur: unknown = payload;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(part);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Stringify a resolved value for prompt interpolation: scalars as-is, objects as compact JSON, both capped. */
function stringifyValue(v: unknown, max = MAX_FIELD_CHARS): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? safeJson(v) : String(v);
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? '';
  } catch {
    return '[unserializable payload]';
  }
}

/**
 * Build the run's prompt. With a template, `{{ path }}` placeholders resolve against the payload
 * (`{{ payload }}` = the whole body). Without one, the automation's own prompt is used and the payload is
 * appended verbatim — so an event automation works before anyone writes a template.
 */
export function renderPrompt(automation: ChatAutomation, payload: unknown): string {
  const tpl = (automation.payloadTemplate ?? '').trim();
  if (!tpl) {
    if (payload === undefined) return automation.prompt;
    return `${automation.prompt}\n\n--- Event payload ---\n${stringifyValue(payload, MAX_PAYLOAD_CHARS)}`;
  }
  const rendered = tpl.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_m: string, path: string) => {
    if (path === 'payload') return stringifyValue(payload, MAX_PAYLOAD_CHARS);
    return stringifyValue(resolvePath(payload, path));
  });
  // The template describes the event; the automation's prompt is still the instruction of what to DO with it.
  return automation.prompt.trim() ? `${automation.prompt}\n\n${rendered}` : rendered;
}

export interface FilterResult {
  matched: boolean;
  /** The first condition that failed — surfaced by the dry-run so "why didn't it fire" is answerable. */
  failed?: string;
}

/**
 * Evaluate the automation's filter: one `path=value` (or `path!=value`) condition per line. An empty filter
 * matches everything. Comparison is case-insensitive string equality on the trimmed values — enough to gate on
 * an event type or a status without dragging in an expression language.
 *
 * **The same field repeated is OR; different fields are AND.** A field holds one value at a time, so
 * AND-ing two `=` conditions on the same path could never match — anyone writing
 *
 *     webhookEvent=jira:issue_created
 *     webhookEvent=jira:issue_updated
 *     issue.fields.project.key=CO
 *
 * plainly means "created *or* updated, and from project CO", and that is what it does. Several values may also
 * be written on one line with `|`, which is exactly the form a failure is reported in, so a reported condition
 * can be pasted straight back into the box.
 *
 * `!=` stays AND throughout: `path!=a` plus `path!=b` means "neither", which is both satisfiable and the
 * obvious reading.
 */
export function evaluateFilter(filter: string, payload: unknown): FilterResult {
  const lines = (filter ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const allowed = new Map<string, string[]>(); // path -> any-of values
  const denied: { path: string; value: string; line: string }[] = [];

  for (const line of lines) {
    const neg = line.includes('!=');
    const idx = neg ? line.indexOf('!=') : line.indexOf('=');
    // Malformed → fail closed, never fire on a broken gate. The message names the line AND the expected shape:
    // the reflex when a filter needs more power is to reach for `OR` or a boolean expression, and the reply to
    // that has to be legible, not a bare echo of the word that didn't parse.
    if (idx <= 0) return { matched: false, failed: `${line} — not a condition (expected field=value)` };
    const path = line.slice(0, idx).trim();
    const values = line.slice(idx + (neg ? 2 : 1)).split('|').map((v) => v.trim()).filter(Boolean);
    if (!values.length) return { matched: false, failed: `${line} — no value to compare against` };
    if (neg) {
      for (const value of values) denied.push({ path, value, line });
    } else {
      allowed.set(path, [...(allowed.get(path) ?? []), ...values]);
    }
  }

  const read = (path: string) => stringifyValue(resolvePath(payload, path)).trim().toLowerCase();
  // Positives first: "it wasn't the event I asked for" is the failure people hit, so it's the one worth naming.
  for (const [path, values] of allowed) {
    const actual = read(path);
    if (!values.some((v) => v.toLowerCase() === actual)) {
      return { matched: false, failed: `${path}=${values.join('|')}` };
    }
  }
  for (const { path, value, line } of denied) {
    if (read(path) === value.toLowerCase()) return { matched: false, failed: line };
  }
  return { matched: true };
}

/**
 * Runs an automation: opens a conversation owned by the automation's creator, with that user's role and team
 * access, and sends the rendered prompt. Shared by every trigger — the clock, an inbound webhook, or a person
 * pressing Run — so all three produce the same governed, audited artifact: a conversation.
 */
export class AutomationRunner {
  constructor(private d: { repos: Repos; chat: ChatService; log: Logger }) {}

  /**
   * Execute one run end-to-end and record it in the run history.
   *
   * Never throws: a trigger has no caller to report to (the webhook sender is long gone), so a failure is
   * recorded on the run row and on the automation, and swallowed. `trigger` is what started it.
   */
  async run(automation: ChatAutomation, userId: string, trigger: string, payload?: unknown): Promise<{ runId: string; conversationId: string | null; ok: boolean }> {
    const runId = newId();
    await this.d.repos.automations.startRun(runId, automation.id, userId, trigger);
    // Held outside the try so a FAILED run still records which conversation it opened. The failing run is the
    // one worth opening — it holds the prompt and whatever the agent managed to do before it broke — and a
    // conversation with no run pointing at it would also be invisible to the Chats-list filter.
    let conversationId: string | null = null;
    try {
      const actor = await this.resolveOwner(userId);
      conversationId = await this.openConversation(automation, actor, trigger);
      // `automated` keeps this turn from adopting the conversation: the runner sends AS the owner, so the flag
      // is the only thing separating the machine's own message from the person later replying to it.
      await this.d.chat.send(actor, conversationId, renderPrompt(automation, payload), [], undefined, { automated: true });
      await this.d.repos.automations.finishRun(runId, 'ok', null, conversationId);
      await this.d.repos.automations.finish(automation.id, 'ok', null, conversationId);
      return { runId, conversationId, ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.d.repos.automations.finishRun(runId, 'error', msg.slice(0, 500), conversationId);
      await this.d.repos.automations.finish(automation.id, 'error', msg.slice(0, 500), conversationId);
      this.d.log.warn({ err, automation: automation.id, trigger }, 'automation run failed');
      return { runId, conversationId, ok: false };
    }
  }

  /** The automation runs as its creator — their role and teams are the ceiling on everything it can reach. */
  private async resolveOwner(userId: string): Promise<AuthUser> {
    const user = await this.d.repos.users.getById(userId);
    if (!user) throw new Error('Automation owner no longer exists.');
    if (user.disabled) throw new Error('Automation owner is disabled.');
    const teams = await this.d.repos.teams.teamIdsForUser(user.id);
    return toAuthUser(user, teams);
  }

  private async openConversation(automation: ChatAutomation, actor: AuthUser, trigger: string): Promise<string> {
    const convId = newId();
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const icon = trigger === 'event' ? '⚡' : '⏱';
    await this.d.repos.chat.createConversation(actor.id, {
      id: convId,
      projectId: automation.projectId || null,
      title: `${icon} ${automation.name} · ${stamp}`,
      providerId: automation.providerId,
      model: automation.model,
      vserverSlug: automation.vserverSlug || '',
      // Run as the org Agent if one was chosen — its instructions + tool filter apply, re-checked live in send().
      agentId: automation.agentId || null,
      // Files this conversation under the automation rather than the user's Chats. Cleared if they reply in it.
      automationId: automation.id,
    });
    return convId;
  }
}
