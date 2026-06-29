import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KRAVN_VERSION, type UpstreamServer } from '@kravn/contracts';
import type { McpCallContext } from '@kravn/plugin-sdk';
import type { Logger } from 'pino';
import type { PluginManager } from '../plugins/manager.js';

/** Minimal surface the manager uses — satisfied by the MCP SDK Client and by plugin shims. */
interface ClientLike {
  listTools(): Promise<any>;
  listResources(): Promise<any>;
  listPrompts(): Promise<any>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<any>;
  readResource(params: { uri: string }): Promise<any>;
  getPrompt(params: { name: string; arguments: Record<string, string> }): Promise<any>;
  close(): Promise<void>;
}

/** Plugin shims additionally accept a per-call context (files workspace). Real MCP clients do not. */
interface PluginClientLike extends ClientLike {
  callToolCtx(name: string, args: Record<string, unknown>, ctx?: McpCallContext): Promise<any>;
}

interface Connection {
  client: ClientLike;
  close: () => Promise<void>;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function authHeaders(authType: UpstreamServer['authType'], plain: string): Record<string, string> {
  if (!plain) return {};
  if (authType === 'bearer') return { Authorization: `Bearer ${plain}` };
  if (authType === 'basic') return { Authorization: `Basic ${Buffer.from(plain).toString('base64')}` };
  return {};
}

/**
 * Maintains live MCP CLIENT connections to upstream servers (Kravn acting as a client).
 * Connections are process-local; only their identity lives in the DB.
 */
export class UpstreamManager {
  private conns = new Map<string, Connection>();

  private plugins?: PluginManager;

  constructor(private log: Logger, private timeoutMs: () => number) {}

  /** Wired after construction (avoids a constructor cycle with the plugin manager). */
  setPluginManager(pm: PluginManager): void {
    this.plugins = pm;
  }

  isConnected(id: string): boolean {
    return this.conns.has(id);
  }

  connectedCount(): number {
    return this.conns.size;
  }

  getClient(id: string): ClientLike | undefined {
    return this.conns.get(id)?.client;
  }

  private pluginShim(pluginId: string): PluginClientLike {
    const pm = this.plugins;
    if (!pm) throw new Error('plugin manager not available');
    return {
      listTools: () => pm.serverListTools(pluginId),
      listResources: () => pm.serverListResources(pluginId),
      listPrompts: () => pm.serverListPrompts(pluginId),
      callTool: ({ name, arguments: args }) => pm.serverCallTool(pluginId, name, args),
      callToolCtx: (name, args, ctx) => pm.serverCallTool(pluginId, name, args, ctx),
      readResource: ({ uri }) => pm.serverReadResource(pluginId, uri),
      getPrompt: ({ name, arguments: args }) => pm.serverGetPrompt(pluginId, name, args),
      close: async () => {},
    };
  }

  async connect(server: UpstreamServer, authPlain: string): Promise<ClientLike> {
    await this.disconnect(server.id);

    // Plugin-backed servers delegate to an in-process MCP-server plugin.
    if (server.transport === 'plugin') {
      const shim = this.pluginShim(server.command);
      this.conns.set(server.id, { client: shim, close: async () => {} });
      this.log.info({ server: server.name, plugin: server.command }, 'bound plugin MCP server');
      return shim;
    }

    const client = new Client({ name: 'kravn-gateway', version: KRAVN_VERSION }, { capabilities: {} });
    const headers = { ...server.headers, ...authHeaders(server.authType, authPlain) };

    let transport;
    if (server.transport === 'stdio') {
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: { ...process.env, ...server.env } as Record<string, string>,
      });
    } else if (server.transport === 'sse') {
      transport = new SSEClientTransport(new URL(server.url), {
        requestInit: { headers },
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers },
      });
    }

    await withTimeout(client.connect(transport), this.timeoutMs(), `connect to ${server.name}`);
    const conn: Connection = { client, close: async () => void (await client.close().catch(() => {})) };
    this.conns.set(server.id, conn);
    this.log.info({ server: server.name, transport: server.transport }, 'connected to upstream MCP server');
    return client;
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.conns.delete(id);
    await conn.close();
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)));
  }

  // ─── Proxying helpers (used by the registry sync + downstream MCP endpoint) ───────────────────

  async listTools(id: string) {
    const c = this.client(id);
    return withTimeout(c.listTools(), this.timeoutMs(), 'listTools');
  }
  async listResources(id: string) {
    const c = this.client(id);
    return withTimeout(c.listResources().catch(() => ({ resources: [] })), this.timeoutMs(), 'listResources');
  }
  async listPrompts(id: string) {
    const c = this.client(id);
    return withTimeout(c.listPrompts().catch(() => ({ prompts: [] })), this.timeoutMs(), 'listPrompts');
  }
  async callTool(id: string, name: string, args: Record<string, unknown>, ctx?: McpCallContext) {
    const c = this.client(id);
    // Only the in-process plugin shim accepts a per-call context (files). Real MCP clients must not
    // receive a 2nd arg (the SDK would treat it as a result schema).
    const call = isPluginClient(c) ? c.callToolCtx(name, args, ctx) : c.callTool({ name, arguments: args });
    return withTimeout(call, this.timeoutMs(), `callTool ${name}`);
  }
  async readResource(id: string, uri: string) {
    const c = this.client(id);
    return withTimeout(c.readResource({ uri }), this.timeoutMs(), `readResource ${uri}`);
  }
  async getPrompt(id: string, name: string, args: Record<string, unknown>) {
    const c = this.client(id);
    return withTimeout(c.getPrompt({ name, arguments: args as Record<string, string> }), this.timeoutMs(), `getPrompt ${name}`);
  }

  private client(id: string): ClientLike {
    const c = this.getClient(id);
    if (!c) throw new Error(`upstream server ${id} is not connected`);
    return c;
  }
}

function isPluginClient(c: ClientLike): c is PluginClientLike {
  return typeof (c as PluginClientLike).callToolCtx === 'function';
}
