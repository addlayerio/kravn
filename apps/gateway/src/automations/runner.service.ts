import type { Logger } from 'pino';
import type { Repos } from '../db/repos.js';
import type { ChatService } from '../chat/chat.service.js';
import type { ChatAutomation } from '@kravn/contracts';
import { toAuthUser } from '../auth/auth.service.js';
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
 * Evaluate the automation's filter: one `path=value` (or `path!=value`) condition per line, ALL must hold.
 * An empty filter matches everything. Comparison is string equality on the trimmed values, case-insensitive —
 * enough to gate on an event type or a status without dragging in an expression language.
 */
export function evaluateFilter(filter: string, payload: unknown): FilterResult {
  const lines = (filter ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const line of lines) {
    const neg = line.includes('!=');
    const idx = neg ? line.indexOf('!=') : line.indexOf('=');
    if (idx <= 0) return { matched: false, failed: line }; // malformed → fail closed, never fire on a bad gate
    const path = line.slice(0, idx).trim();
    const expected = line.slice(idx + (neg ? 2 : 1)).trim();
    const actual = stringifyValue(resolvePath(payload, path)).trim();
    const equal = actual.toLowerCase() === expected.toLowerCase();
    if (neg ? equal : !equal) return { matched: false, failed: line };
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
    try {
      const conversationId = await this.execute(automation, userId, trigger, payload);
      await this.d.repos.automations.finishRun(runId, 'ok', null, conversationId);
      await this.d.repos.automations.finish(automation.id, 'ok', null, conversationId);
      return { runId, conversationId, ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.d.repos.automations.finishRun(runId, 'error', msg.slice(0, 500), null);
      await this.d.repos.automations.finish(automation.id, 'error', msg.slice(0, 500), null);
      this.d.log.warn({ err, automation: automation.id, trigger }, 'automation run failed');
      return { runId, conversationId: null, ok: false };
    }
  }

  private async execute(automation: ChatAutomation, userId: string, trigger: string, payload: unknown): Promise<string> {
    const user = await this.d.repos.users.getById(userId);
    if (!user) throw new Error('Automation owner no longer exists.');
    if (user.disabled) throw new Error('Automation owner is disabled.');
    const teams = await this.d.repos.teams.teamIdsForUser(user.id);
    const actor = toAuthUser(user, teams); // run with the owner's role + team access
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
    });
    await this.d.chat.send(actor, convId, renderPrompt(automation, payload));
    return convId;
  }
}
