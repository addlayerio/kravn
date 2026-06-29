import {
  type CreateServerRequest,
  type UpdateServerRequest,
  type UpstreamServer,
} from '@kravn/contracts';
import { newId, slugify } from '../crypto.js';
import type { Encryptor } from '../crypto.js';
import type { Repos } from '../db/repos.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { UpstreamManager } from './upstream.js';
import type { SsrfGuard } from '../http/ssrf.js';
import type { LogStore } from '../logstore.js';
import type { Metrics } from '../metrics.js';
import type { PluginManager } from '../plugins/manager.js';
import type { McpCallContext } from '@kravn/plugin-sdk';
import type { AuthUser } from '../auth/auth.service.js';
import type { Logger } from 'pino';

export interface RegistryDeps {
  repos: Repos;
  encryptor: Encryptor;
  upstream: UpstreamManager;
  settings: SettingsService;
  ssrf: SsrfGuard;
  log: Logger;
  logstore: LogStore;
  metrics: Metrics;
  plugins: PluginManager;
}

const toolId = (serverId: string, name: string) => `tl_${serverId}_${slugify(name)}`;
const resourceId = (serverId: string, uri: string) => `rs_${serverId}_${slugify(uri)}`;
const promptId = (serverId: string, name: string) => `pr_${serverId}_${slugify(name)}`;

export class RegistryService {
  constructor(private d: RegistryDeps) {}

  // ─── Servers CRUD ────────────────────────────────────────────────────────────────────────────

  listServers(): Promise<UpstreamServer[]> {
    return this.d.repos.servers.list();
  }
  getServer(id: string): Promise<UpstreamServer | undefined> {
    return this.d.repos.servers.getById(id);
  }

  private async uniqueSlug(name: string, exceptId?: string): Promise<string> {
    const base = slugify(name);
    let candidate = base;
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = await this.d.repos.servers.getBySlug(candidate);
      if (!existing || existing.id === exceptId) return candidate;
      n += 1;
      candidate = `${base}-${n}`;
    }
  }

  async createServer(req: CreateServerRequest): Promise<UpstreamServer> {
    if (req.transport === 'plugin') {
      throw new Error("Plugin-backed servers are managed from the Plugins page, not created here.");
    }
    if (req.transport !== 'stdio' && req.url) {
      await this.d.ssrf.assertUrlAllowed(req.url);
    }
    const id = newId();
    const slug = await this.uniqueSlug(req.name);
    const authValueEncrypted = req.authType === 'none' ? '' : this.d.encryptor.encrypt(req.authValue);
    const server = await this.d.repos.servers.create({
      id,
      name: req.name,
      slug,
      description: req.description,
      transport: req.transport,
      url: req.url,
      command: req.command,
      args: req.args,
      env: req.env,
      headers: req.headers,
      authType: req.authType,
      authValueEncrypted,
      enabled: req.enabled,
    });
    this.d.logstore.add('info', `Server "${server.name}" registered`, { id });
    if (server.enabled) void this.connectAndSync(id);
    return server;
  }

  async updateServer(id: string, req: UpdateServerRequest): Promise<UpstreamServer | undefined> {
    const existing = await this.d.repos.servers.getById(id);
    if (!existing) return undefined;

    const patch: Record<string, unknown> = {};
    if (req.name !== undefined) {
      patch.name = req.name;
      patch.slug = await this.uniqueSlug(req.name, id);
    }
    for (const k of ['description', 'url', 'command', 'args', 'env', 'headers', 'enabled'] as const) {
      if (req[k] !== undefined) patch[k] = req[k];
    }
    if (req.authType !== undefined) patch.authType = req.authType;
    if (req.authType === 'none') patch.authValueEncrypted = '';
    else if (req.authValue !== undefined) patch.authValueEncrypted = this.d.encryptor.encrypt(req.authValue);

    if (typeof patch.url === 'string' && patch.url && existing.transport !== 'stdio') {
      await this.d.ssrf.assertUrlAllowed(patch.url);
    }

    await this.d.repos.servers.update(id, patch);
    const updated = await this.d.repos.servers.getById(id);

    // Reconnect/sync if it is (now) enabled; otherwise drop the connection.
    if (updated?.enabled) void this.connectAndSync(id);
    else {
      await this.d.upstream.disconnect(id);
      await this.d.repos.servers.setStatus(id, 'disabled');
      this.refreshGauge();
    }
    return updated;
  }

  async deleteServer(id: string): Promise<void> {
    await this.d.upstream.disconnect(id);
    await this.d.repos.servers.delete(id);
    this.refreshGauge();
    this.d.logstore.add('info', `Server removed`, { id });
  }

  // ─── Connection + catalog sync ───────────────────────────────────────────────────────────────

  async connectAndSync(id: string): Promise<UpstreamServer | undefined> {
    const server = await this.d.repos.servers.getById(id);
    if (!server) return undefined;
    if (!server.enabled) return server;

    await this.d.repos.servers.setStatus(id, 'connecting');
    try {
      const authPlain = this.d.encryptor.decrypt(await this.d.repos.servers.getAuthValueEncrypted(id));
      await this.d.upstream.connect(server, authPlain);
      await this.syncCatalog(server);
      await this.d.repos.servers.setStatus(id, 'online');
      this.d.logstore.add('info', `Synced catalog from "${server.name}"`, { id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.d.repos.servers.setStatus(id, 'error', message);
      this.d.logstore.add('error', `Failed to connect to "${server.name}": ${message}`, { id });
      this.d.log.warn({ err, server: server.name }, 'upstream connect/sync failed');
    } finally {
      this.refreshGauge();
    }
    return this.d.repos.servers.getById(id);
  }

  private async syncCatalog(server: UpstreamServer): Promise<void> {
    const { registry } = this.d.repos;
    await registry.deleteToolsByServer(server.id);
    await registry.deleteResourcesByServer(server.id);
    await registry.deletePromptsByServer(server.id);

    const tools = await this.d.upstream.listTools(server.id);
    for (const t of tools.tools ?? []) {
      await registry.upsertTool({
        id: toolId(server.id, t.name),
        serverId: server.id,
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? {},
      });
    }

    const resources = await this.d.upstream.listResources(server.id);
    for (const r of (resources as any).resources ?? []) {
      await registry.upsertResource({
        id: resourceId(server.id, r.uri),
        serverId: server.id,
        uri: r.uri,
        name: r.name ?? '',
        description: r.description ?? '',
        mimeType: r.mimeType ?? '',
      });
    }

    const prompts = await this.d.upstream.listPrompts(server.id);
    for (const p of (prompts as any).prompts ?? []) {
      await registry.upsertPrompt({
        id: promptId(server.id, p.name),
        serverId: server.id,
        name: p.name,
        description: p.description ?? '',
        arguments: p.arguments ?? [],
      });
    }
  }

  /** Connect + sync every enabled server (best-effort), used at startup. */
  async syncAll(): Promise<void> {
    const servers = await this.d.repos.servers.list();
    await Promise.all(servers.filter((s) => s.enabled).map((s) => this.connectAndSync(s.id)));
  }

  private refreshGauge(): void {
    this.d.metrics.upstreamConnected.set(this.d.upstream.connectedCount());
  }

  // ─── Invocation ──────────────────────────────────────────────────────────────────────────────

  private async ensureConnected(serverId: string): Promise<void> {
    if (this.d.upstream.isConnected(serverId)) return;
    await this.connectAndSync(serverId);
    if (!this.d.upstream.isConnected(serverId)) {
      throw new Error('Upstream server is not reachable.');
    }
  }

  async readResourceFrom(serverId: string, uri: string, actor?: AuthUser): Promise<unknown> {
    await this.ensureConnected(serverId);
    const uri2 = await this.d.plugins.applyResourcePre(serverId, uri, actor);
    let result = await this.d.upstream.readResource(serverId, uri2);
    result = await this.d.plugins.applyResourcePost(serverId, uri2, result, actor);
    return result;
  }

  async getPromptFrom(serverId: string, name: string, args: Record<string, unknown>, actor?: AuthUser): Promise<unknown> {
    await this.ensureConnected(serverId);
    const args2 = await this.d.plugins.applyPromptPre(serverId, name, args, actor);
    let result = await this.d.upstream.getPrompt(serverId, name, args2);
    result = await this.d.plugins.applyPromptPost(serverId, name, result, actor);
    return result;
  }

  async invokeTool(toolDbId: string, args: Record<string, unknown>, actor?: AuthUser, ctx?: McpCallContext): Promise<unknown> {
    const tool = await this.d.repos.registry.getTool(toolDbId);
    if (!tool || !tool.enabled) throw new Error('Tool not found or disabled.');
    await this.ensureConnected(tool.serverId);

    // Apigee-style request hook: plugins may mutate the arguments or block the call.
    const callArgs = await this.d.plugins.applyToolPre(tool.serverId, tool.name, args, actor);

    try {
      // Carry the caller + file workspace to plugin shims (ignored by remote MCP upstreams).
      let result = await this.d.upstream.callTool(tool.serverId, tool.name, callArgs, { actor: actor && { id: actor.id, email: actor.email, role: actor.role }, files: ctx?.files });
      // Response hook: plugins may mutate the result.
      result = await this.d.plugins.applyToolPost(tool.serverId, tool.name, result, actor);
      this.d.metrics.toolCalls.inc({ server: tool.serverId, tool: tool.name });
      this.d.logstore.add('info', `Tool "${tool.name}" invoked`, { server: tool.serverId });
      return result;
    } catch (err) {
      this.d.metrics.toolErrors.inc({ server: tool.serverId, tool: tool.name });
      throw err;
    }
  }

  /** Reconcile plugin-backed (transport='plugin') servers with the set of enabled mcp-server plugins. */
  async syncPluginServers(): Promise<void> {
    const desired = this.d.plugins.enabledMcpServers();
    const desiredIds = new Set(desired.map((d) => d.id));
    const all = await this.d.repos.servers.list();

    for (const s of all) {
      if (s.transport === 'plugin' && !desiredIds.has(s.command)) {
        await this.d.upstream.disconnect(s.id);
        await this.d.repos.servers.delete(s.id);
      }
    }

    for (const d of desired) {
      const id = `plg_${d.id}`;
      const existing = await this.d.repos.servers.getById(id);
      if (!existing) {
        await this.d.repos.servers.create({
          id,
          name: d.name,
          slug: `plugin-${d.id}`,
          description: 'Provided by plugin',
          transport: 'plugin',
          url: '',
          command: d.id,
          args: [],
          env: {},
          headers: {},
          authType: 'none',
          authValueEncrypted: '',
          enabled: true,
        });
      } else {
        await this.d.repos.servers.update(id, { name: d.name, enabled: true });
      }
      await this.connectAndSync(id);
    }
    this.refreshGauge();
  }
}
