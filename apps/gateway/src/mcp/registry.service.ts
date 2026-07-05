import {
  type CreateServerRequest,
  type UpdateServerRequest,
  type UpstreamServer,
} from '@kravn/contracts';
import { newId, slugify, shortHash } from '../crypto.js';
import type { Encryptor } from '../crypto.js';
import type { Repos } from '../db/repos.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { UpstreamManager } from './upstream.js';
import type { SsrfGuard } from '../http/ssrf.js';
import type { UpstreamOAuthService } from '../auth/upstream-oauth.service.js';
import type { EventBus } from '../events/bus.js';
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
  upstreamOAuth: UpstreamOAuthService;
  events: EventBus;
}

/**
 * Build a deterministic registry id that always fits the `varchar(64)` id columns.
 *
 * Catalog keys from upstream servers — especially resource URIs — can be long, and the readable form
 * `<prefix>_<serverId>_<slug>` (serverId is 32 chars, slug up to 60) can reach ~96 chars and overflow.
 * When the readable form fits we keep it; otherwise we truncate the slug and append a short stable hash
 * of (serverId, key) so the id stays unique and bounded. `syncCatalog` deletes + reinserts a server's
 * rows on every sync, so changing the long-key form never orphans existing rows.
 */
const MAX_ID_LEN = 64;
function compositeId(prefix: string, serverId: string, key: string): string {
  const slug = slugify(key);
  const readable = `${prefix}_${serverId}_${slug}`;
  if (readable.length <= MAX_ID_LEN) return readable;
  const hash = shortHash(`${serverId}\0${key}`);
  const room = MAX_ID_LEN - prefix.length - serverId.length - hash.length - 3; // 3 underscores
  const head = room > 0 ? slug.slice(0, room) : '';
  return `${prefix}_${serverId}_${head}_${hash}`;
}
const toolId = (serverId: string, name: string) => compositeId('tl', serverId, name);
const resourceId = (serverId: string, uri: string) => compositeId('rs', serverId, uri);
const promptId = (serverId: string, name: string) => compositeId('pr', serverId, name);

// Catalog column limits — an upstream can return anything, so clamp bounded fields before storing so one long
// value (a long resource name, a huge input schema on MySQL where TEXT caps at 64KB, …) can't fail the whole
// catalog sync. `name`/`mime_type` are varchar; the rest are TEXT (unbounded on pg, 64KB on MySQL).
const MAX_NAME = 255;
const MAX_MIME = 191;
const MAX_TEXT = 60_000; // stays under MySQL's 64KB TEXT limit; safe on every dialect
const clampStr = (s: string | undefined, n: number): string => {
  const v = s ?? '';
  return v.length > n ? v.slice(0, n) : v;
};
/** Keep a JSON value only if it serializes within the column budget; else drop it to `{}` (better than a broken schema). */
const clampJson = <T>(v: T, fallback: T): T => {
  try {
    return JSON.stringify(v ?? fallback).length > MAX_TEXT ? fallback : (v ?? fallback);
  } catch {
    return fallback;
  }
};

/**
 * Turn a connect/sync failure into a message safe to show in the UI as the server's status.
 *
 * Connection-level problems (timeouts, refused, TLS, 401) are actionable, so we keep them. Database
 * driver errors leak raw SQL and column internals (e.g. "value too long for type character varying(64)")
 * — those are generalized to an application-level message; the raw detail still goes to the logs.
 */
function describeSyncError(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; message?: string };
  const msg = e.message ?? String(err);
  const looksLikeDbError =
    (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) ||
    /\b(insert into|update\s|delete from|select\s|value too long|violates|duplicate key|syntax error at|relation\s|column\s)\b/i.test(
      msg,
    );
  return looksLikeDbError
    ? "Connected, but the server's catalog could not be stored (a catalog value exceeded a storage limit). See server logs for the technical detail."
    : msg;
}

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
      tlsCa: req.tlsCa,
      tlsClientCert: req.tlsClientCert,
      tlsClientKeyEncrypted: req.tlsClientKey ? this.d.encryptor.encrypt(req.tlsClientKey) : '',
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

    // TLS: CA + client cert are public (updatable incl. clearing); the client key is write-only —
    // a non-empty value replaces it, blank/undefined keeps the stored key.
    if (req.tlsCa !== undefined) patch.tlsCa = req.tlsCa;
    if (req.tlsClientCert !== undefined) patch.tlsClientCert = req.tlsClientCert;
    if (req.tlsClientKey) patch.tlsClientKeyEncrypted = this.d.encryptor.encrypt(req.tlsClientKey);

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
    this.d.events.fire('registry');
  }

  // ─── Connection + catalog sync ───────────────────────────────────────────────────────────────

  async connectAndSync(id: string): Promise<UpstreamServer | undefined> {
    const server = await this.d.repos.servers.getById(id);
    if (!server) return undefined;
    if (!server.enabled) return server;

    await this.d.repos.servers.setStatus(id, 'connecting');
    try {
      // OAuth servers resolve (and refresh) an access token from the upstream-OAuth store; everything else
      // uses the stored static credential. The resolved token is sent as a Bearer by upstream.connect.
      const authPlain =
        server.authType === 'oauth'
          ? await this.d.upstreamOAuth.accessTokenFor(id)
          : this.d.encryptor.decrypt(await this.d.repos.servers.getAuthValueEncrypted(id));
      // Per-server TLS (custom CA / mTLS client cert) → an SSRF-preserving dispatcher, for http/sse only.
      let dispatcher: import('undici').Dispatcher | undefined;
      if (server.transport !== 'stdio') {
        const tls = await this.d.repos.servers.getTls(id);
        if (tls.ca || tls.cert || tls.keyEncrypted) {
          dispatcher = this.d.ssrf.dispatcherFor({
            ca: tls.ca || undefined,
            cert: tls.cert || undefined,
            key: tls.keyEncrypted ? this.d.encryptor.decrypt(tls.keyEncrypted) : undefined,
          });
        }
      }
      await this.d.upstream.connect(server, authPlain, dispatcher);
      await this.syncCatalog(server);
      await this.d.repos.servers.setStatus(id, 'online');
      this.d.logstore.add('info', `Synced catalog from "${server.name}"`, { id });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = describeSyncError(err);
      await this.d.repos.servers.setStatus(id, 'error', message);
      this.d.logstore.add('error', `Failed to connect to "${server.name}": ${raw}`, { id });
      this.d.log.warn({ err, server: server.name }, 'upstream connect/sync failed');
    } finally {
      this.refreshGauge();
      this.d.events.fire('registry'); // status changed (connecting → online/error) → push to operator UIs
    }
    return this.d.repos.servers.getById(id);
  }

  private readonly syncLocks = new Map<string, Promise<unknown>>();

  /**
   * Serialize catalog syncs per server. At startup `syncPluginServers()` and `syncAll()` both fire
   * (un-awaited) and can both trigger a sync for the same enabled plugin server (e.g. Jira). `doSyncCatalog`
   * deletes-then-inserts and isn't atomic, so two concurrent runs race and the second's INSERT hits a
   * duplicate-key (PG 23505 on tools_pkey). Chaining runs per server keeps each delete before its own inserts.
   */
  private syncCatalog(server: UpstreamServer): Promise<void> {
    const prev = this.syncLocks.get(server.id) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.doSyncCatalog(server));
    this.syncLocks.set(server.id, run);
    return run.finally(() => {
      if (this.syncLocks.get(server.id) === run) this.syncLocks.delete(server.id);
    });
  }

  private async doSyncCatalog(server: UpstreamServer): Promise<void> {
    const { registry } = this.d.repos;
    await registry.deleteToolsByServer(server.id);
    await registry.deleteResourcesByServer(server.id);
    await registry.deletePromptsByServer(server.id);

    // Store each item independently: a single item that still can't be stored (e.g. an exotic constraint) is
    // skipped and logged rather than aborting the whole catalog, so a mostly-good catalog still lands.
    let skipped = 0;
    const store = async (kind: string, label: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        skipped++;
        this.d.log.warn({ err, server: server.name, kind, label }, 'skipped a catalog item that could not be stored');
      }
    };

    const tools = await this.d.upstream.listTools(server.id);
    for (const t of tools.tools ?? []) {
      await store('tool', t.name, () =>
        registry.upsertTool({
          id: toolId(server.id, t.name),
          serverId: server.id,
          name: clampStr(t.name, MAX_NAME),
          description: clampStr(t.description ?? '', MAX_TEXT),
          inputSchema: clampJson(t.inputSchema ?? {}, {}),
        }),
      );
    }

    const resources = await this.d.upstream.listResources(server.id);
    for (const r of (resources as any).resources ?? []) {
      await store('resource', r.uri, () =>
        registry.upsertResource({
          id: resourceId(server.id, r.uri),
          serverId: server.id,
          uri: clampStr(r.uri, MAX_TEXT),
          name: clampStr(r.name ?? '', MAX_NAME),
          description: clampStr(r.description ?? '', MAX_TEXT),
          mimeType: clampStr(r.mimeType ?? '', MAX_MIME),
        }),
      );
    }

    const prompts = await this.d.upstream.listPrompts(server.id);
    for (const p of (prompts as any).prompts ?? []) {
      await store('prompt', p.name, () =>
        registry.upsertPrompt({
          id: promptId(server.id, p.name),
          serverId: server.id,
          name: clampStr(p.name, MAX_NAME),
          description: clampStr(p.description ?? '', MAX_TEXT),
          arguments: clampJson(p.arguments ?? [], []),
        }),
      );
    }

    if (skipped) {
      this.d.logstore.add('warn', `Synced "${server.name}" but ${skipped} catalog item(s) were too large to store and were skipped`, { id: server.id });
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

  async readResourceFrom(serverId: string, uri: string, actor?: AuthUser, vsId?: string): Promise<unknown> {
    await this.ensureConnected(serverId);
    const uri2 = await this.d.plugins.applyResourcePre(serverId, uri, actor, vsId);
    let result = await this.d.upstream.readResource(serverId, uri2);
    result = await this.d.plugins.applyResourcePost(serverId, uri2, result, actor, vsId);
    return result;
  }

  async getPromptFrom(serverId: string, name: string, args: Record<string, unknown>, actor?: AuthUser, vsId?: string): Promise<unknown> {
    await this.ensureConnected(serverId);
    const args2 = await this.d.plugins.applyPromptPre(serverId, name, args, actor, vsId);
    let result = await this.d.upstream.getPrompt(serverId, name, args2);
    result = await this.d.plugins.applyPromptPost(serverId, name, result, actor, vsId);
    return result;
  }

  async invokeTool(toolDbId: string, args: Record<string, unknown>, actor?: AuthUser, ctx?: McpCallContext): Promise<unknown> {
    const tool = await this.d.repos.registry.getTool(toolDbId);
    if (!tool || !tool.enabled) throw new Error('Tool not found or disabled.');
    await this.ensureConnected(tool.serverId);
    const vsId = ctx?.mcpEndpointId;

    // Apigee-style request hook: plugins may mutate the arguments or block the call.
    const callArgs = await this.d.plugins.applyToolPre(tool.serverId, tool.name, args, actor, vsId);

    try {
      // Carry the caller + file workspace to plugin shims (ignored by remote MCP upstreams).
      let result = await this.d.upstream.callTool(tool.serverId, tool.name, callArgs, { actor: actor && { id: actor.id, email: actor.email, role: actor.role }, files: ctx?.files });
      // Response hook: plugins may mutate the result.
      result = await this.d.plugins.applyToolPost(tool.serverId, tool.name, result, actor, vsId);
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
          description: 'Provided by Kravn',
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
        // Keep name/description in sync so previously-seeded rows self-heal (e.g. old "Provided by plugin").
        await this.d.repos.servers.update(id, { name: d.name, description: 'Provided by Kravn', enabled: true });
      }
      await this.connectAndSync(id);
    }
    this.refreshGauge();
  }
}
