import { z } from 'zod';
import { roleSchema } from './permissions.js';

// ─── Upstream MCP server (Kravn connects to these as an MCP CLIENT) ──────────────────────────────

export const TRANSPORTS = ['streamable-http', 'sse', 'stdio', 'plugin'] as const;
export type Transport = (typeof TRANSPORTS)[number];
export const transportSchema = z.enum(TRANSPORTS);

export const AUTH_TYPES = ['none', 'bearer', 'basic'] as const;
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
  anthropic: [
    'claude-opus-4-1',
    'claude-opus-4',
    'claude-sonnet-4-5',
    'claude-sonnet-4',
    'claude-3-7-sonnet-latest',
    'claude-3-5-haiku-latest',
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

export const chatProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  /** Project-level system instructions, prepended to every chat started in the project. */
  instructions: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatProject = z.infer<typeof chatProjectSchema>;

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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatConversation = z.infer<typeof chatConversationSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: chatRoleSchema,
  content: z.string().default(''),
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
