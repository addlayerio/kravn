import { z } from 'zod';

/**
 * Kravn Plugin SDK — the public contract for third-party plugins.
 *
 * A plugin is a plain object (default export of an ES module). Importing this SDK is OPTIONAL and
 * only used for TypeScript types + the `definePlugin` helper; at runtime Kravn just reads the shape.
 *
 * Two plugin TYPES:
 *   - 'hook'        — Apigee-style: manipulate tool-call requests/results and the advertised tool list.
 *   - 'mcp-server'  — provide an in-process MCP server (tools/resources/prompts) that Kravn exposes
 *                     and composes like any other server.
 *
 * See PLUGINS.md for the full guide.
 */

export const PLUGIN_TYPES = ['hook', 'mcp-server'] as const;
export type PluginType = (typeof PLUGIN_TYPES)[number];

export const pluginManifestSchema = z.object({
  /** Unique, stable slug (lowercase, dashes). Also the on-disk file name for single-file plugins. */
  id: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase letters, numbers and dashes'),
  name: z.string().min(1).max(80),
  version: z.string().default('0.1.0'),
  type: z.enum(PLUGIN_TYPES),
  description: z.string().default(''),
  author: z.string().default(''),
  /** Lower runs first (hook ordering). Default 100. */
  priority: z.number().int().default(100),
  /** Optional JSON Schema describing the operator-editable config for this plugin. */
  configSchema: z.unknown().optional(),
  /**
   * Optional setup / required-permissions guidance (plain text; blank lines and `•` bullets are fine).
   * Shown as a callout in the plugin's config screen — the place to document, e.g., which OAuth scopes or
   * Graph Application permissions the credential you enter here must be granted.
   */
  setup: z.string().optional(),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

// ─── MCP value shapes (subset of the MCP spec) ───────────────────────────────────────────────────
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}
export interface McpTextContent {
  type: 'text';
  text: string;
}
export type McpContent = McpTextContent | { type: string; [k: string]: unknown };
/** A binary file passed into (input) or produced by (output) a tool call, base64-encoded. */
export interface McpToolFile {
  name: string;
  /** base64 of the file bytes. */
  b64: string;
  /** MIME type (optional on input; set on output). */
  mime?: string;
}
export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
  /** Files produced by the tool — the host offers them to the user (e.g. as downloads). */
  files?: McpToolFile[];
}
export interface McpResourceDef {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}
export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

// ─── Actor + config passed to every hook/handler ─────────────────────────────────────────────────
export interface PluginActor {
  id: string;
  email: string;
  role: string;
}
export type PluginConfig = Record<string, unknown>;

export interface PluginBaseContext {
  /** Operator-provided configuration for this plugin (validated against configSchema if present). */
  config: PluginConfig;
  /** The authenticated caller, when known. */
  actor?: PluginActor;
  /** The virtual server this call was routed through, or undefined for the global catalog / chat. */
  virtualServerId?: string;
  /** Emit a line to the Kravn log viewer (prefixed with the plugin id). */
  log: (message: string) => void;
}

// ─── Hook plugin ─────────────────────────────────────────────────────────────────────────────────
export interface ListToolsContext extends PluginBaseContext {
  /** Mutable list advertised to downstream MCP clients. Reassign to filter, or edit in place. */
  tools: Array<McpToolDef & { server: string }>;
}
export interface ToolCallContext extends PluginBaseContext {
  server: string;
  tool: string;
  /** Mutable tool arguments. Edit in place or reassign. */
  arguments: Record<string, unknown>;
  /** Block the call (throws a PluginDenied the gateway surfaces as an MCP error). */
  deny: (reason: string) => void;
}
export interface ToolResultContext extends PluginBaseContext {
  server: string;
  tool: string;
  /** Mutable tool result (MCP shape). Edit in place or reassign. */
  result: McpToolResult;
}

// ─── Resource hooks ────────────────────────────────────────────────────────────────────────────
export interface ListResourcesContext extends PluginBaseContext {
  resources: Array<McpResourceDef & { server: string }>;
}
export interface ResourceReadContext extends PluginBaseContext {
  server: string;
  /** The resource URI — MUTABLE (you may rewrite it) — or call deny(). */
  uri: string;
  deny: (reason: string) => void;
}
export interface ResourceResultContext extends PluginBaseContext {
  server: string;
  uri: string;
  /** The resource read result — MUTABLE. */
  result: any;
}

// ─── Prompt hooks ──────────────────────────────────────────────────────────────────────────────
export interface ListPromptsContext extends PluginBaseContext {
  prompts: Array<McpPromptDef & { server: string }>;
}
export interface PromptGetContext extends PluginBaseContext {
  server: string;
  prompt: string;
  /** Prompt arguments — MUTABLE — or call deny(). */
  arguments: Record<string, unknown>;
  deny: (reason: string) => void;
}
export interface PromptResultContext extends PluginBaseContext {
  server: string;
  prompt: string;
  /** The rendered prompt result — MUTABLE. */
  result: any;
}

// ─── Auth hook ─────────────────────────────────────────────────────────────────────────────────
export interface ResolveUserContext extends PluginBaseContext {
  /** The just-authenticated user — MUTABLE (e.g. remap role / permissions) — or call deny(). */
  user: { id: string; email: string; name: string; role: string; permissions: string[] };
  deny: (reason: string) => void;
}

export interface HookPlugin {
  manifest: PluginManifest & { type: 'hook' };
  hooks: {
    /** A downstream client lists tools — filter or annotate what they see. */
    onListTools?: (ctx: ListToolsContext) => void | Promise<void>;
    /** Before a tool call is forwarded — mutate arguments or deny. (tool pre-invoke) */
    onToolCall?: (ctx: ToolCallContext) => void | Promise<void>;
    /** After a tool returns — mutate the result. (tool post-invoke) */
    onToolResult?: (ctx: ToolResultContext) => void | Promise<void>;

    /** A client lists resources — filter or annotate. */
    onListResources?: (ctx: ListResourcesContext) => void | Promise<void>;
    /** Before a resource is read — mutate the URI or deny. (resource pre-fetch) */
    onResourceRead?: (ctx: ResourceReadContext) => void | Promise<void>;
    /** After a resource is read — mutate the result. (resource post-fetch) */
    onResourceResult?: (ctx: ResourceResultContext) => void | Promise<void>;

    /** A client lists prompts — filter or annotate. */
    onListPrompts?: (ctx: ListPromptsContext) => void | Promise<void>;
    /** Before a prompt is fetched/rendered — mutate arguments or deny. (prompt pre-fetch) */
    onPromptGet?: (ctx: PromptGetContext) => void | Promise<void>;
    /** After a prompt is fetched/rendered — mutate the result. (prompt post-fetch) */
    onPromptResult?: (ctx: PromptResultContext) => void | Promise<void>;

    /** After authentication — remap/augment the user, or deny access. (http auth resolve user) */
    onResolveUser?: (ctx: ResolveUserContext) => void | Promise<void>;
  };
}

/** All hook method names + their human labels (used by the admin "hook points" view). */
export const HOOK_POINTS: Record<string, string> = {
  onListTools: 'Tools List',
  onToolCall: 'Tool Pre-Invoke',
  onToolResult: 'Tool Post-Invoke',
  onListResources: 'Resources List',
  onResourceRead: 'Resource Pre-Fetch',
  onResourceResult: 'Resource Post-Fetch',
  onListPrompts: 'Prompts List',
  onPromptGet: 'Prompt Pre-Fetch',
  onPromptResult: 'Prompt Post-Fetch',
  onResolveUser: 'Auth Resolve User',
};

// ─── MCP-server plugin ───────────────────────────────────────────────────────────────────────────
/**
 * Optional per-call context. Carries input files (e.g. the chat conversation's attachments) and the
 * caller, so a tool can read/transform files. Only provided on the in-process plugin path — real
 * remote MCP upstreams never receive it. Files are base64; write output files via the result's `files`.
 */
export interface McpCallContext {
  files?: McpToolFile[];
  actor?: PluginActor;
  /** The virtual server this call was routed through (undefined = global catalog / chat). */
  virtualServerId?: string;
}
export interface McpServerHandlers {
  listTools: (config: PluginConfig) => McpToolDef[] | Promise<McpToolDef[]>;
  callTool: (name: string, args: Record<string, unknown>, config: PluginConfig, ctx?: McpCallContext) => McpToolResult | Promise<McpToolResult>;
  listResources?: (config: PluginConfig) => McpResourceDef[] | Promise<McpResourceDef[]>;
  readResource?: (uri: string, config: PluginConfig) => unknown | Promise<unknown>;
  listPrompts?: (config: PluginConfig) => McpPromptDef[] | Promise<McpPromptDef[]>;
  getPrompt?: (name: string, args: Record<string, unknown>, config: PluginConfig) => unknown | Promise<unknown>;
}

export interface McpServerPlugin {
  manifest: PluginManifest & { type: 'mcp-server' };
  server: McpServerHandlers;
}

export type KravnPlugin = HookPlugin | McpServerPlugin;

/** Identity helper that gives you full type-checking when authoring a plugin in TypeScript. */
export function definePlugin<T extends KravnPlugin>(plugin: T): T {
  return plugin;
}

/** Convenience for building a text tool result. */
export function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}
