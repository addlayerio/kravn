import { z } from 'zod';
import { roleSchema } from './permissions.js';

// ─── Upstream MCP server (Kravn connects to these as an MCP CLIENT) ──────────────────────────────

// 'a2a' = a remote Agent2Agent agent: Kravn fetches its Agent Card and bridges its skills into the
// registry as tools, so any MCP/chat consumer can delegate a task to it under the same governance.
export const TRANSPORTS = ['streamable-http', 'sse', 'stdio', 'plugin', 'a2a'] as const;
export type Transport = (typeof TRANSPORTS)[number];
export const transportSchema = z.enum(TRANSPORTS);

export const AUTH_TYPES = ['none', 'bearer', 'basic', 'oauth'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];
export const authTypeSchema = z.enum(AUTH_TYPES);

export const SERVER_STATUS = ['unknown', 'connecting', 'online', 'offline', 'error', 'disabled'] as const;
export type ServerStatus = (typeof SERVER_STATUS)[number];

export const upstreamServerSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  slug: z.string(),
  description: z.string().default(''),
  transport: transportSchema,
  /** For http/sse transports. */
  url: z.string().default(''),
  /** For stdio transport. */
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  headers: z.record(z.string()).default({}),
  authType: authTypeSchema.default('none'),
  /** Stored encrypted at rest; never returned to clients in plaintext. */
  authValueSet: z.boolean().default(false),
  /** Custom CA bundle (PEM) to trust for this upstream — for internal/self-signed TLS. */
  tlsCa: z.string().default(''),
  /** Client certificate (PEM) for mutual TLS. */
  tlsClientCert: z.string().default(''),
  /** mTLS client private key is stored encrypted at rest; never returned in plaintext. */
  tlsClientKeySet: z.boolean().default(false),
  enabled: z.boolean().default(true),
  status: z.enum(SERVER_STATUS).default('unknown'),
  lastError: z.string().default(''),
  lastSeenAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UpstreamServer = z.infer<typeof upstreamServerSchema>;

// ─── Registry entities discovered from / exposed by servers ──────────────────────────────────────

export const toolSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  name: z.string(),
  description: z.string().default(''),
  inputSchema: z.unknown().default({}),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Tool = z.infer<typeof toolSchema>;

export const resourceSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  uri: z.string(),
  name: z.string().default(''),
  description: z.string().default(''),
  mimeType: z.string().default(''),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Resource = z.infer<typeof resourceSchema>;

export const promptSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  name: z.string(),
  description: z.string().default(''),
  arguments: z.unknown().default([]),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Prompt = z.infer<typeof promptSchema>;

// ─── Virtual server (compose tools/resources/prompts from many upstreams into one MCP endpoint) ───

/**
 * Per-mcp-endpoint access policy (authorization, NOT a second login):
 *  - public:        anyone can call the endpoint (no auth)
 *  - authenticated: any signed-in Kravn user
 *  - restricted:    only users whose role is in allowedRoles
 */
export const VS_ACCESS = ['public', 'authenticated', 'restricted'] as const;
export type VsAccess = (typeof VS_ACCESS)[number];
export const vsAccessSchema = z.enum(VS_ACCESS);

export const mcpEndpointSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  slug: z.string(),
  description: z.string().default(''),
  toolIds: z.array(z.string()).default([]),
  resourceIds: z.array(z.string()).default([]),
  promptIds: z.array(z.string()).default([]),
  access: vsAccessSchema.default('authenticated'),
  allowedRoles: z.array(roleSchema).default([]),
  /** When access='restricted', members of these teams are also allowed. */
  allowedTeams: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type McpEndpoint = z.infer<typeof mcpEndpointSchema>;

// ─── Teams ─────────────────────────────────────────────────────────────────────────────────────────

export const TEAM_ROLES = ['owner', 'member'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const teamRoleSchema = z.enum(TEAM_ROLES);

export const teamSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  slug: z.string(),
  description: z.string().default(''),
  memberCount: z.number().int().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Team = z.infer<typeof teamSchema>;

export const teamMemberSchema = z.object({
  teamId: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string().default(''),
  role: teamRoleSchema,
  joinedAt: z.string(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

// ─── LLM providers / models ────────────────────────────────────────────────────────────────────────

export const LLM_PROVIDER_TYPES = ['openai', 'anthropic', 'gemini', 'azure-openai', 'ollama', 'openai-compatible'] as const;
export type LlmProviderType = (typeof LLM_PROVIDER_TYPES)[number];
export const llmProviderTypeSchema = z.enum(LLM_PROVIDER_TYPES);

/**
 * Curated, offline fallback list of well-known model ids per provider, shown as a multiselect so
 * users don't have to research model codes. The live "discover" endpoint refines this from the
 * provider's own API when a key is available; this list is what we show without one.
 */
export const LLM_MODEL_CATALOG: Record<LlmProviderType, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o4-mini'],
  // Best-first, and every one of these is current: the previous list had four models Anthropic has since
  // RETIRED (they answer 404, not a downgrade) and not one from the 4.6+ family, which is the only place
  // adaptive thinking works — so the catalog was steering people onto dead or thinking-less models.
  anthropic: [
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  'azure-openai': ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
  ollama: ['llama3.1', 'llama3.2', 'qwen2.5', 'mistral', 'phi3'],
  'openai-compatible': [],
};

export const LLM_STATUS = ['unknown', 'ok', 'error'] as const;

export const llmProviderSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  type: llmProviderTypeSchema,
  /** API base URL; empty means use the well-known default for the type. */
  baseUrl: z.string().default(''),
  /** Stored encrypted at rest; never returned. */
  apiKeySet: z.boolean().default(false),
  defaultModel: z.string().default(''),
  /** Model ids exposed by this provider. */
  models: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  status: z.enum(LLM_STATUS).default('unknown'),
  lastError: z.string().default(''),
  lastTestedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LlmProvider = z.infer<typeof llmProviderSchema>;

// ─── Users ───────────────────────────────────────────────────────────────────────────────────────

// ─── Local (Kravn-authored) prompts ──────────────────────────────────────────────────────────────

export const PROMPT_ROLES = ['user', 'assistant', 'system'] as const;
export type PromptRole = (typeof PROMPT_ROLES)[number];
export const promptRoleSchema = z.enum(PROMPT_ROLES);

export const localPromptArgumentSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().default(''),
  required: z.boolean().default(false),
});
export type LocalPromptArgument = z.infer<typeof localPromptArgumentSchema>;

export const localPromptSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().default(''),
  /** Jinja2-compatible (nunjucks) template; arguments are available as variables. */
  template: z.string(),
  arguments: z.array(localPromptArgumentSchema).default([]),
  role: promptRoleSchema.default('user'),
  enabled: z.boolean().default(true),
  version: z.number().int().default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LocalPrompt = z.infer<typeof localPromptSchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().default(''),
  role: roleSchema,
  /** A disabled user cannot log in and any existing session is rejected (used for deactivation / SCIM). */
  disabled: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

// ─── Chat (end-user client) ──────────────────────────────────────────────────────────────────────

export const CHAT_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];
export const chatRoleSchema = z.enum(CHAT_ROLES);

export const projectRoleSchema = z.enum(['owner', 'editor', 'viewer']);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

export const chatProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  /** Project-level system instructions, prepended to every chat started in the project. */
  instructions: z.string().default(''),
  /** Optional model a new chat in this project starts on (empty = the user picks per chat). Provider comes with
   *  it via the chat's provider selection; this only pre-fills the model. */
  defaultModel: z.string().default(''),
  /**
   * Registry tool IDs curated for this project (a subset the owner picked from the tools they are entitled to,
   * possibly spanning several MCP endpoints). A chat/scheduled task in the project offers EXACTLY these tools —
   * always re-checked against the caller's live entitlement at run time, so this is a filter, never a grant.
   * Empty = the project pins no tools (chats fall back to their own MCP-endpoint selection).
   */
  toolIds: z.array(z.string()).default([]),
  /** The CALLER's access to this project: `owner` (created it) or `editor`/`viewer` (shared with them). */
  access: projectRoleSchema.optional(),
  /** Email of the owner — set on projects shared WITH the caller, so the UI can show "shared by …". */
  ownerEmail: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatProject = z.infer<typeof chatProjectSchema>;

/** A user a project has been shared with (owner is `chat_projects.user_id`, never a member row). */
export const projectMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  role: z.enum(['editor', 'viewer']),
});
export type ProjectMember = z.infer<typeof projectMemberSchema>;

/** A document attached to a project; its text is injected into the model context at chat time. */
export const chatProjectDocumentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string().min(1).max(200),
  /** Character length of the document content (for UI; content itself is fetched on demand). */
  size: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
});
export type ChatProjectDocument = z.infer<typeof chatProjectDocumentSchema>;

export const chatConversationSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable().default(null),
  title: z.string().default('New chat'),
  providerId: z.string().default(''),
  model: z.string().default(''),
  /** Optional: which virtual server's tools this chat may call. */
  vserverSlug: z.string().default(''),
  /** Free-form labels used to organise / filter chats (folders & tags). */
  tags: z.array(z.string()).default([]),
  /** Optional: the org Agent this chat was started from (its instructions + tools resolve live per turn,
   *  re-validated against the caller's entitlement). */
  agentId: z.string().nullable().default(null),
  /**
   * Set when an automation produced this conversation. Such chats are listed under that automation's run
   * history instead of the user's Chats — a rule that fires a hundred times would otherwise bury everything
   * the person actually started.
   *
   * Cleared the moment the user sends their own message into it: replying is how you adopt the conversation,
   * and from then on it is an ordinary chat of theirs.
   */
  automationId: z.string().nullable().default(null),
  /** Pinned chats sort to the top of the list. */
  pinned: z.boolean().default(false),
  /** Archived chats are hidden from the main list (shown under "Archived"). */
  archived: z.boolean().default(false),
  /** When on, the provider's native web search is offered to the model (Claude/Gemini/OpenAI search). */
  webSearch: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatConversation = z.infer<typeof chatConversationSchema>;

/**
 * An **automation**: an agent + an instruction, started by a trigger instead of a person. The run happens in a
 * new conversation owned by the automation's creator, with that user's tool access — so permissions and audit
 * are identical to the same person typing the prompt in chat.
 *
 * Triggers (`kind`):
 *  - `cron` / `once` — by time (the scheduler ticks and claims due fires).
 *  - `event`         — by an inbound webhook at `/api/hooks/:eventToken`. Never fires by time, so `nextRunAt`
 *                      stays null and the scheduler's due-query skips it.
 */
export const automationKindSchema = z.enum(['cron', 'once', 'event']);
export type AutomationKind = z.infer<typeof automationKindSchema>;

/** How an inbound webhook proves it's genuine. `none` relies on the unguessable token in the URL alone. */
export const automationAuthSchema = z.enum(['none', 'secret', 'hmac']);
export type AutomationAuth = z.infer<typeof automationAuthSchema>;

export const chatAutomationSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string().default(''),
  providerId: z.string().default(''),
  model: z.string().default(''),
  vserverSlug: z.string().default(''),
  projectId: z.string().nullable().default(null),
  /** Optional org Agent to run this task as (its instructions + tool filter apply, entitlement re-checked live). */
  agentId: z.string().nullable().default(null),
  kind: automationKindSchema,
  /** Cron expression (5-field), for kind='cron'. */
  cron: z.string().default(''),
  /** ISO datetime, for kind='once'. */
  runAt: z.string().default(''),
  timezone: z.string().default('UTC'),
  enabled: z.boolean().default(true),

  // ── kind='event' (inbound webhook) ────────────────────────────────────────
  /** Unguessable URL segment: POST /api/hooks/{eventToken}. Rotating it revokes every sender at once. */
  eventToken: z.string().default(''),
  /** How the sender authenticates. The secret itself is never returned by the API (write-only). */
  eventAuth: automationAuthSchema.default('none'),
  /** True when a secret is stored — lets the UI say "configured" without ever reading it back. */
  hasEventSecret: z.boolean().default(false),
  /**
   * Turns the payload into the run's prompt. `{{ path.to.field }}` placeholders resolve against the JSON body
   * (`{{ payload }}` = the whole thing, truncated). Empty = the automation's own `prompt` plus the raw payload.
   */
  payloadTemplate: z.string().default(''),
  /**
   * Optional gate, one `path=value` condition per line — ALL must match or the delivery is acknowledged and
   * dropped. This is what narrows one URL down to the events you actually care about (e.g. `event.type=created`).
   */
  eventFilter: z.string().default(''),
  /** Runaway/loop backstop: deliveries past this many runs in a rolling hour are rejected (429). 0 = unlimited. */
  maxRunsPerHour: z.number().int().min(0).max(10_000).default(60),

  /** Next fire time (ISO); null = will never run again (bad cron, a past one-shot, or an event automation). */
  nextRunAt: z.string().nullable().default(null),
  lastRunAt: z.string().nullable().default(null),
  lastStatus: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  lastConversationId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatAutomation = z.infer<typeof chatAutomationSchema>;

/**
 * One inbound webhook delivery, kept whatever became of it — accepted, filtered out, rejected by the ceiling.
 *
 * This exists so configuring an event automation stops being guesswork. You cannot write a filter or a template
 * for a payload you have never seen, and you cannot see one until the sender has fired at least once. Keeping
 * the last few deliveries turns that around: point the sender at the URL, do one action, and then build the
 * rule against the JSON that actually arrived. It doubles as the answer to "why didn't my automation run".
 */
export const automationDeliverySchema = z.object({
  id: z.string(),
  automationId: z.string(),
  receivedAt: z.string(),
  /** 'accepted' | 'filtered' | 'disabled' | 'rate_limited' — what the ingress did with it. */
  outcome: z.string(),
  /** For 'filtered', the condition that failed — the direct answer to "why was this dropped". */
  reason: z.string().nullable().default(null),
  /** The JSON body as received (pretty-printed, truncated if huge). Empty when it wasn't JSON. */
  payload: z.string().default(''),
  /** True when the body was too large to keep in full, so the UI can say the tree is partial. */
  truncated: z.boolean().default(false),
});
export type AutomationDelivery = z.infer<typeof automationDeliverySchema>;

/** One execution of an automation. Event automations fire far more often than `last*` fields can describe. */
export const automationRunSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  /** What started it: 'cron' | 'once' | 'event' | 'manual' (a user pressing Run). */
  trigger: z.string(),
  status: z.string(),
  error: z.string().nullable().default(null),
  conversationId: z.string().nullable().default(null),
  startedAt: z.string(),
  finishedAt: z.string().nullable().default(null),
});
export type AutomationRun = z.infer<typeof automationRunSchema>;

/** A user's personal, reusable prompt template (their own library — beyond any admin/MCP-provided prompts). */
export const chatUserPromptSchema = z.object({
  id: z.string(),
  name: z.string(),
  content: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatUserPrompt = z.infer<typeof chatUserPromptSchema>;

/** A durable per-user fact the assistant is told at the start of every chat. */
export const chatMemorySchema = z.object({
  id: z.string(),
  content: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatMemory = z.infer<typeof chatMemorySchema>;

/** How an org Agent is exposed to users. Mirrors the MCP-endpoint access model (no `public` — an Agent is
 *  always used by a signed-in Kravn user). `restricted` limits use to `allowedTeams` ∪ `allowedUsers`. */
export const AGENT_ACCESS = ['authenticated', 'restricted'] as const;
export type AgentAccess = (typeof AGENT_ACCESS)[number];
export const agentAccessSchema = z.enum(AGENT_ACCESS);

/**
 * An organization-level **Agent**: a named, reusable chat preset (instructions + model + a cross-endpoint set
 * of tools) defined by an admin in the operator and made available to chosen users/teams. It is the org-scoped
 * successor to the personal assistant preset. Like a project's tools, `toolIds` is a FILTER over what the
 * consuming user is already entitled to — never a grant; entitlement is re-checked live at chat time, and the
 * tool always executes against its own origin server under the global pipeline (never the MCP data plane).
 */
export const chatAgentSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  description: z.string().default(''),
  /** System instructions injected (live) into every chat started from this agent. */
  instructions: z.string().default(''),
  providerId: z.string().default(''),
  model: z.string().default(''),
  toolIds: z.array(z.string()).default([]),
  access: agentAccessSchema.default('restricted'),
  /** When access='restricted', members of these teams may use the agent. */
  allowedTeams: z.array(z.string()).default([]),
  /** When access='restricted', these specific users (by id) may use the agent. */
  allowedUsers: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatAgent = z.infer<typeof chatAgentSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: chatRoleSchema,
  content: z.string().default(''),
  /**
   * What the LLM actually received for this message, when the `onChatInput` DLP pipeline transformed it
   * (e.g. a CUIT/PII value tokenized). Absent → the model saw `content` verbatim. `content` is always the
   * user's original text (what they see); `modelContent` is the redacted copy that reached the model.
   */
  modelContent: z.string().optional(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const CHAT_ATTACHMENT_KINDS = ['pdf', 'document', 'spreadsheet', 'text', 'other'] as const;
export type ChatAttachmentKind = (typeof CHAT_ATTACHMENT_KINDS)[number];

/** A file uploaded into a conversation; its text is injected into the model context. Metadata only — no bytes. */
export const chatAttachmentSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  messageId: z.string().nullable().default(null),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  kind: z.enum(CHAT_ATTACHMENT_KINDS),
  /** Character length of the extracted text (0 if nothing could be extracted). */
  textChars: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
});
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;
