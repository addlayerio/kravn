import { z } from 'zod';
import { roleSchema } from './permissions.js';
import {
  transportSchema,
  authTypeSchema,
  localPromptArgumentSchema,
  promptRoleSchema,
  vsAccessSchema,
  llmProviderTypeSchema,
  teamRoleSchema,
} from './entities.js';

// ─── Generic API envelope ────────────────────────────────────────────────────────────────────────

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

// ─── Auth / setup ─────────────────────────────────────────────────────────────────────────────────

export const setupRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().max(120).default(''),
  instanceName: z.string().min(1).max(80).optional(),
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const registerRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().max(120).default(''),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    permissions: readonly string[];
    teams?: string[];
  };
}

// ─── Teams ───────────────────────────────────────────────────────────────────────────────────────

export const createTeamSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
});
export type CreateTeamRequest = z.infer<typeof createTeamSchema>;

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
});
export type UpdateTeamRequest = z.infer<typeof updateTeamSchema>;

export const addTeamMemberSchema = z.object({
  userId: z.string().min(1),
  role: teamRoleSchema.default('member'),
});
export type AddTeamMemberRequest = z.infer<typeof addTeamMemberSchema>;

/**
 * Grant/revoke a team's access to a virtual server (MCP), plus the optional per-tool subset.
 *  - granted:false        → the team loses access to this MCP (any tool subset is cleared).
 *  - granted:true, toolIds null/omitted → the team gets the FULL MCP (all its tools).
 *  - granted:true, toolIds [...]        → the team gets ONLY those tools of this MCP.
 */
export const setTeamServerAccessSchema = z.object({
  granted: z.boolean(),
  toolIds: z.array(z.string()).nullable().optional(),
});
export type SetTeamServerAccessRequest = z.infer<typeof setTeamServerAccessSchema>;

// ─── Chat (end-user client) ────────────────────────────────────────────────────────────────────────

export const createChatProjectSchema = z.object({
  name: z.string().min(1).max(120),
  instructions: z.string().max(20_000).optional(),
});
export type CreateChatProjectRequest = z.infer<typeof createChatProjectSchema>;

export const updateChatProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  instructions: z.string().max(20_000).optional(),
});
export type UpdateChatProjectRequest = z.infer<typeof updateChatProjectSchema>;

export const addProjectDocumentSchema = z.object({
  name: z.string().min(1).max(200),
  content: z.string().min(1).max(500_000),
});
export type AddProjectDocumentRequest = z.infer<typeof addProjectDocumentSchema>;

export const createConversationSchema = z.object({
  projectId: z.string().optional(),
  title: z.string().max(200).default('New chat'),
  providerId: z.string().min(1),
  model: z.string().min(1),
  vserverSlug: z.string().default(''),
});
export type CreateConversationRequest = z.infer<typeof createConversationSchema>;

export const postChatMessageSchema = z.object({
  content: z.string().min(1).max(100_000),
  /** Ids of files previously uploaded to this conversation, to attach to this turn's context. */
  attachmentIds: z.array(z.string()).default([]),
});
export type PostChatMessageRequest = z.infer<typeof postChatMessageSchema>;

/** A login method offered to the SPA (no secrets). */
export interface SsoMethod {
  kind: 'oauth' | 'saml';
  id: string;
  label: string;
}

/** Public, unauthenticated boot state used by the SPA to decide setup-vs-login. */
export interface BootstrapInfo {
  instanceName: string;
  version: string;
  setupRequired: boolean;
  publicRegistration: boolean;
  passwordLoginEnabled: boolean;
  ssoMethods: SsoMethod[];
}

/** Aggregated platform state for the dashboard "Architecture Flow" panel. */
export interface PlatformOverview {
  instanceName: string;
  version: string;
  /** INPUTS */
  virtualServers: { total: number; active: number };
  /** GATEWAY middleware */
  plugins: { total: number; enabled: number; byHook: { hook: string; count: number }[] };
  /** OUTPUTS */
  servers: { total: number; online: number };
  tools: { total: number; enabled: number };
  prompts: { total: number; enabled: number };
  resources: { total: number; enabled: number };
  /** INFRASTRUCTURE */
  database: { kind: string; connected: boolean };
}

// ─── SSO / identity provider configuration (GLOBAL: who can log into Kravn) ──────────────────────────

export const oauthProviderSchema = z.object({
  id: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/, 'lowercase letters, numbers and dashes only'),
  label: z.string().min(1).max(60),
  /** OIDC discovery document URL (…/.well-known/openid-configuration). */
  discoveryUrl: z.string().url(),
  clientId: z.string().min(1),
  /** Write-only; omit on update to keep the stored value. */
  clientSecret: z.string().optional(),
  scopes: z.array(z.string()).default(['openid', 'email', 'profile']),
  enabled: z.boolean().default(true),
});
export type OAuthProviderInput = z.infer<typeof oauthProviderSchema>;

export const samlConfigSchema = z.object({
  enabled: z.boolean().default(false),
  label: z.string().max(60).default('SAML'),
  /** IdP SSO URL (SP-initiated redirect target). */
  entryPoint: z.string().default(''),
  /** SP entity ID / issuer (what Kravn presents to the IdP). */
  issuer: z.string().default('kravn'),
  /** IdP entityID — validated against the assertion Issuer when set (from metadata import). */
  idpIssuer: z.string().default(''),
  /** IdP signing certificate (PEM/base64). Write-only; omit to keep stored value. */
  idpCert: z.string().optional(),
  /** Attribute (or 'nameID') carrying the user's email. */
  emailAttribute: z.string().default('email'),
});
export type SamlConfigInput = z.infer<typeof samlConfigSchema>;

/** Import IdP config from an Azure/Entra-style federation metadata URL or pasted XML. */
export const importSamlMetadataSchema = z.object({
  url: z.string().default(''),
  xml: z.string().default(''),
});
export type ImportSamlMetadataRequest = z.infer<typeof importSamlMetadataSchema>;

export interface SamlMetadataResult {
  entityId: string;
  entryPoint: string;
  idpCert: string;
}

export const updateAuthConfigSchema = z.object({
  oauthProviders: z.array(oauthProviderSchema).default([]),
  saml: samlConfigSchema.default({}),
  autoProvision: z.boolean().default(true),
  defaultRole: roleSchema.default('viewer'),
  /**
   * Emails granted the admin role when they sign in via SSO (e.g. an EntraID user that should be the
   * admin). The account is created/promoted to admin even if auto-provisioning is off. Lets you replace
   * the local admin with an SSO identity and run SSO-only. Compared case-insensitively.
   */
  adminEmails: z.array(z.string().email().max(254)).max(50).default([]),
});
export type UpdateAuthConfigRequest = z.infer<typeof updateAuthConfigSchema>;

/** Secret-safe view returned by GET /api/auth/config. */
export interface AuthConfigView {
  oauthProviders: Array<{
    id: string;
    label: string;
    discoveryUrl: string;
    clientId: string;
    clientSecretSet: boolean;
    scopes: string[];
    enabled: boolean;
  }>;
  saml: {
    enabled: boolean;
    label: string;
    entryPoint: string;
    issuer: string;
    idpIssuer: string;
    idpCertSet: boolean;
    emailAttribute: string;
  };
  autoProvision: boolean;
  defaultRole: string;
  adminEmails: string[];
  /** ACS URL the operator must register in their IdP. */
  samlCallbackUrl: string;
}

// ─── Upstream server create/update ─────────────────────────────────────────────────────────────────

export const createServerSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).default(''),
    transport: transportSchema,
    url: z.string().max(2048).default(''),
    command: z.string().max(2000).default(''),
    args: z.array(z.string().max(2000)).max(100).default([]),
    env: z.record(z.string().max(8192)).default({}),
    headers: z.record(z.string().max(8192)).default({}),
    authType: authTypeSchema.default('none'),
    /** Plaintext credential on the way in; encrypted at rest, never read back. */
    authValue: z.string().max(8192).default(''),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.transport === 'stdio') {
      if (!v.command) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'command is required for stdio transport.' });
      }
    } else if (!v.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'url is required for http/sse transport.' });
    }
  });
export type CreateServerRequest = z.infer<typeof createServerSchema>;

export const updateServerSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  url: z.string().max(2048).optional(),
  command: z.string().max(2000).optional(),
  args: z.array(z.string().max(2000)).max(100).optional(),
  env: z.record(z.string().max(8192)).optional(),
  headers: z.record(z.string().max(8192)).optional(),
  authType: authTypeSchema.optional(),
  authValue: z.string().max(8192).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateServerRequest = z.infer<typeof updateServerSchema>;

// ─── Virtual server create/update ──────────────────────────────────────────────────────────────────

export const upsertVirtualServerSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  toolIds: z.array(z.string()).default([]),
  resourceIds: z.array(z.string()).default([]),
  promptIds: z.array(z.string()).default([]),
  access: vsAccessSchema.default('authenticated'),
  allowedRoles: z.array(roleSchema).default([]),
  allowedTeams: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});
export type UpsertVirtualServerRequest = z.infer<typeof upsertVirtualServerSchema>;

// ─── Users ─────────────────────────────────────────────────────────────────────────────────────────

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().max(120).default(''),
  role: roleSchema.default('viewer'),
});
export type CreateUserRequest = z.infer<typeof createUserSchema>;

export const updateUserRoleSchema = z.object({ role: roleSchema });
export type UpdateUserRoleRequest = z.infer<typeof updateUserRoleSchema>;

// ─── Local prompts ─────────────────────────────────────────────────────────────────────────────────

export const upsertLocalPromptSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  template: z.string().min(1),
  arguments: z.array(localPromptArgumentSchema).default([]),
  role: promptRoleSchema.default('user'),
  enabled: z.boolean().default(true),
});
export type UpsertLocalPromptRequest = z.infer<typeof upsertLocalPromptSchema>;

export const previewLocalPromptSchema = z.object({
  template: z.string().default(''),
  values: z.record(z.unknown()).default({}),
});
export type PreviewLocalPromptRequest = z.infer<typeof previewLocalPromptSchema>;

// ─── Plugins ───────────────────────────────────────────────────────────────────────────────────────

export interface PluginView {
  id: string;
  name: string;
  version: string;
  type: 'hook' | 'mcp-server';
  description: string;
  author: string;
  priority: number;
  enabled: boolean;
  source: string;
  error: string;
  config: Record<string, unknown>;
  /** Which `secret: true` config fields currently have a value (the values themselves are never returned). */
  configSecretsSet?: Record<string, boolean>;
  configSchema?: unknown;
  /** Human labels of the hook points this (hook) plugin implements. */
  hookPoints?: string[];
  installedAt: string;
  updatedAt: string;
}

export const updatePluginSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});
export type UpdatePluginRequest = z.infer<typeof updatePluginSchema>;

export const importPluginSchema = z.object({
  /** Slug used as the on-disk filename (<id>.mjs). Must match the manifest id. */
  id: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, numbers and dashes only'),
  /** The plugin module source (an ES module that default-exports the plugin object). */
  source: z.string().min(1).max(2_000_000),
});
export type ImportPluginRequest = z.infer<typeof importPluginSchema>;

// ─── LLM providers / models ───────────────────────────────────────────────────────────────────────

export const createLlmProviderSchema = z.object({
  name: z.string().min(1).max(120),
  type: llmProviderTypeSchema,
  baseUrl: z.string().default(''),
  /** Plaintext on the way in; encrypted at rest, never read back. */
  apiKey: z.string().default(''),
  defaultModel: z.string().default(''),
  models: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});
export type CreateLlmProviderRequest = z.infer<typeof createLlmProviderSchema>;

export const updateLlmProviderSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateLlmProviderRequest = z.infer<typeof updateLlmProviderSchema>;

export const testLlmProviderSchema = z.object({
  model: z.string().default(''),
});
export type TestLlmProviderRequest = z.infer<typeof testLlmProviderSchema>;

export interface LlmTestResult {
  ok: boolean;
  model: string;
  latencyMs: number;
  message: string;
}

/**
 * Discover the models a provider exposes. Either reference a saved provider (uses its stored key)
 * or pass ad-hoc {type, baseUrl, apiKey} to discover before saving. The API key, when provided, is
 * used only for the outbound list call and never stored.
 */
export const discoverLlmModelsSchema = z.object({
  providerId: z.string().optional(),
  type: llmProviderTypeSchema.optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});
export type DiscoverLlmModelsRequest = z.infer<typeof discoverLlmModelsSchema>;

export interface LlmModelsResult {
  models: string[];
  /** 'live' when fetched from the provider API; 'catalog' when we fell back to the offline list. */
  source: 'live' | 'catalog';
  message: string;
}

// ─── Tool invocation (test harness from the UI) ──────────────────────────────────────────────────────

export const invokeToolSchema = z.object({
  arguments: z.record(z.unknown()).default({}),
});
export type InvokeToolRequest = z.infer<typeof invokeToolSchema>;
