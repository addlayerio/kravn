import type { Tool, Resource, Prompt, LocalPrompt } from '@kravn/contracts';
import { KRAVN_VERSION } from '@kravn/contracts';
import type { Repos } from '../db/repos.js';
import type { RegistryService } from './registry.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { PluginManager } from '../plugins/manager.js';
import type { AuthUser } from '../auth/auth.service.js';
import { renderTemplate, missingRequiredArgs } from '../prompts/render.js';

/**
 * Kravn acting AS an MCP server toward downstream clients.
 *
 * This is a minimal JSON-RPC dispatcher implementing the core MCP methods by proxying to the
 * registered upstream servers. It speaks the streamable-HTTP "JSON response" mode (request in,
 * JSON-RPC response out) which is the simplest interoperable subset. Sessions/SSE streaming and
 * the full server transport are a deliberate later phase.
 */

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export interface McpScope {
  /** null = the global catalog; otherwise a virtual server's curated slice. */
  label: string;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
  /** Kravn-authored prompt templates (rendered locally, not proxied upstream). */
  localPrompts: LocalPrompt[];
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

interface RegistrySnapshot {
  at: number;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
  localPrompts: LocalPrompt[];
}

export class DownstreamMcp {
  constructor(
    private repos: Repos,
    private registry: RegistryService,
    private settings: SettingsService,
    private plugins: PluginManager,
  ) {}

  // Short-lived in-memory cache of the full registry lists. buildScope() runs on EVERY tools/list and
  // reads all four tables; the registry changes only on server sync / plugin enable-disable / VS edits.
  // Read-mostly + write-rarely + tolerates a few seconds of staleness → cache with a small TTL, and
  // invalidate explicitly on plugin change (wired in services.ts) so toggles reflect immediately.
  private registryCache?: RegistrySnapshot;
  private static readonly REGISTRY_TTL_MS = 10_000;

  /** Drop the cached registry snapshot (call after a mutation that changes tools/resources/prompts). */
  invalidateRegistryCache(): void {
    this.registryCache = undefined;
  }

  private async loadRegistry(): Promise<RegistrySnapshot> {
    const c = this.registryCache;
    if (c && Date.now() - c.at < DownstreamMcp.REGISTRY_TTL_MS) return c;
    const [tools, resources, prompts, localPrompts] = await Promise.all([
      this.repos.registry.listTools(),
      this.repos.registry.listResources(),
      this.repos.registry.listPrompts(),
      this.repos.localPrompts.listEnabled(),
    ]);
    const fresh: RegistrySnapshot = { at: Date.now(), tools, resources, prompts, localPrompts };
    this.registryCache = fresh;
    return fresh;
  }

  /** Resolve the catalog slice exposed at a given endpoint. */
  async buildScope(virtualServerSlug?: string | null): Promise<McpScope | null> {
    const { tools: allTools, resources: allResources, prompts: allPrompts, localPrompts: allLocalPrompts } =
      await this.loadRegistry();
    const enabled = <T extends { enabled: boolean }>(xs: T[]) => xs.filter((x) => x.enabled);

    if (!virtualServerSlug) {
      return {
        label: 'global',
        tools: enabled(allTools),
        resources: enabled(allResources),
        prompts: enabled(allPrompts),
        localPrompts: allLocalPrompts,
      };
    }
    const vs = await this.repos.virtualServers.getBySlug(virtualServerSlug);
    if (!vs || !vs.enabled) return null;
    const tset = new Set(vs.toolIds);
    const rset = new Set(vs.resourceIds);
    const pset = new Set(vs.promptIds);
    return {
      label: vs.name,
      tools: enabled(allTools).filter((t) => tset.has(t.id)),
      resources: enabled(allResources).filter((r) => rset.has(r.id)),
      prompts: enabled(allPrompts).filter((p) => pset.has(p.id)),
      localPrompts: allLocalPrompts.filter((p) => pset.has(p.id)),
    };
  }

  /** Dispatch one JSON-RPC message. Returns null for notifications (no response body). */
  async dispatch(scope: McpScope, msg: JsonRpcRequest, actor?: AuthUser): Promise<JsonRpcResponse | null> {
    const id = msg.id ?? null;
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

    try {
      switch (msg.method) {
        case 'initialize': {
          const requested = msg.params?.protocolVersion;
          return ok({
            protocolVersion: typeof requested === 'string' ? requested : DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: `kravn:${scope.label}`, version: KRAVN_VERSION },
          });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null; // notifications: no response

        case 'ping':
          return ok({});

        case 'tools/list': {
          // Apigee-style list hook: plugins can filter/annotate what the client sees.
          const enriched = scope.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema ?? {},
            server: t.serverId,
          }));
          const filtered = await this.plugins.applyListTools(enriched, actor);
          return ok({
            tools: filtered.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? {} })),
          });
        }

        case 'tools/call': {
          const name = msg.params?.name;
          const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
          const tool = scope.tools.find((t) => t.name === name);
          if (!tool) return fail(-32602, `Unknown tool: ${name}`);
          const result = await this.registry.invokeTool(tool.id, args, actor);
          return ok(result);
        }

        case 'resources/list': {
          const enriched = scope.resources.map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
            server: r.serverId,
          }));
          const filtered = await this.plugins.applyListResources(enriched, actor);
          return ok({
            resources: filtered.map((r: any) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })),
          });
        }

        case 'resources/read': {
          const uri = msg.params?.uri;
          const res = scope.resources.find((r) => r.uri === uri);
          if (!res) return fail(-32602, `Unknown resource: ${uri}`);
          const result = await this.registry.readResourceFrom(res.serverId, res.uri, actor);
          return ok(result);
        }

        case 'prompts/list': {
          const enriched = [
            ...scope.localPrompts.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments ?? [], server: 'local' })),
            ...scope.prompts.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments ?? [], server: p.serverId })),
          ];
          const filtered = await this.plugins.applyListPrompts(enriched, actor);
          return ok({
            prompts: filtered.map((p: any) => ({ name: p.name, description: p.description, arguments: p.arguments ?? [] })),
          });
        }

        case 'prompts/get': {
          const name = msg.params?.name;
          const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;

          // Local (Kravn-authored) prompts take precedence and are rendered here.
          const local = scope.localPrompts.find((p) => p.name === name);
          if (local) {
            const args2 = await this.plugins.applyPromptPre('local', local.name, args, actor);
            const missing = missingRequiredArgs(local.arguments, args2);
            if (missing.length) return fail(-32602, `Missing required argument(s): ${missing.join(', ')}`);
            const text = renderTemplate(local.template, args2);
            let result: any = {
              description: local.description,
              messages: [{ role: local.role, content: { type: 'text', text } }],
            };
            result = await this.plugins.applyPromptPost('local', local.name, result, actor);
            return ok(result);
          }

          const prompt = scope.prompts.find((p) => p.name === name);
          if (!prompt) return fail(-32602, `Unknown prompt: ${name}`);
          const result = await this.registry.getPromptFrom(prompt.serverId, prompt.name, args, actor);
          return ok(result);
        }

        default:
          return fail(-32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(-32000, message);
    }
  }
}
