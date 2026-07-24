import type { Logger } from 'pino';
import {
  A2A_PROTOCOL_VERSION,
  A2A_ERROR,
  a2aSendParamsSchema,
  a2aTaskQueryParamsSchema,
  a2aTaskIdParamsSchema,
  a2aPushSetParamsSchema,
  isTerminalTaskState,
  type AgentCard,
  type A2aAgentSkill,
  type A2aArtifact,
  type A2aMessage,
  type A2aPart,
  type A2aTask,
  type A2aTaskStatus,
  type A2aStatusUpdateEvent,
  type A2aArtifactUpdateEvent,
  type A2aTaskSummary,
  type ChatAgent,
  type McpEndpoint,
} from '@kravn/contracts';
import type { Repos, A2aTaskRecord } from '../db/repos.js';
import type { ChatService } from '../chat/chat.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { SsrfGuard } from '../http/ssrf.js';
import type { Encryptor } from '../crypto.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import { newId } from '../crypto.js';
import { APP_VERSION } from '../version.js';
import { canUseAgent } from '../chat/agent-access.js';
import { canConsumeMcpEndpoint } from '../mcp/endpoint-access.js';

/**
 * A2A (Agent2Agent) SERVER — Kravn published as a governed agent. Other agents delegate tasks to Kravn's
 * org agents (and, optionally, MCP endpoints), each delegation authenticated, entitlement-checked
 * (canUseAgent / canConsumeMcpEndpoint), executed under the SAME governance as chat (model allowlist,
 * token budget, DLP, per-tool audit) and recorded in the append-only audit trail.
 *
 * A skill maps 1:1 to an internal capability: an org agent (`skillId = agent.id`) or an MCP endpoint
 * (`skillId = "endpoint:<slug>"`). The caller selects a skill via `message.metadata['kravn/skillId']`
 * (Kravn's own A2A client bridge sets this automatically); with exactly one accessible skill it is used
 * by default. Execution reuses ChatService.send via the scheduler's non-interactive pattern, so the full
 * governance stack applies with no duplication.
 */

/** A JSON-RPC error carrying an A2A/JSON-RPC code — thrown internally, mapped to the wire by the caller. */
export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

export type RpcOutcome = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

/** One JSON-RPC result frame emitted over the SSE stream (the route wraps it into the envelope). */
export type Emit = (result: unknown) => void;

type SkillRef =
  | { kind: 'agent'; id: string; title: string; agent: ChatAgent }
  | { kind: 'endpoint'; id: string; title: string; endpoint: McpEndpoint };

interface A2ADeps {
  repos: Repos;
  chat: ChatService;
  settings: SettingsService;
  ssrf: SsrfGuard;
  encryptor: Encryptor;
  audit: AuditService;
  log: Logger;
}

const nowIso = (): string => new Date().toISOString();

function textOfParts(parts: A2aPart[] | undefined): string {
  if (!parts?.length) return '';
  return parts
    .map((p) => (p.kind === 'text' ? p.text : p.kind === 'data' ? JSON.stringify((p as { data: unknown }).data) : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function agentMessage(text: string): A2aMessage {
  return { role: 'agent', parts: [{ kind: 'text', text }], messageId: newId(), kind: 'message' };
}

function agentSkill(a: ChatAgent): A2aAgentSkill {
  return {
    id: a.id,
    name: a.name,
    description: a.description || a.name,
    tags: ['agent'],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
  };
}
function endpointSkill(ep: McpEndpoint): A2aAgentSkill {
  return {
    id: `endpoint:${ep.slug}`,
    name: ep.name,
    description: ep.description || `Run a task against the "${ep.name}" MCP endpoint.`,
    tags: ['mcp-endpoint'],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
  };
}

export class A2AService {
  constructor(private d: A2ADeps) {}

  private cfg() {
    return this.d.settings.get().a2a;
  }

  /** True when the A2A server surface (Agent Card + /a2a JSON-RPC) is published. */
  enabled(): boolean {
    return this.cfg().serverEnabled === true;
  }

  // ─── Skills / Agent Card ───────────────────────────────────────────────────────────────────────

  /**
   * The skills a caller may reach. `actor` undefined = anonymous discovery (restricted skills hidden).
   * `opts.all` = operator preview: list every exposed+enabled skill regardless of per-caller entitlement
   * (used only by the admin card-preview endpoint, never on the wire).
   */
  async listSkills(actor?: AuthUser, opts?: { all?: boolean }): Promise<Array<{ skill: A2aAgentSkill; ref: SkillRef }>> {
    const cfg = this.cfg();
    const all = opts?.all === true;
    const out: Array<{ skill: A2aAgentSkill; ref: SkillRef }> = [];
    if (cfg.exposeAgents) {
      const agents = await this.d.repos.chat.listAgents();
      for (const a of agents) {
        const usable = all ? a.enabled : actor ? canUseAgent(a, actor) : a.enabled && a.access === 'authenticated';
        if (!usable) continue;
        out.push({ skill: agentSkill(a), ref: { kind: 'agent', id: a.id, title: a.name, agent: a } });
      }
    }
    if (cfg.exposeEndpoints) {
      const eps = await this.d.repos.mcpEndpoints.list();
      for (const ep of eps) {
        if (!ep.enabled) continue;
        const usable = all ? true : actor ? canConsumeMcpEndpoint(ep, actor) : ep.access !== 'restricted';
        if (!usable) continue;
        out.push({ skill: endpointSkill(ep), ref: { kind: 'endpoint', id: `endpoint:${ep.slug}`, title: ep.name, endpoint: ep } });
      }
    }
    return out;
  }

  async buildAgentCard(baseUrl: string, actor?: AuthUser, opts?: { all?: boolean }): Promise<AgentCard> {
    const name = this.d.settings.get().general.instanceName || 'Kravn';
    const skills = (await this.listSkills(actor, opts)).map((s) => s.skill);
    return {
      protocolVersion: A2A_PROTOCOL_VERSION,
      name: `${name} (via Kravn)`,
      description:
        'Governed agent-to-agent gateway. Delegated tasks run under Kravn identity, team entitlements, model/DLP governance and a tamper-evident audit trail — nothing leaves your perimeter.',
      url: `${baseUrl}/a2a`,
      preferredTransport: 'JSONRPC',
      version: APP_VERSION,
      provider: { organization: name, url: baseUrl },
      capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills,
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'A Kravn access token, or an OAuth 2.1 mcp-scoped token issued by this instance.',
        },
      },
      security: [{ bearer: [] }],
    };
  }

  // ─── JSON-RPC dispatch (non-streaming) ───────────────────────────────────────────────────────────

  async dispatch(method: string, params: unknown, actor: AuthUser, ip?: string): Promise<RpcOutcome> {
    try {
      switch (method) {
        case 'message/send':
          return { result: await this.messageSend(params, actor, ip) };
        case 'tasks/get':
          return { result: await this.tasksGet(params, actor) };
        case 'tasks/cancel':
          return { result: await this.tasksCancel(params, actor, ip) };
        case 'tasks/pushNotificationConfig/set':
          return { result: await this.pushSet(params, actor) };
        case 'tasks/pushNotificationConfig/get':
          return { result: await this.pushGet(params, actor) };
        case 'tasks/pushNotificationConfig/list':
          return { result: await this.pushList(params, actor) };
        case 'tasks/pushNotificationConfig/delete':
          return { result: await this.pushDelete(params, actor) };
        default:
          return { error: { code: A2A_ERROR.METHOD_NOT_FOUND, message: `Unknown A2A method: ${method}` } };
      }
    } catch (e) {
      return { error: rpcErrorOf(e) };
    }
  }

  // ─── message/send (blocking or async) ────────────────────────────────────────────────────────────

  private async messageSend(rawParams: unknown, actor: AuthUser, ip?: string): Promise<A2aTask> {
    const params = a2aSendParamsSchema.parse(rawParams);
    const ref = await this.resolveSkill(params, actor);
    const rec = await this.createTask(params, actor, ref);
    if (params.configuration?.pushNotificationConfig) {
      await this.registerPush(rec.id, params.configuration.pushNotificationConfig);
    }
    void this.auditTask('a2a.task.create', actor, rec, ref, 'success', ip);

    // blocking !== false → run to completion and return the final task; else run in the background.
    if (params.configuration?.blocking === false) {
      void this.runTask(rec, actor, ref).catch((err) => this.d.log.warn({ err, task: rec.id }, 'a2a background task failed'));
      return this.buildTaskObject(rec);
    }
    const finalRec = await this.runTask(rec, actor, ref);
    return this.buildTaskObject(finalRec);
  }

  // ─── message/stream (SSE) ────────────────────────────────────────────────────────────────────────

  async streamSend(rawParams: unknown, actor: AuthUser, ip: string | undefined, emit: Emit): Promise<void> {
    const params = a2aSendParamsSchema.parse(rawParams);
    const ref = await this.resolveSkill(params, actor);
    const rec = await this.createTask(params, actor, ref);
    if (params.configuration?.pushNotificationConfig) {
      await this.registerPush(rec.id, params.configuration.pushNotificationConfig);
    }
    void this.auditTask('a2a.task.create', actor, rec, ref, 'success', ip);
    emit(this.buildTaskObject(rec)); // initial snapshot
    await this.runTask(rec, actor, ref, emit);
  }

  // ─── tasks/resubscribe (SSE): stream a task's remaining lifecycle from the store ─────────────────

  async resubscribe(rawParams: unknown, actor: AuthUser, emit: Emit, isClosed?: () => boolean): Promise<void> {
    const params = a2aTaskIdParamsSchema.parse(rawParams);
    let rec = await this.ownedTask(params.id, actor);
    emit(this.buildTaskObject(rec));
    // Poll the store until terminal (the running task persists each transition), emitting status changes.
    // Stop early if the SSE client disconnected so a dropped subscription doesn't keep querying for 10 min.
    const deadline = Date.now() + 10 * 60_000;
    let lastState = rec.state;
    let emittedTerminal = false;
    while (
      !isTerminalTaskState(rec.state) &&
      rec.state !== 'input-required' &&
      rec.state !== 'auth-required' &&
      Date.now() < deadline &&
      !(isClosed?.() ?? false)
    ) {
      await new Promise((r) => setTimeout(r, 1000));
      const fresh = await this.d.repos.a2aTasks.get(params.id);
      if (!fresh) break;
      rec = fresh;
      if (rec.state !== lastState) {
        lastState = rec.state;
        const terminal = isTerminalTaskState(rec.state);
        emit(this.statusEvent(rec, terminal));
        if (terminal) emittedTerminal = true;
      }
    }
    // Only emit a final terminal frame if the in-loop change detector didn't already send it.
    if (!emittedTerminal && isTerminalTaskState(rec.state)) emit(this.statusEvent(rec, true));
  }

  // ─── tasks/get, tasks/cancel ─────────────────────────────────────────────────────────────────────

  private async tasksGet(rawParams: unknown, actor: AuthUser): Promise<A2aTask> {
    const params = a2aTaskQueryParamsSchema.parse(rawParams);
    const rec = await this.ownedTask(params.id, actor);
    const task = this.buildTaskObject(rec);
    if (params.historyLength !== undefined) task.history = (task.history ?? []).slice(-params.historyLength);
    return task;
  }

  private async tasksCancel(rawParams: unknown, actor: AuthUser, ip?: string): Promise<A2aTask> {
    const params = a2aTaskIdParamsSchema.parse(rawParams);
    const rec = await this.ownedTask(params.id, actor);
    if (isTerminalTaskState(rec.state)) {
      throw new RpcError(A2A_ERROR.TASK_NOT_CANCELABLE, `Task ${rec.id} is already ${rec.state} and cannot be canceled.`);
    }
    await this.d.repos.a2aTasks.update(rec.id, { state: 'canceled', statusMessage: agentMessage('Task canceled by the caller.') });
    const fresh = (await this.d.repos.a2aTasks.get(rec.id))!;
    void this.auditTask('a2a.task.cancel', actor, fresh, undefined, 'success', ip);
    void this.firePush(fresh);
    return this.buildTaskObject(fresh);
  }

  // ─── push-notification config ────────────────────────────────────────────────────────────────────

  private async pushSet(rawParams: unknown, actor: AuthUser): Promise<{ taskId: string; pushNotificationConfig: { id: string; url: string } }> {
    const params = a2aPushSetParamsSchema.parse(rawParams);
    await this.ownedTask(params.taskId, actor); // ownership
    const id = await this.registerPush(params.taskId, params.pushNotificationConfig);
    return { taskId: params.taskId, pushNotificationConfig: { id, url: params.pushNotificationConfig.url } };
  }
  private async pushList(rawParams: unknown, actor: AuthUser): Promise<Array<{ taskId: string; pushNotificationConfig: { id: string; url: string } }>> {
    const params = a2aTaskIdParamsSchema.parse(rawParams);
    await this.ownedTask(params.id, actor);
    const configs = await this.d.repos.a2aPush.listByTask(params.id);
    return configs.map((c) => ({ taskId: params.id, pushNotificationConfig: { id: c.id, url: c.url } }));
  }
  private async pushGet(rawParams: unknown, actor: AuthUser): Promise<{ taskId: string; pushNotificationConfig: { id: string; url: string } }> {
    const p = rawParams as { id?: string; pushNotificationConfigId?: string };
    const taskId = String(p?.id ?? '');
    await this.ownedTask(taskId, actor);
    const configs = await this.d.repos.a2aPush.listByTask(taskId);
    const found = p.pushNotificationConfigId ? configs.find((c) => c.id === p.pushNotificationConfigId) : configs[0];
    if (!found) throw new RpcError(A2A_ERROR.INVALID_PARAMS, 'No such push notification config.');
    return { taskId, pushNotificationConfig: { id: found.id, url: found.url } };
  }
  private async pushDelete(rawParams: unknown, actor: AuthUser): Promise<null> {
    const p = rawParams as { id?: string; pushNotificationConfigId?: string };
    const taskId = String(p?.id ?? '');
    await this.ownedTask(taskId, actor);
    if (p.pushNotificationConfigId) await this.d.repos.a2aPush.delete(taskId, p.pushNotificationConfigId);
    return null;
  }

  private async registerPush(taskId: string, pnc: { id?: string; url: string; token?: string }): Promise<string> {
    // The webhook URL is CALLER-supplied (untrusted), so use the STRICT guard — block private/reserved/
    // loopback/metadata regardless of the ssrfAllowPrivateNetworks setting (which exists for operator-
    // configured upstreams, not caller callbacks). Mirrors the web/http plugin's untrusted-URL handling.
    await this.d.ssrf.assertPublicUrl(pnc.url);
    const id = pnc.id || newId();
    const tokenEnc = pnc.token ? this.d.encryptor.encrypt(pnc.token) : null;
    await this.d.repos.a2aPush.set(id, taskId, pnc.url, tokenEnc);
    return id;
  }

  // ─── Operator-facing helpers ─────────────────────────────────────────────────────────────────────

  async listTaskSummaries(limit = 100): Promise<A2aTaskSummary[]> {
    return this.d.repos.a2aTasks.listRecent(limit);
  }

  // ─── Task execution ──────────────────────────────────────────────────────────────────────────────

  private async createTask(params: { message: { parts: unknown; contextId?: string } }, actor: AuthUser, ref: SkillRef): Promise<A2aTaskRecord> {
    const message: A2aMessage = {
      role: 'user',
      // Parts are validated leniently (each carries a `kind`); the union cast is safe — textOfParts reads by kind.
      parts: params.message.parts as A2aPart[],
      messageId: newId(),
      kind: 'message',
    };
    return this.d.repos.a2aTasks.create({
      id: newId(),
      contextId: params.message.contextId || newId(),
      skillId: ref.id,
      skillKind: ref.kind,
      actorId: actor.id,
      actorEmail: actor.email,
      state: 'submitted',
      inputMessage: message,
    });
  }

  /** Drive a task through working → completed/failed, persisting each transition and emitting SSE events. */
  private async runTask(rec: A2aTaskRecord, actor: AuthUser, ref: SkillRef, emit?: Emit): Promise<A2aTaskRecord> {
    rec.state = 'working';
    await this.d.repos.a2aTasks.update(rec.id, { state: 'working' });
    emit?.(this.statusEvent(rec, false));

    const text = textOfParts(rec.inputMessage.parts);
    try {
      const { content, conversationId } = await this.executeViaChat(actor, ref, text);
      // If the task reached a terminal state (e.g. tasks/cancel) while the chat turn ran, don't clobber it
      // back to completed — return the persisted terminal record and skip the duplicate audit/push.
      const interrupted = await this.d.repos.a2aTasks.get(rec.id);
      if (interrupted && isTerminalTaskState(interrupted.state)) return interrupted;
      const artifact: A2aArtifact = { artifactId: newId(), name: 'result', parts: [{ kind: 'text', text: content }] };
      const statusMessage = agentMessage(content);
      rec.state = 'completed';
      rec.artifacts = [artifact];
      rec.statusMessage = statusMessage;
      rec.conversationId = conversationId;
      await this.d.repos.a2aTasks.update(rec.id, { state: 'completed', artifacts: [artifact], statusMessage, conversationId });
      emit?.(this.artifactEvent(rec, artifact));
      emit?.(this.statusEvent(rec, true));
      void this.auditTask('a2a.task.complete', actor, rec, ref, 'success');
    } catch (err) {
      const interrupted = await this.d.repos.a2aTasks.get(rec.id);
      if (interrupted && isTerminalTaskState(interrupted.state)) return interrupted;
      const msg = err instanceof Error ? err.message : String(err);
      const statusMessage = agentMessage(msg);
      rec.state = 'failed';
      rec.error = msg;
      rec.statusMessage = statusMessage;
      await this.d.repos.a2aTasks.update(rec.id, { state: 'failed', error: msg.slice(0, 2000), statusMessage });
      emit?.(this.statusEvent(rec, true));
      void this.auditTask('a2a.task.fail', actor, rec, ref, 'failure');
    }
    void this.firePush(rec);
    return rec;
  }

  /** Route a task to an org agent or MCP endpoint by running one chat turn as the caller (full governance). */
  private async executeViaChat(actor: AuthUser, ref: SkillRef, text: string): Promise<{ content: string; conversationId: string }> {
    let providerId = '';
    let model = '';
    let vserverSlug = '';
    let agentId: string | null = null;

    if (ref.kind === 'agent') {
      agentId = ref.agent.id;
      if (ref.agent.providerId && ref.agent.model) {
        providerId = ref.agent.providerId;
        model = ref.agent.model;
      }
    } else {
      vserverSlug = ref.endpoint.slug;
    }
    if (!providerId || !model) {
      const def = await this.resolveDefaultModel();
      if (!def) throw new Error('No LLM provider/model is configured to run this A2A task.');
      providerId = providerId || def.providerId;
      model = model || def.model;
    }

    const convId = newId();
    const stamp = nowIso().replace('T', ' ').slice(0, 16);
    await this.d.repos.chat.createConversation(actor.id, {
      id: convId,
      projectId: null,
      title: `🤝 A2A · ${ref.title} · ${stamp}`,
      providerId,
      model,
      vserverSlug,
      agentId,
    });
    const msg = await this.d.chat.send(actor, convId, text);
    return { content: msg.content, conversationId: convId };
  }

  private async resolveDefaultModel(): Promise<{ providerId: string; model: string } | null> {
    const providers = await this.d.repos.llmProviders.list();
    const p = providers.find((x) => x.enabled) ?? providers[0];
    if (!p) return null;
    const model = p.defaultModel || p.models[0] || '';
    if (!model) return null;
    return { providerId: p.id, model };
  }

  // ─── Skill resolution + ownership ────────────────────────────────────────────────────────────────

  private async resolveSkill(params: { message?: { metadata?: Record<string, unknown> }; metadata?: Record<string, unknown> }, actor: AuthUser): Promise<SkillRef> {
    const skillId =
      (params.message?.metadata?.['kravn/skillId'] as string | undefined) ??
      (params.metadata?.['kravn/skillId'] as string | undefined) ??
      (params.metadata?.skillId as string | undefined);
    const skills = await this.listSkills(actor);
    if (skillId) {
      const found = skills.find((s) => s.ref.id === skillId || s.ref.id === `endpoint:${skillId}`);
      if (found) return found.ref;
      throw new RpcError(A2A_ERROR.INVALID_PARAMS, `Skill "${skillId}" is unknown or you are not entitled to it.`);
    }
    if (skills.length === 1) return skills[0].ref;
    if (skills.length === 0) throw new RpcError(A2A_ERROR.INVALID_PARAMS, 'No A2A skills are available to you.');
    throw new RpcError(
      A2A_ERROR.INVALID_PARAMS,
      `Specify a skill via message.metadata['kravn/skillId']. Available: ${skills.map((s) => s.ref.id).join(', ')}.`,
    );
  }

  private async ownedTask(id: string, actor: AuthUser): Promise<A2aTaskRecord> {
    const rec = await this.d.repos.a2aTasks.get(id);
    // Data plane: ownership is strictly the caller — a platform admin is NOT a free pass here (mirrors
    // canUseAgent / canConsumeMcpEndpoint), so an admin can't read/cancel/attach a push webhook to another
    // user's task. Admin inspection stays on the control-plane operator endpoints (settings.read-gated).
    // Unknown id and other-owner both surface as TASK_NOT_FOUND (no existence leak).
    if (!rec || (rec.actorId && rec.actorId !== actor.id)) {
      throw new RpcError(A2A_ERROR.TASK_NOT_FOUND, `Task ${id} was not found.`);
    }
    return rec;
  }

  // ─── Projections + events ────────────────────────────────────────────────────────────────────────

  private buildTaskObject(rec: A2aTaskRecord): A2aTask {
    const status: A2aTaskStatus = { state: rec.state, timestamp: rec.updatedAt };
    if (rec.statusMessage) status.message = rec.statusMessage;
    return {
      id: rec.id,
      contextId: rec.contextId,
      status,
      artifacts: rec.artifacts,
      history: rec.history,
      kind: 'task',
    };
  }
  private statusEvent(rec: A2aTaskRecord, final: boolean): A2aStatusUpdateEvent {
    const status: A2aTaskStatus = { state: rec.state, timestamp: nowIso() };
    if (rec.statusMessage) status.message = rec.statusMessage;
    return { taskId: rec.id, contextId: rec.contextId, kind: 'status-update', status, final };
  }
  private artifactEvent(rec: A2aTaskRecord, artifact: A2aArtifact): A2aArtifactUpdateEvent {
    return { taskId: rec.id, contextId: rec.contextId, kind: 'artifact-update', artifact, lastChunk: true };
  }

  // ─── Push delivery + audit ───────────────────────────────────────────────────────────────────────

  private async firePush(rec: A2aTaskRecord): Promise<void> {
    try {
      const configs = await this.d.repos.a2aPush.listByTask(rec.id);
      if (!configs.length) return;
      const body = JSON.stringify(this.buildTaskObject(rec));
      for (const c of configs) {
        try {
          // Untrusted caller URL → strict SSRF (pre-flight) + the strict pinned dispatcher + a hard timeout
          // (matches the audit SIEM webhook) so a slow/hostile endpoint can't hold a socket for undici's ~5m
          // default or reach an internal host.
          await this.d.ssrf.assertPublicUrl(c.url);
          const token = c.tokenEnc ? this.d.encryptor.decrypt(c.tokenEnc) : '';
          // `dispatcher` isn't on the DOM RequestInit type; undici's global fetch honors it — cast like the
          // http plugin does. strictAgent pins egress to public IPs; the abort caps a slow endpoint at 10s.
          const init = {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
            dispatcher: this.d.ssrf.strictAgent,
          } as unknown as RequestInit;
          await fetch(c.url, init);
        } catch (err) {
          this.d.log.warn({ err, task: rec.id, url: c.url }, 'a2a push notification failed');
        }
      }
    } catch (err) {
      this.d.log.warn({ err, task: rec.id }, 'a2a push notification dispatch failed');
    }
  }

  private async auditTask(action: string, actor: AuthUser, rec: A2aTaskRecord, ref: SkillRef | undefined, outcome: 'success' | 'failure', ip?: string): Promise<void> {
    void this.d.audit.record({
      category: 'a2a',
      action,
      actor: { id: actor.id, email: actor.email, role: actor.role },
      resourceType: ref?.kind === 'endpoint' ? 'a2a_endpoint' : 'a2a_agent',
      resourceId: rec.skillId,
      outcome,
      details: {
        taskId: rec.id,
        contextId: rec.contextId,
        skillKind: rec.skillKind,
        conversationId: rec.conversationId,
        error: rec.error ?? undefined,
      },
      ip,
    });
  }
}

/** Map any thrown value to a JSON-RPC error object (RpcError → its code; ZodError → invalid params). */
export function rpcErrorOf(e: unknown): { code: number; message: string; data?: unknown } {
  if (e instanceof RpcError) return { code: e.code, message: e.message, data: e.data };
  if (e && typeof e === 'object' && (e as { name?: string }).name === 'ZodError') {
    return { code: A2A_ERROR.INVALID_PARAMS, message: 'Invalid A2A parameters.', data: (e as { issues?: unknown }).issues };
  }
  return { code: A2A_ERROR.INTERNAL_ERROR, message: e instanceof Error ? e.message : String(e) };
}
