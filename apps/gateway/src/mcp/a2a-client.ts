import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  type AgentCard,
  type A2aAgentSkill,
  type A2aArtifact,
  type A2aMessage,
  type A2aPart,
  type A2aTask,
  type A2aTaskState,
  isStoppedTaskState,
  isTerminalTaskState,
} from '@kravn/contracts';

/**
 * A2A CLIENT — Kravn acting as an Agent2Agent client. A remote A2A agent is an upstream `Server` with
 * `transport: 'a2a'`; this module returns a `ClientLike` (the same minimal surface the MCP SDK client
 * and plugin shims satisfy) so the registry can bridge the remote agent's skills into the tool catalog
 * with zero changes to sync/invoke/audit/entitlement.
 *
 * The mapping is intentionally a "blocking collapse": each A2A skill becomes one tool that takes a
 * `message` string; a call sends `message/send` and polls the task to a terminal (or paused) state,
 * returning the final artifacts as an MCP tool result. The async 8-state lifecycle can't round-trip
 * through a single one-shot tools/call, so multi-turn `input-required` / `auth-required` are surfaced
 * as a note rather than continued — the Kravn A2A SERVER direction is where the full lifecycle lives.
 */

/** Minimal surface consumed by UpstreamManager — must mirror ClientLike in upstream.ts. */
export interface A2aClientLike {
  listTools(): Promise<{ tools: Array<{ name: string; description: string; inputSchema: unknown }> }>;
  listResources(): Promise<{ resources: never[] }>;
  listPrompts(): Promise<{ prompts: never[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<McpToolResultLike>;
  readResource(params: { uri: string }): Promise<never>;
  getPrompt(params: { name: string; arguments: Record<string, string> }): Promise<never>;
  close(): Promise<void>;
}

interface McpToolResultLike {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type Dispatcher = import('undici').Dispatcher;

const POLL_INTERVAL_MS = 1000;
const CARD_FETCH_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** undici's global fetch honors `dispatcher` on the RequestInit even though the DOM type omits it. */
function withDispatcher(init: RequestInit, dispatcher?: Dispatcher): RequestInit {
  if (dispatcher) (init as { dispatcher?: unknown }).dispatcher = dispatcher;
  return init;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Text projection of A2A parts for an MCP tool result. */
function partsToText(parts: A2aPart[] | undefined): string {
  if (!parts?.length) return '';
  const out: string[] = [];
  for (const p of parts) {
    if (p.kind === 'text') out.push(p.text);
    else if (p.kind === 'data') out.push(JSON.stringify(p.data));
    else if (p.kind === 'file') out.push(`[file: ${p.file?.name ?? p.file?.uri ?? 'attachment'}]`);
  }
  return out.join('\n').trim();
}

function artifactsToText(artifacts: A2aArtifact[] | undefined): string {
  if (!artifacts?.length) return '';
  return artifacts
    .map((a) => partsToText(a.parts))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function result(text: string, isError = false): McpToolResultLike {
  return { content: [{ type: 'text', text: text || '(no content returned)' }], isError };
}

function taskToResult(task: A2aTask): McpToolResultLike {
  const state = task.status?.state ?? 'unknown';
  const statusText = partsToText(task.status?.message?.parts);
  const artifacts = artifactsToText(task.artifacts);
  const body = [artifacts, statusText].filter(Boolean).join('\n\n').trim();

  if (state === 'completed') return result(body);
  if (state === 'failed' || state === 'rejected' || state === 'canceled') {
    return result(body || `The remote agent task ${state}.`, true);
  }
  if (state === 'input-required' || state === 'auth-required') {
    const note =
      state === 'auth-required'
        ? 'The remote agent needs authentication to continue.'
        : 'The remote agent needs more input to continue.';
    return result(
      `${body ? body + '\n\n' : ''}[${note} Multi-turn A2A delegation is not available through the tool bridge — task ${task.id}.]`,
    );
  }
  // Still running when our budget ran out.
  return result(
    `${body ? body + '\n\n' : ''}[The remote agent task is still running (${state}) — task ${task.id}. Try again shortly.]`,
  );
}

/** Build the inputSchema for a bridged skill: a single `message` string. */
function skillInputSchema(skill: A2aAgentSkill): unknown {
  const examples = skill.examples?.length ? ` Examples: ${skill.examples.slice(0, 3).join(' · ')}` : '';
  return {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: `Task or prompt to delegate to the "${skill.name}" skill.${examples}`.trim(),
      },
    },
    required: ['message'],
  };
}

/** A stable, MCP-safe tool name for a skill. */
function toolNameForSkill(skill: A2aAgentSkill, taken: Set<string>): string {
  const base = (skill.id || skill.name || 'skill')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96) || 'skill';
  let name = base;
  let i = 2;
  while (taken.has(name)) name = `${base}_${i++}`;
  taken.add(name);
  return name;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  dispatcher: Dispatcher | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, withDispatcher({ ...init, signal: ctl.signal }, dispatcher));
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

function looksLikeCard(v: unknown): v is AgentCard {
  return !!v && typeof v === 'object' && ('skills' in v || 'protocolVersion' in v || 'url' in v);
}

/** Resolve + fetch the remote Agent Card, tolerating either a base URL or a direct card URL. */
async function fetchAgentCard(
  rawUrl: string,
  headers: Record<string, string>,
  dispatcher: Dispatcher | undefined,
): Promise<AgentCard> {
  const candidates = rawUrl.endsWith('.json')
    ? [rawUrl]
    : [joinUrl(rawUrl, '.well-known/agent-card.json'), joinUrl(rawUrl, '.well-known/agent.json'), rawUrl];
  let lastErr: unknown;
  for (const url of candidates) {
    try {
      const json = await fetchJson(url, { method: 'GET', headers }, dispatcher, CARD_FETCH_TIMEOUT_MS);
      if (looksLikeCard(json)) return json;
      lastErr = new Error(`Response from ${url} is not an A2A Agent Card`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Could not fetch an A2A Agent Card from ${rawUrl}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/**
 * Connect to a remote A2A agent: fetch its Agent Card and return a ClientLike whose tools are the
 * agent's skills. All outbound HTTP flows through the SSRF/TLS `dispatcher`.
 */
export async function connectA2a(
  agentBaseUrl: string,
  headers: Record<string, string>,
  dispatcher: Dispatcher | undefined,
  timeoutMs: () => number,
  log: Logger,
): Promise<A2aClientLike> {
  const card = await fetchAgentCard(agentBaseUrl, headers, dispatcher);
  // The card advertises its own JSON-RPC service URL. Only follow it when it shares the agent's ORIGIN —
  // otherwise a tampered/cached card could redirect our CREDENTIALED requests (the operator-provisioned
  // Authorization header) to an attacker-chosen host, leaking the credential. Cross-origin → use the base.
  const sameOrigin = ((): boolean => {
    try {
      const a = new URL(agentBaseUrl);
      const c = new URL(card.url);
      return a.protocol === c.protocol && a.host === c.host;
    } catch {
      return false;
    }
  })();
  const rpcUrl = card.url && /^https?:\/\//.test(card.url) && sameOrigin ? card.url : agentBaseUrl;
  if (card.url && !sameOrigin) {
    log.warn({ agent: card.name, cardUrl: card.url, agentBaseUrl }, 'A2A card.url is cross-origin — ignoring it and using the registered URL');
  }

  const skills = Array.isArray(card.skills) ? card.skills : [];
  const taken = new Set<string>();
  const byToolName = new Map<string, A2aAgentSkill>();
  const toolDefs = skills.map((skill) => {
    const name = toolNameForSkill(skill, taken);
    byToolName.set(name, skill);
    const desc = [skill.name, skill.description].filter(Boolean).join(' — ');
    return { name, description: desc || name, inputSchema: skillInputSchema(skill) };
  });

  log.info(
    { agent: card.name, rpcUrl, skills: toolDefs.length },
    'connected to remote A2A agent (skills bridged as tools)',
  );

  let rpcId = 0;
  async function rpc(method: string, params: unknown): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
    const json = (await fetchJson(
      rpcUrl,
      { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body },
      dispatcher,
      timeoutMs(),
    )) as { result?: unknown; error?: { code: number; message: string } };
    if (json.error) throw new Error(`A2A ${method} error ${json.error.code}: ${json.error.message}`);
    return json.result;
  }

  async function callSkill(toolName: string, args: Record<string, unknown>): Promise<McpToolResultLike> {
    // Anchor the poll budget to BEFORE the send so send latency is charged against the same clock the
    // UpstreamManager's withTimeout uses; the buffer must exceed one poll cycle so the last sleep+tasks/get
    // completes and the graceful "still running" result is actually returned rather than the manager timing out.
    const started = Date.now();
    const skill = byToolName.get(toolName);
    const raw = args.message ?? args.text ?? args.input ?? args.prompt;
    const text = typeof raw === 'string' ? raw : JSON.stringify(args);
    const message: A2aMessage = {
      role: 'user',
      parts: [{ kind: 'text', text }],
      messageId: randomUUID(),
      kind: 'message',
      ...(skill ? { metadata: { 'kravn/skillId': skill.id } } : {}),
    };
    const sent = (await rpc('message/send', {
      message,
      configuration: { blocking: true, acceptedOutputModes: ['text/plain', 'application/json'] },
    })) as { kind?: string } | A2aTask | A2aMessage;

    // The agent may answer with a bare Message (no task) or a Task.
    if (sent && (sent as { kind?: string }).kind === 'message') {
      return result(partsToText((sent as A2aMessage).parts));
    }
    let task = sent as A2aTask;
    if (!task || task.kind !== 'task' || !task.id) {
      // Unexpected shape — return whatever text we can find.
      return result(typeof sent === 'string' ? sent : JSON.stringify(sent));
    }

    // Poll to a stopped state within our budget (kept a full poll cycle under the manager's own timeout).
    const deadline = started + Math.max(1500, timeoutMs() - (POLL_INTERVAL_MS + 750));
    let state: A2aTaskState = task.status?.state ?? 'unknown';
    while (!isStoppedTaskState(state) && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const next = await rpc('tasks/get', { id: task.id });
      // A malformed/null tasks/get result must not crash the poll — keep the last known-good task.
      if (!next || (next as A2aTask).kind !== 'task') break;
      task = next as A2aTask;
      state = task.status?.state ?? 'unknown';
      if (isTerminalTaskState(state)) break;
    }
    return taskToResult(task);
  }

  return {
    listTools: async () => ({ tools: toolDefs }),
    listResources: async () => ({ resources: [] }),
    listPrompts: async () => ({ prompts: [] }),
    callTool: ({ name, arguments: args }) => callSkill(name, args),
    readResource: async () => {
      throw new Error('A2A agents do not expose MCP resources');
    },
    getPrompt: async () => {
      throw new Error('A2A agents do not expose MCP prompts');
    },
    close: async () => {},
  };
}
