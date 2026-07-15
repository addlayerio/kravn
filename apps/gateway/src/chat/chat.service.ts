import { type ChatConversation, type ChatMessage, type ChatAttachmentKind, type LlmProvider, type AvailableTool } from '@kravn/contracts';
import { newId, type Encryptor } from '../crypto.js';
import { canConsumeMcpEndpoint } from '../mcp/endpoint-access.js';
import { safeFetch } from '../http/client.js';
import { withSpan } from '../otel.js';
import type { Repos } from '../db/repos.js';
import type { RegistryService } from '../mcp/registry.service.js';
import type { PluginManager } from '../plugins/manager.js';
import { PluginDenied } from '../plugins/manager.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { UsageService } from '../usage/usage.service.js';
import { CODE_INTERPRETER_ID, INTERPRETER_TOOL_NAME } from '../plugins/native.js';
import type { AuthUser } from '../auth/auth.service.js';
import type { Logger } from 'pino';

/** Server id the registry assigns to a plugin-backed MCP server (see RegistryService.syncPluginServers). */
const PLUGIN_SERVER_PREFIX = 'plg_';

/** tool name → { registry tool id, the MCP endpoint that scopes THIS tool's pipeline/metering }. A project chat
 *  may draw tools from several endpoints, so the endpoint is per-tool (undefined ⇒ global pipeline only). */
type ToolIndex = Map<string, { toolId: string; endpointId?: string }>;

function attachmentKindForName(name: string): ChatAttachmentKind {
  const e = name.toLowerCase().split('.').pop() ?? '';
  if (e === 'xlsx' || e === 'xls' || e === 'csv') return 'spreadsheet';
  if (e === 'pdf') return 'pdf';
  if (e === 'docx' || e === 'doc') return 'document';
  if (['txt', 'md', 'json', 'log', 'xml', 'html'].includes(e)) return 'text';
  return 'other';
}

const DEFAULT_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  'azure-openai': '',
  ollama: 'http://localhost:11434/v1',
  'openai-compatible': '',
};

/** Fallback for the chat agentic-loop round cap when the setting is unavailable (settings.governance.chatMaxToolRounds). */
const DEFAULT_MAX_TOOL_ROUNDS = 12;

/** Output ceiling for Anthropic. Thinking tokens are drawn from THIS budget, so a low cap truncates the answer
 *  (or spends the whole cap reasoning) — 4096 cut long structured reports short. Anthropic's own ceiling is 128K,
 *  but that requires streaming; ~16K is the documented safe cap for a non-streaming request. */
const ANTHROPIC_MAX_TOKENS = 16_000;
/** …and a 16K non-streaming answer takes minutes to generate, so the shared 60s budget no longer fits. */
const ANTHROPIC_TIMEOUT_MS = 180_000;

/**
 * What a chat turn reports while it runs, so the caller can show the work instead of a frozen spinner.
 * A turn is a loop — think, call a tool, read the result, think again — and until now none of that was
 * visible: the browser waited in silence for minutes. `thinking` carries Claude's own reasoning summary
 * for the round (only where the provider returns one); `tool`/`tool_result` bracket each call.
 */
export type ChatProgress =
  | { type: 'round'; round: number; maxRounds: number }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'tool_result'; name: string; ok: boolean };

/** A message's content is usually a plain string; a user turn with image attachments is a block array. */
type LlmContentBlock = { type: 'text'; text: string } | { type: 'image'; mime: string; b64: string };
interface LlmMessage {
  role: string;
  content: string | LlmContentBlock[] | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  /** Anthropic thinking blocks, kept verbatim. When thinking is on, an assistant turn carrying `tool_use` must
   *  replay them UNCHANGED (they are signed) or the next request 400s — so the tool loop threads them back
   *  through toAnthropicMessages. Opaque to every other provider. */
  reasoning?: unknown[];
}

/** Image MIME from a filename extension (only what the vision APIs accept). null = not an image. */
function imageMime(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return null;
}
/** Coerce message content (string or block array) to plain text — for providers/paths that need a string. */
function textFromContent(c: string | LlmContentBlock[] | null | undefined): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
  return '';
}

export class ChatService {
  constructor(
    private repos: Repos,
    private encryptor: Encryptor,
    private registry: RegistryService,
    private log: Logger,
    private plugins: PluginManager,
    private settings: SettingsService,
    private usage: UsageService,
  ) {}

  /** Model governance: reject a model that isn't on the operator's allowlist (empty = allow any). Supports
   *  exact ids and simple `*` globs (e.g. `claude-*`). */
  private assertModelAllowed(model: string): void {
    const allowed = this.settings.get().security.allowedModels ?? [];
    if (!allowed.length) return;
    const ok = allowed.some((pat) => {
      if (pat === model) return true;
      if (!pat.includes('*')) return false;
      const re = new RegExp('^' + pat.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return re.test(model);
    });
    if (!ok) throw new Error(`Model "${model}" is not allowed by policy. Allowed: ${allowed.join(', ')}.`);
  }

  /** Send a user message and produce the assistant reply (running tools when the model asks).
   *
   *  `onProgress` is optional and purely observational: it reports the turn as it runs (see ChatProgress) so a
   *  streaming caller can show the work. The turn does NOT depend on it — a caller that omits it (the
   *  scheduler) is unaffected, and a caller whose connection dies mid-turn still gets the reply persisted,
   *  because the loop below never consults the callback. */
  async send(
    actor: AuthUser,
    conversationId: string,
    content: string,
    attachmentIds: string[] = [],
    onProgress?: (p: ChatProgress) => void,
  ): Promise<ChatMessage> {
    const conv = await this.repos.chat.getConversation(actor.id, conversationId);
    if (!conv) throw new Error('Conversation not found.');

    const provider = await this.repos.llmProviders.getById(conv.providerId);
    if (!provider) throw new Error('The conversation has no valid LLM provider.');
    this.assertModelAllowed(conv.model); // model-governance allowlist
    await this.usage.assertTokenBudget(); // cost/quota governance — org-wide daily token budget
    const key = this.encryptor.decrypt(await this.repos.llmProviders.getApiKeyEncrypted(conv.providerId));

    // Tool-calling is wired for OpenAI-family and Anthropic. Gemini still runs plain for now.
    const supportsTools = provider.type !== 'gemini';
    // Resolve the endpoint first: it's the scope for both tool entitlements AND the chat-input DLP overlay.
    const { tools, toolIndex, mcpEndpointId } = await this.resolveTools(actor, conv);

    // DLP on the way IN — run the `onChatInput` pipeline (e.g. PII Tokenizer) so raw PII the user typed (a
    // CUIT, an email, a bank account) is tokenized BEFORE it reaches the model. We persist BOTH the original
    // (what the user sees) and the model-bound copy (what the LLM received), so the redaction is auditable.
    const modelContent = await this.dlpChatInput(content, actor, mcpEndpointId);

    const userMsg = await this.repos.chat.addMessage(newId(), conversationId, 'user', content, modelContent);
    // Attach any uploaded files to this turn's user message (so they show in the thread + feed context).
    if (attachmentIds.length) {
      await this.repos.chat.linkAttachmentsToMessage(actor.id, conversationId, userMsg.id, attachmentIds);
    }
    // First message becomes the title.
    const existing = await this.repos.chat.listMessages(conversationId);
    if (existing.filter((m) => m.role === 'user').length === 1) {
      await this.repos.chat.touchConversation(conversationId, content.slice(0, 60));
    }

    // The code interpreter is a native PLUGIN; when enabled, auto-offer its registry tools (it's also
    // composable into virtual servers like any mcp-server plugin). No special-casing of execution.
    const interpreterOn = supportsTools && this.plugins.isEnabled(CODE_INTERPRETER_ID);
    if (interpreterOn) {
      await this.addPluginServerTools(`${PLUGIN_SERVER_PREFIX}${CODE_INTERPRETER_ID}`, tools, toolIndex, mcpEndpointId);
    }

    const history = await this.repos.chat.listMessages(conversationId);
    // Image attachments per user turn → sent to the model as vision blocks (multimodal input).
    const imagesByMsg = await this.imageBlocksByMessage(actor.id, conversationId);
    const messages: LlmMessage[] = [
      // Only advertise the run_python guidance when the interpreter is actually offered this turn.
      { role: 'system', content: await this.buildSystemPrompt(actor, conv, interpreterOn) },
      // Each user turn: the DLP-transformed text (stored `modelContent`, or a fresh transform for messages
      // persisted before DLP was enabled) — never the raw PII — plus any image attachments as vision blocks.
      // Assistant/tool turns are model-generated and pass through unchanged.
      ...(await Promise.all(
        history.map(async (m): Promise<LlmMessage> => {
          if (m.role !== 'user') return { role: m.role, content: m.content };
          const text = m.modelContent ?? (await this.plugins.applyChatInput(m.content, actor, mcpEndpointId).catch(() => m.content));
          const imgs = imagesByMsg.get(m.id);
          if (imgs && imgs.length) return { role: 'user', content: [{ type: 'text', text }, ...imgs] };
          return { role: 'user', content: text };
        }),
      )),
    ];

    // The per-turn file workspace handed to file-aware tools (e.g. the interpreter), and the output
    // files those tools produce (persisted as downloadable attachments on the assistant message).
    const workspaceFiles: Array<{ name: string; b64: string; mime?: string }> = await this.repos.chat.getAttachmentFiles(actor.id, conversationId);
    const producedAttachmentIds: string[] = [];
    let finalText = '';

    // Best-effort and never load-bearing: a throwing/closed reporter must not fail the turn.
    const report = (p: ChatProgress) => {
      try {
        onProgress?.(p);
      } catch {
        /* a broken reporter is not the turn's problem */
      }
    };

    if (!supportsTools || tools.length === 0) {
      // Plain completion (no tool loop). Native web search still applies — it runs server-side at the provider.
      const msg = await this.complete(actor, provider, key, conv.model, messages, [], conv.webSearch);
      const think = thinkingTextOf(msg);
      if (think) report({ type: 'thinking', text: think });
      finalText = textOf(msg);
    } else {
      // Provider-agnostic tool loop (complete() normalizes OpenAI / Anthropic tool formats). The round cap is an
      // operator setting (settings.governance.chatMaxToolRounds) — higher suits deep multi-source agents.
      const maxRounds = this.settings.get().governance.chatMaxToolRounds || DEFAULT_MAX_TOOL_ROUNDS;
      for (let round = 0; round < maxRounds; round++) {
        report({ type: 'round', round: round + 1, maxRounds });
        const msg = await this.complete(actor, provider, key, conv.model, messages, tools, conv.webSearch);
        const think = thinkingTextOf(msg);
        if (think) report({ type: 'thinking', text: think });
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          finalText = textOf(msg);
          break;
        }
        // Don't execute the final round's tools — their results could never be fed back to the model.
        // Whatever text came with them is a PREAMBLE ("let me fetch X…"), never the answer, so ALWAYS say the
        // turn was cut: otherwise that preamble is persisted as if it were a complete reply and the run looks
        // like it silently died. (This is the visible symptom of hitting the cap.)
        if (round === maxRounds - 1) {
          const partial = textOf(msg).trim();
          const notice =
            `⚠️ **Incomplete** — stopped after ${maxRounds} tool rounds for this message (the safety limit), ` +
            'so the analysis above is unfinished. Ask me to continue, or an operator can raise ' +
            '"Chat: max tool rounds per message" in Settings → Governance.';
          finalText = partial ? `${partial}\n\n---\n\n${notice}` : notice;
          break;
        }
        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls, reasoning: msg.reasoning });
        for (const call of msg.tool_calls) {
          const name = call.function?.name;
          let args: Record<string, unknown> = {};
          try {
            args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            /* ignore bad args */
          }
          let resultText: string;
          report({ type: 'tool', name });
          let ok = true;
          try {
            const entry = toolIndex.get(name);
            if (!entry) throw new Error(`unknown tool ${name}`);
            // endpointId scopes THIS call's pipeline overlays (incl. the approval gate) + usage metering: a
            // normal chat's endpoint drives them exactly as the MCP data plane does. It is undefined for a
            // project tool (endpoint-independent → global pipeline only) and for a plugin-sandbox tool. The tool
            // always executes against its own origin server regardless.
            const result = await this.registry.invokeTool(entry.toolId, args, actor, { mcpEndpointId: entry.endpointId, files: workspaceFiles });
            // Only honor result `files` (→ downloadable attachments) from in-process plugin tools, never
            // from remote MCP upstreams (toolId `tl_plg_…` ⇒ plugin server). See review F1.
            const trusted = entry.toolId.startsWith('tl_plg_');
            resultText = await this.persistToolFiles(actor, conversationId, result, producedAttachmentIds, trusted);
            // Make trusted tool-produced files available to LATER tools THIS SAME turn — e.g. so a PDF the
            // code interpreter just generated can be attached to an email (via attachFiles) without the model
            // ever handling the raw bytes.
            const produced = (result as { files?: Array<{ name?: string; b64?: string; mime?: string }> }).files;
            if (trusted && Array.isArray(produced)) {
              for (const f of produced) {
                if (f?.name && f?.b64 && !workspaceFiles.some((w) => w.name === f.name)) workspaceFiles.push({ name: f.name, b64: f.b64, mime: f.mime });
              }
            }
          } catch (err) {
            ok = false;
            resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
          report({ type: 'tool_result', name, ok });
          messages.push({ role: 'tool', tool_call_id: call.id, name, content: resultText });
        }
      }
    }

    const assistantMsg = await this.repos.chat.addMessage(newId(), conversationId, 'assistant', finalText || '(no response)');
    // Attach any tool-produced files to the assistant message so the user can download them.
    if (producedAttachmentIds.length) {
      await this.repos.chat.linkAttachmentsToMessage(actor.id, conversationId, assistantMsg.id, producedAttachmentIds);
    }
    return assistantMsg;
  }

  /** Add an enabled plugin server's registry tools to the chat tool list (deduped), routed via registry.invokeTool.
   *  `endpointId` scopes the call's pipeline/metering (the chat's endpoint for a normal chat; undefined otherwise). */
  private async addPluginServerTools(serverId: string, tools: any[], toolIndex: ToolIndex, endpointId?: string): Promise<void> {
    for (const t of await this.repos.registry.listToolsByServer(serverId)) {
      if (!t.enabled || toolIndex.has(t.name)) continue;
      toolIndex.set(t.name, { toolId: t.id, endpointId });
      tools.push({ type: 'function', function: { name: t.name, description: t.description || undefined, parameters: t.inputSchema ?? { type: 'object', properties: {} } } });
    }
  }

  private static readonly MAX_TOOL_FILES = 10;
  private static readonly MAX_TOOL_FILE_BYTES = 15 * 1024 * 1024;

  /**
   * Persist files a tool result carries as downloadable attachments; return the model-facing text (no bytes).
   * Only trusted in-process plugins may emit files (a remote MCP upstream must not write user attachments via
   * the Kravn `files` extension), and totals are capped to mirror the upload/interpreter limits.
   */
  private async persistToolFiles(actor: AuthUser, conversationId: string, result: unknown, produced: string[], trusted: boolean): Promise<string> {
    const r = (result ?? {}) as { content?: unknown; files?: { name: string; b64: string; mime?: string }[] };
    const files = Array.isArray(r.files) ? r.files : [];
    if (files.length === 0) return JSON.stringify(result);
    if (!trusted) {
      // Drop any `files` from an untrusted upstream — never persist or forward their bytes.
      return JSON.stringify({ content: r.content });
    }
    let totalBytes = 0;
    const saved: string[] = [];
    for (const f of files) {
      if (typeof f?.name !== 'string' || typeof f?.b64 !== 'string') continue;
      if (produced.length >= ChatService.MAX_TOOL_FILES) break;
      const size = Buffer.from(f.b64, 'base64').length;
      if (size > ChatService.MAX_TOOL_FILE_BYTES || totalBytes + size > ChatService.MAX_TOOL_FILE_BYTES) continue;
      totalBytes += size;
      const att = await this.repos.chat.addAttachment({
        id: newId(),
        conversationId,
        userId: actor.id,
        name: f.name,
        mime: f.mime || 'application/octet-stream',
        size,
        kind: attachmentKindForName(f.name),
        extractedText: '',
        dataB64: f.b64,
      });
      produced.push(att.id);
      saved.push(f.name);
    }
    // Feed back only the file names (not bytes) so the model can reference the downloads.
    return JSON.stringify({ content: r.content, files: saved.map((name) => ({ name })) });
  }

  // ─── System prompt (+ project instructions and documents as context) ───────────────────────────

  private static readonly DOC_CONTEXT_BUDGET = 60_000;
  private static readonly ATTACH_CONTEXT_BUDGET = 120_000;

  /**
   * Run the `onChatInput` DLP pipeline on an end-user message (global chain + this endpoint's overlay).
   * A redaction/tokenization hook (e.g. PII Tokenizer) rewrites the text; a `deny` becomes a clear,
   * user-visible block. No hook enabled → returns the content unchanged (zero cost).
   */
  private async dlpChatInput(content: string, actor: AuthUser, vsId?: string): Promise<string> {
    try {
      return await this.plugins.applyChatInput(content, actor, vsId);
    } catch (err) {
      if (err instanceof PluginDenied) throw new Error(`Message blocked by policy: ${err.message}`);
      throw err;
    }
  }

  /** Image attachments per message id, as vision blocks (base64 bytes + mime derived from the filename). */
  private async imageBlocksByMessage(userId: string, convId: string): Promise<Map<string, LlmContentBlock[]>> {
    const map = new Map<string, LlmContentBlock[]>();
    for (const b of await this.repos.chat.listAttachmentBlobs(userId, convId)) {
      const mime = imageMime(b.name);
      if (!mime || !b.b64) continue;
      const arr = map.get(b.messageId) ?? [];
      arr.push({ type: 'image', mime, b64: b.b64 });
      map.set(b.messageId, arr);
    }
    return map;
  }

  private async buildSystemPrompt(actor: AuthUser, conv: ChatConversation, canRunCode = false): Promise<string> {
    const parts = ['You are Kravn, a helpful corporate AI assistant. Use the available tools when relevant.'];

    // Assistant preset — the persona the chat was started from. Loaded live + owner-scoped, so editing
    // the assistant updates its chats, and it never leaks another user's preset.
    if (conv.assistantId) {
      const assistant = await this.repos.chat.getAssistant(actor.id, conv.assistantId);
      if (assistant?.instructions?.trim()) parts.push(`Assistant instructions:\n${assistant.instructions.trim()}`);
    }

    // Persistent memory — durable facts the user chose to keep. User-curated (not model-extracted),
    // so it stays a governed, auditable set the operator can inspect.
    const memory = await this.repos.chat.listMemory(actor.id);
    if (memory.length) {
      const facts = memory.map((m) => `- ${m.content.trim()}`).join('\n');
      parts.push(`The user has asked you to remember the following about them:\n${facts}`);
    }

    // Project context — injected only if the caller can access the project (owner OR a shared member).
    // getProjectForUser is fail-closed, so a project the user was never granted (or was un-shared from)
    // leaks nothing into the prompt.
    if (conv.projectId) {
      const project = await this.repos.chat.getProjectForUser(actor.id, conv.projectId);
      if (project) {
        if (project.instructions?.trim()) parts.push(`Project instructions:\n${project.instructions.trim()}`);
        const docs = await this.repos.chat.listDocuments(conv.projectId);
        const docBlock = renderWithBudget(docs.map((d) => ({ name: d.name, text: d.content })), ChatService.DOC_CONTEXT_BUDGET);
        if (docBlock) parts.push(`The following project documents are provided as reference context:\n\n${docBlock}`);
      }
    }

    // Files the user uploaded into this conversation (scoped to the owner).
    const atts = await this.repos.chat.getConversationAttachmentsForContext(actor.id, conv.id);
    const attBlock = renderWithBudget(atts.filter((a) => a.text.trim()).map((a) => ({ name: a.name, text: a.text })), ChatService.ATTACH_CONTEXT_BUDGET);
    if (attBlock) parts.push(`The user attached the following files — use them to answer:\n\n${attBlock}`);

    if (canRunCode && atts.length) {
      parts.push(
        `To transform or complete a file (e.g. fill in a spreadsheet), call the ${INTERPRETER_TOOL_NAME} tool with Python code. ` +
        `The attached files (${atts.map((a) => a.name).join(', ')}) are in the working directory by name. ` +
        `Save your result to a new file in the working directory (e.g. "completed.xlsx") to give the user a download.`,
      );
    }

    return parts.join('\n\n');
  }

  // ─── Tools from the conversation's virtual server (team-scoped) ─────────────────────────────────

  private toolDef(t: { name: string; description?: string; inputSchema?: unknown }) {
    return { type: 'function', function: { name: t.name, description: t.description || undefined, parameters: t.inputSchema ?? { type: 'object', properties: {} } } };
  }

  /**
   * The flat list of tools the user is ENTITLED to — the union across every MCP endpoint they can consume,
   * narrowed by their team tool-grant — for the project tool picker (and the run-time re-validation below).
   * Each tool references ONE endpoint the user can reach it through (dedup: first consumable endpoint wins);
   * that endpoint is only a reference for grouping/execution — it does not widen access. Governance is the
   * unchanged MCP data plane (endpoint access + team grants); this is a read over it, never a new grant.
   */
  async listAvailableTools(actor: AuthUser): Promise<AvailableTool[]> {
    const endpoints = (await this.repos.mcpEndpoints.list()).filter((v) => v.enabled && canConsumeMcpEndpoint(v, actor));
    const allTools = await this.repos.registry.listTools();
    const byId = new Map(allTools.map((t) => [t.id, t]));
    const serverName = new Map((await this.repos.servers.list()).map((srv) => [srv.id, srv.name] as const));
    const out = new Map<string, AvailableTool>();
    for (const vs of endpoints) {
      const allowed = await this.repos.teams.allowedToolIdsForUser(actor, vs); // null = all of the endpoint's tools
      for (const toolId of vs.toolIds) {
        if (out.has(toolId)) continue; // first consumable endpoint wins
        const t = byId.get(toolId);
        if (!t || !t.enabled) continue;
        if (allowed && !allowed.has(toolId)) continue;
        out.set(toolId, { id: t.id, name: t.name, description: t.description ?? '', serverId: t.serverId, serverName: serverName.get(t.serverId) ?? '', endpointSlug: vs.slug, endpointName: vs.name });
      }
    }
    return [...out.values()];
  }

  private async resolveTools(actor: AuthUser, conv: ChatConversation): Promise<{ tools: any[]; toolIndex: ToolIndex; mcpEndpointId: string | undefined }> {
    // A project that pins tools takes precedence: the chat offers EXACTLY the project's tools (re-validated
    // against the CALLER's live entitlement), possibly spanning several endpoints. Falls through to the chat's
    // own MCP-endpoint selection when the project pins nothing.
    if (conv.projectId) {
      const project = await this.repos.chat.getProjectForUser(actor.id, conv.projectId);
      if (project && project.toolIds.length) return this.resolveProjectTools(actor, project.toolIds);
    }

    const tools: any[] = [];
    const toolIndex: ToolIndex = new Map();
    if (!conv.vserverSlug) return { tools, toolIndex, mcpEndpointId: undefined };

    const vs = await this.repos.mcpEndpoints.getBySlug(conv.vserverSlug);
    if (!vs || !vs.enabled) return { tools, toolIndex, mcpEndpointId: undefined };

    // Enforce the MCP endpoint's DATA-PLANE access policy (same rule as the MCP endpoint + chat options):
    // consumption is by team membership — platform role/admin is NOT an axis here.
    if (!canConsumeMcpEndpoint(vs, actor)) throw new Error('You do not have access to this MCP endpoint.');

    const allTools = await this.repos.registry.listTools();
    const set = new Set(vs.toolIds);
    // Level-2 entitlement: narrow to the tools this user's team grant allows (null = all).
    const allowed = await this.repos.teams.allowedToolIdsForUser(actor, vs);
    for (const t of allTools) {
      if (!set.has(t.id) || !t.enabled) continue;
      if (allowed && !allowed.has(t.id)) continue;
      if (toolIndex.has(t.name)) continue; // tool names are the model's addressing key + must be unique to the provider
      toolIndex.set(t.name, { toolId: t.id, endpointId: vs.id });
      tools.push(this.toolDef(t));
    }
    // Carry the endpoint id so the tool-call path applies this endpoint's per-VS pipeline overlays (e.g. the
    // Human Approval Gate) and per-endpoint usage metering — identical to the MCP data plane. See review F1.
    return { tools, toolIndex, mcpEndpointId: vs.id };
  }

  /** Build the tool set for a project chat from the pinned tool ids. Entitlement is RE-CHECKED live via
   *  listAvailableTools (a tool the caller is no longer entitled to is silently dropped — the pin is a filter,
   *  never a grant).
   *
   *  Governance is ENDPOINT-INDEPENDENT: a project picks tools, not an endpoint, so a tool must not depend on
   *  which endpoint it happens to be reachable through. The tool still executes against its own origin SERVER
   *  (that's `tool.serverId`, unaffected by any endpoint), and the **global** pipeline applies (audit, secrets,
   *  PII, prompt-injection — the org-wide baseline). We deliberately do NOT attach a per-endpoint overlay
   *  (approval gate / endpoint DLP), because the "endpoint" here is only a grouping reference the user never
   *  chose — routing a tool through an arbitrary first-consumable endpoint's overlay would make it behave
   *  unpredictably (and could silently block it). Hence endpointId is undefined for every project tool. */
  private async resolveProjectTools(actor: AuthUser, pinnedToolIds: string[]): Promise<{ tools: any[]; toolIndex: ToolIndex; mcpEndpointId: string | undefined }> {
    const tools: any[] = [];
    const toolIndex: ToolIndex = new Map();
    const available = await this.listAvailableTools(actor); // the tools the caller is CURRENTLY entitled to
    const entitledIds = new Set(available.map((a) => a.id));
    const allTools = await this.repos.registry.listTools();
    const byId = new Map(allTools.map((t) => [t.id, t]));
    const seen = new Set<string>();
    for (const toolId of pinnedToolIds) {
      if (seen.has(toolId)) continue;
      seen.add(toolId);
      if (!entitledIds.has(toolId)) continue; // re-validated live: not entitled → dropped (pin is a filter)
      const t = byId.get(toolId);
      if (!t || !t.enabled) continue;
      // Tool NAME is the model's addressing key and must be unique to the provider. Two DIFFERENT pinned tools
      // can share a name (e.g. `search` from two servers); offering both would duplicate the function name
      // (provider 400). First pinned wins — same rule as the plugin-tool merge.
      if (toolIndex.has(t.name)) continue;
      toolIndex.set(t.name, { toolId: t.id, endpointId: undefined }); // endpoint-independent: global pipeline only
      tools.push(this.toolDef(t));
    }
    return { tools, toolIndex, mcpEndpointId: undefined };
  }

  // ─── LLM call (OpenAI-compatible + Anthropic) ──────────────────────────────────────────────────

  private baseUrl(p: LlmProvider): string {
    return (p.baseUrl || DEFAULT_BASE[p.type] || '').replace(/\/$/, '');
  }

  private complete(actor: AuthUser, p: LlmProvider, key: string, model: string, messages: LlmMessage[], tools: any[], webSearch = false): Promise<LlmMessage> {
    return withSpan(
      `llm.chat ${p.type}`,
      () => this.completeInner(actor, p, key, model, messages, tools, webSearch),
      { 'llm.provider': p.type, 'llm.model': model },
    );
  }

  private async completeInner(actor: AuthUser, p: LlmProvider, key: string, model: string, messages: LlmMessage[], tools: any[], webSearch = false): Promise<LlmMessage> {
    const base = this.baseUrl(p);
    if (!base) throw new Error('Provider has no base URL.');
    if (!model) throw new Error('Conversation has no model.');

    if (p.type === 'anthropic') {
      const systemText = textFromContent(messages.find((m) => m.role === 'system')?.content);
      const body: Record<string, unknown> = { model, max_tokens: ANTHROPIC_MAX_TOKENS, messages: toAnthropicMessages(messages) };
      // Let Claude reason before it answers. This is the single biggest difference between a Kravn chat and
      // claude.ai on the same model: without it the model answers from its first guess (e.g. inventing a
      // service name instead of listing what exists), and between tool rounds it never revises its plan.
      const thinking = anthropicThinking(model, ANTHROPIC_MAX_TOKENS);
      if (thinking) body.thinking = thinking;
      // Prompt caching: cache the STABLE prefix — the system prompt (which for a Project carries the injected
      // instructions + documents) and the tool schemas. Anthropic caching is NOT automatic (unlike OpenAI), so
      // without this Kravn pays full input price on every turn AND on every iteration of the tool-call loop
      // below (each iteration re-sends the same tools+system). With it, those repeats read at ~0.1x. The prefix
      // is byte-stable within a conversation (same VS tools + same project context); below the model's minimum
      // cacheable size it simply no-ops. `cache_control` is GA — no beta header needed.
      if (systemText) {
        body.system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
      }
      const anthTools: any[] = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
      // Native web search: Anthropic's server-side tool. It runs at Anthropic (no Kravn tool loop needed) and
      // the model weaves cited results into its answer. Requires no provider config beyond the API key.
      if (webSearch) anthTools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
      if (anthTools.length) {
        anthTools[anthTools.length - 1].cache_control = { type: 'ephemeral' }; // breakpoint on the last (tools render first)
        body.tools = anthTools;
      }
      const res = await safeFetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      }, ANTHROPIC_TIMEOUT_MS);
      if (!res.ok) throw new Error(`LLM error HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data: any = await res.json();
      const u = data.usage ?? {};
      void this.usage.meterTokens({ id: actor.id }, model, Number(u.input_tokens) || 0, Number(u.output_tokens) || 0);
      if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
        this.log.debug(
          { cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, input: u.input_tokens ?? 0 },
          'anthropic prompt cache',
        );
      }
      const blocks: any[] = Array.isArray(data.content) ? data.content : [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const tool_calls = toolUses.length
        ? toolUses.map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }))
        : undefined;
      // Carried back verbatim, never read: we don't render the reasoning, but the tool loop must replay these
      // exact blocks (signature included, empty text included) on the next round. See LlmMessage.reasoning.
      const reasoning = blocks.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
      return { role: 'assistant', content: text, tool_calls, reasoning: reasoning.length ? reasoning : undefined };
    }

    if (p.type === 'gemini') {
      // Google Generative Language API: system goes in systemInstruction; assistant role is 'model'.
      // Gemini vision (inlineData) is a follow-up; images are dropped here and the model sees text only.
      const system = textFromContent(messages.find((m) => m.role === 'system')?.content);
      const contents = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: textFromContent(m.content) }] }));
      // Budget generously: Gemini 2.5 "thinking" models spend output tokens on reasoning before any
      // visible text, so a small cap can return MAX_TOKENS with no parts.
      const body: Record<string, unknown> = { contents, generationConfig: { maxOutputTokens: 8192 } };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      // Native web search = grounding with Google Search (Gemini 2.x). Runs server-side; the answer text
      // carries the grounded result. (Older 1.5 models use google_search_retrieval; 2.x uses google_search.)
      if (webSearch) body.tools = [{ google_search: {} }];
      const res = await safeFetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, 60_000);
      if (!res.ok) throw new Error(`LLM error HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data: any = await res.json();
      const um = data.usageMetadata ?? {};
      void this.usage.meterTokens({ id: actor.id }, model, Number(um.promptTokenCount) || 0, Number(um.candidatesTokenCount) || 0);
      const cand = data.candidates?.[0];
      const parts = cand?.content?.parts;
      let text = Array.isArray(parts) ? parts.map((p: any) => p.text ?? '').join('') : '';
      if (!text && cand?.finishReason === 'MAX_TOKENS') {
        text = '(no visible output — the model spent its whole token budget on reasoning; raise the limit or use a non-thinking model)';
      }
      return { role: 'assistant', content: text };
    }

    // OpenAI-compatible (openai / openai-compatible / ollama / azure)
    const isAzure = p.type === 'azure-openai';
    const url = isAzure
      ? `${base}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-06-01`
      : `${base}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (isAzure) headers['api-key'] = key;
    else if (key) headers.Authorization = `Bearer ${key}`;

    const body: any = { model, messages: toOpenAiMessages(messages) };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    // Native web search via Chat Completions requires a search-enabled model (e.g. gpt-4o-search-preview);
    // OpenAI runs the search server-side and returns cited results. On a non-search model OpenAI returns a
    // clear error, which surfaces to the user (only enabled when the user turns web search on for this chat).
    if (webSearch && (p.type === 'openai' || p.type === 'azure-openai' || p.type === 'openai-compatible')) {
      body.web_search_options = {};
    }
    const res = await safeFetch(url, { method: 'POST', headers, body: JSON.stringify(body) }, 60_000);
    if (!res.ok) throw new Error(`LLM error HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    const uo = data.usage ?? {};
    void this.usage.meterTokens({ id: actor.id }, model, Number(uo.prompt_tokens) || 0, Number(uo.completion_tokens) || 0);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('LLM returned no message.');
    return { role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls };
  }
}

function textOf(msg: LlmMessage): string {
  return typeof msg.content === 'string' ? msg.content : '';
}

/** The model's own reasoning for a round, as readable text — what a streaming client shows while it waits.
 *  Empty unless the provider returned it: only Anthropic populates `reasoning`, and only a summary (the raw
 *  chain of thought is never exposed), so this is a progress signal, never part of the answer. */
function thinkingTextOf(msg: LlmMessage): string {
  return (msg.reasoning ?? [])
    .map((b) => (typeof (b as { thinking?: unknown }).thinking === 'string' ? (b as { thinking: string }).thinking : ''))
    .join('')
    .trim();
}

function safeParseArgs(s: string | undefined): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

/** Anthropic user content: a plain string stays a string; a block array maps image blocks to base64 sources. */
function toAnthropicUserContent(c: string | LlmContentBlock[] | null): unknown {
  if (!Array.isArray(c)) return c ?? '';
  return c.map((b) =>
    b.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: b.mime, data: b.b64 } }
      : { type: 'text', text: b.text },
  );
}

/** OpenAI-family messages: convert any block-array content (image → an image_url data URI). */
function toOpenAiMessages(messages: LlmMessage[]): unknown[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const content = m.content.map((b) =>
      b.type === 'image'
        ? { type: 'image_url', image_url: { url: `data:${b.mime};base64,${b.b64}` } }
        : { type: 'text', text: b.text },
    );
    return { ...m, content };
  });
}

/**
 * The `thinking` parameter for a Claude model — the switch that lets it reason before answering (what makes
 * claude.ai visibly "work through" a problem instead of replying from the first thing it sees).
 *
 * The shape is model-dependent and a WRONG shape is a hard 400, not a downgrade. Since the operator types the
 * model id free-form, this is an ALLOWLIST: an id we can't place gets no `thinking` at all (today's behavior)
 * rather than a guess that would break the chat.
 *  - Claude 4.6 and later (including Sonnet 5 and Fable/Mythos 5): `adaptive` is the only accepted "on" mode —
 *    Claude sizes its own reasoning per turn. The older `budget_tokens` form is REJECTED on Opus 4.8/4.7,
 *    Sonnet 5 and Fable 5, and deprecated on 4.6, so it must never be sent here.
 *  - Claude 3.7 through 4.5: only the older fixed-budget form exists. `budget_tokens` must be under
 *    `max_tokens` (minimum 1024); it is not a floor, so half the output budget leaves room for the answer.
 *  - Claude 3.5 and older: no thinking support at all.
 */
function anthropicThinking(model: string, maxTokens: number): Record<string, unknown> | undefined {
  const m = model.toLowerCase();
  if (/(opus|sonnet)-4-[678]|sonnet-5|fable-5|mythos/.test(m)) {
    // We SHOW the reasoning while the turn runs, so it has to come back readable. `display` defaults to
    // 'omitted' on Opus 4.7+/Sonnet 5/Fable 5 (the blocks arrive with empty text) but already defaults to
    // 'summarized' on 4.6 — where the field is newer than the model and may not be accepted. So ask for it
    // only where the default is wrong, and let 4.6 alone.
    const omitsByDefault = /opus-4-[78]|sonnet-5|fable-5|mythos/.test(m);
    return omitsByDefault ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' };
  }
  if (/(opus|sonnet|haiku)-4-[015]|(opus|sonnet)-4-2025|3-7-sonnet/.test(m)) {
    return { type: 'enabled', budget_tokens: Math.max(1024, Math.floor(maxTokens / 2)) };
  }
  return undefined;
}

/**
 * Translate the internal OpenAI-shaped message array into Anthropic's content-block format,
 * mapping assistant tool_calls → tool_use blocks and tool results → tool_result blocks (grouped
 * into the user turn that must immediately follow an assistant tool_use).
 */
function toAnthropicMessages(messages: LlmMessage[]): { role: string; content: unknown }[] {
  const out: { role: string; content: any }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: toAnthropicUserContent(m.content) });
    } else if (m.role === 'assistant') {
      // Thinking blocks first — Anthropic requires an assistant turn to LEAD with them (they precede the
      // lastmost tool_use/tool_result set), and requires them byte-identical to what it sent.
      const content: any[] = [...(m.reasoning ?? [])];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: safeParseArgs(tc.function?.arguments) });
      }
      out.push({ role: 'assistant', content: content.length ? content : '' });
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

/** Render named text blocks under a total character budget; over-budget items are noted, not dropped silently. */
function renderWithBudget(items: { name: string; text: string }[], budget: number): string {
  if (items.length === 0) return '';
  let remaining = budget;
  const rendered: string[] = [];
  for (const it of items) {
    const piece = `# ${it.name}\n${it.text}`;
    if (piece.length > remaining) {
      rendered.push(`# ${it.name}\n[omitted — context budget exceeded]`);
      continue;
    }
    rendered.push(piece);
    remaining -= piece.length;
  }
  return rendered.join('\n\n---\n\n');
}
