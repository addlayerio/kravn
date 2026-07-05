import { type ChatConversation, type ChatMessage, type ChatAttachmentKind, type LlmProvider } from '@kravn/contracts';
import { newId, type Encryptor } from '../crypto.js';
import { canConsumeMcpEndpoint } from '../mcp/endpoint-access.js';
import { safeFetch } from '../http/client.js';
import { withSpan } from '../otel.js';
import type { Repos } from '../db/repos.js';
import type { RegistryService } from '../mcp/registry.service.js';
import type { PluginManager } from '../plugins/manager.js';
import { CODE_INTERPRETER_ID, INTERPRETER_TOOL_NAME } from '../plugins/native.js';
import type { AuthUser } from '../auth/auth.service.js';
import type { Logger } from 'pino';

/** Server id the registry assigns to a plugin-backed MCP server (see RegistryService.syncPluginServers). */
const PLUGIN_SERVER_PREFIX = 'plg_';

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

const MAX_TOOL_ROUNDS = 6;

interface LlmMessage {
  role: string;
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export class ChatService {
  constructor(
    private repos: Repos,
    private encryptor: Encryptor,
    private registry: RegistryService,
    private log: Logger,
    private plugins: PluginManager,
  ) {}

  /** Send a user message and produce the assistant reply (running tools when the model asks). */
  async send(actor: AuthUser, conversationId: string, content: string, attachmentIds: string[] = []): Promise<ChatMessage> {
    const conv = await this.repos.chat.getConversation(actor.id, conversationId);
    if (!conv) throw new Error('Conversation not found.');

    const provider = await this.repos.llmProviders.getById(conv.providerId);
    if (!provider) throw new Error('The conversation has no valid LLM provider.');
    const key = this.encryptor.decrypt(await this.repos.llmProviders.getApiKeyEncrypted(conv.providerId));

    const userMsg = await this.repos.chat.addMessage(newId(), conversationId, 'user', content);
    // Attach any uploaded files to this turn's user message (so they show in the thread + feed context).
    if (attachmentIds.length) {
      await this.repos.chat.linkAttachmentsToMessage(actor.id, conversationId, userMsg.id, attachmentIds);
    }
    // First message becomes the title.
    const existing = await this.repos.chat.listMessages(conversationId);
    if (existing.filter((m) => m.role === 'user').length === 1) {
      await this.repos.chat.touchConversation(conversationId, content.slice(0, 60));
    }

    // Tool-calling is wired for OpenAI-family and Anthropic. Gemini still runs plain for now.
    const supportsTools = provider.type !== 'gemini';

    const { tools, toolIndex } = await this.resolveTools(actor, conv);
    // The code interpreter is a native PLUGIN; when enabled, auto-offer its registry tools (it's also
    // composable into virtual servers like any mcp-server plugin). No special-casing of execution.
    const interpreterOn = supportsTools && this.plugins.isEnabled(CODE_INTERPRETER_ID);
    if (interpreterOn) {
      await this.addPluginServerTools(`${PLUGIN_SERVER_PREFIX}${CODE_INTERPRETER_ID}`, tools, toolIndex);
    }

    const history = await this.repos.chat.listMessages(conversationId);
    const messages: LlmMessage[] = [
      // Only advertise the run_python guidance when the interpreter is actually offered this turn.
      { role: 'system', content: await this.buildSystemPrompt(actor, conv, interpreterOn) },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    // The per-turn file workspace handed to file-aware tools (e.g. the interpreter), and the output
    // files those tools produce (persisted as downloadable attachments on the assistant message).
    const workspaceFiles = await this.repos.chat.getAttachmentFiles(actor.id, conversationId);
    const producedAttachmentIds: string[] = [];
    let finalText = '';

    if (!supportsTools || tools.length === 0) {
      // Plain completion (no tool loop).
      const msg = await this.complete(provider, key, conv.model, messages, []);
      finalText = textOf(msg);
    } else {
      // Provider-agnostic tool loop (complete() normalizes OpenAI / Anthropic tool formats).
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const msg = await this.complete(provider, key, conv.model, messages, tools);
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          finalText = textOf(msg);
          break;
        }
        // Don't execute the final round's tools — their results could never be fed back to the model.
        if (round === MAX_TOOL_ROUNDS - 1) {
          finalText = textOf(msg).trim() || '(stopped: the assistant kept requesting tools past the limit)';
          break;
        }
        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
        for (const call of msg.tool_calls) {
          const name = call.function?.name;
          let args: Record<string, unknown> = {};
          try {
            args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            /* ignore bad args */
          }
          let resultText: string;
          try {
            const toolId = toolIndex.get(name);
            if (!toolId) throw new Error(`unknown tool ${name}`);
            const result = await this.registry.invokeTool(toolId, args, actor, { files: workspaceFiles });
            // Only honor result `files` (→ downloadable attachments) from in-process plugin tools, never
            // from remote MCP upstreams (toolId `tl_plg_…` ⇒ plugin server). See review F1.
            const trusted = toolId.startsWith('tl_plg_');
            resultText = await this.persistToolFiles(actor, conversationId, result, producedAttachmentIds, trusted);
          } catch (err) {
            resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
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

  /** Add an enabled plugin server's registry tools to the chat tool list (deduped), routed via registry.invokeTool. */
  private async addPluginServerTools(serverId: string, tools: any[], toolIndex: Map<string, string>): Promise<void> {
    for (const t of await this.repos.registry.listToolsByServer(serverId)) {
      if (!t.enabled || toolIndex.has(t.name)) continue;
      toolIndex.set(t.name, t.id);
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

  private async buildSystemPrompt(actor: AuthUser, conv: ChatConversation, canRunCode = false): Promise<string> {
    const parts = ['You are Kravn, a helpful corporate AI assistant. Use the available tools when relevant.'];

    // Project context (only if the project belongs to this user — loading a foreign project's
    // documents would leak another tenant's data into the prompt).
    if (conv.projectId) {
      const project = await this.repos.chat.getProject(actor.id, conv.projectId);
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

  private async resolveTools(actor: AuthUser, conv: ChatConversation) {
    const tools: any[] = [];
    const toolIndex = new Map<string, string>();
    if (!conv.vserverSlug) return { tools, toolIndex };

    const vs = await this.repos.mcpEndpoints.getBySlug(conv.vserverSlug);
    if (!vs || !vs.enabled) return { tools, toolIndex };

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
      toolIndex.set(t.name, t.id);
      tools.push({
        type: 'function',
        function: { name: t.name, description: t.description || undefined, parameters: t.inputSchema ?? { type: 'object', properties: {} } },
      });
    }
    return { tools, toolIndex };
  }

  // ─── LLM call (OpenAI-compatible + Anthropic) ──────────────────────────────────────────────────

  private baseUrl(p: LlmProvider): string {
    return (p.baseUrl || DEFAULT_BASE[p.type] || '').replace(/\/$/, '');
  }

  private complete(p: LlmProvider, key: string, model: string, messages: LlmMessage[], tools: any[]): Promise<LlmMessage> {
    return withSpan(
      `llm.chat ${p.type}`,
      () => this.completeInner(p, key, model, messages, tools),
      { 'llm.provider': p.type, 'llm.model': model },
    );
  }

  private async completeInner(p: LlmProvider, key: string, model: string, messages: LlmMessage[], tools: any[]): Promise<LlmMessage> {
    const base = this.baseUrl(p);
    if (!base) throw new Error('Provider has no base URL.');
    if (!model) throw new Error('Conversation has no model.');

    if (p.type === 'anthropic') {
      const systemText = messages.find((m) => m.role === 'system')?.content ?? '';
      const body: Record<string, unknown> = { model, max_tokens: 4096, messages: toAnthropicMessages(messages) };
      // Prompt caching: cache the STABLE prefix — the system prompt (which for a Project carries the injected
      // instructions + documents) and the tool schemas. Anthropic caching is NOT automatic (unlike OpenAI), so
      // without this Kravn pays full input price on every turn AND on every iteration of the tool-call loop
      // below (each iteration re-sends the same tools+system). With it, those repeats read at ~0.1x. The prefix
      // is byte-stable within a conversation (same VS tools + same project context); below the model's minimum
      // cacheable size it simply no-ops. `cache_control` is GA — no beta header needed.
      if (systemText) {
        body.system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
      }
      if (tools.length) {
        const mapped: any[] = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
        mapped[mapped.length - 1].cache_control = { type: 'ephemeral' }; // breakpoint on the last (tools render first)
        body.tools = mapped;
      }
      const res = await safeFetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      }, 60_000);
      if (!res.ok) throw new Error(`LLM error HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data: any = await res.json();
      const u = data.usage ?? {};
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
      return { role: 'assistant', content: text, tool_calls };
    }

    if (p.type === 'gemini') {
      // Google Generative Language API: system goes in systemInstruction; assistant role is 'model'.
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const contents = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content ?? '' }] }));
      // Budget generously: Gemini 2.5 "thinking" models spend output tokens on reasoning before any
      // visible text, so a small cap can return MAX_TOKENS with no parts.
      const body: Record<string, unknown> = { contents, generationConfig: { maxOutputTokens: 8192 } };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const res = await safeFetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, 60_000);
      if (!res.ok) throw new Error(`LLM error HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data: any = await res.json();
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

    const body: any = { model, messages };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const res = await safeFetch(url, { method: 'POST', headers, body: JSON.stringify(body) }, 60_000);
    if (!res.ok) throw new Error(`LLM error HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('LLM returned no message.');
    return { role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls };
  }
}

function textOf(msg: LlmMessage): string {
  return typeof msg.content === 'string' ? msg.content : '';
}

function safeParseArgs(s: string | undefined): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
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
      out.push({ role: 'user', content: m.content ?? '' });
    } else if (m.role === 'assistant') {
      const content: any[] = [];
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
