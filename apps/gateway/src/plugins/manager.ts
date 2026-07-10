import fs from 'node:fs';
import path from 'node:path';
import {
  pluginManifestSchema,
  HOOK_POINTS,
  type KravnPlugin,
  type HookPlugin,
  type McpServerPlugin,
  type McpCallContext,
} from '@kravn/plugin-sdk';
import type { PluginView, PipelineView, PipelineStepView, PipelineTraceResult, PipelineTraceStep } from '@kravn/contracts';
import { HOOK_LIFECYCLE } from '@kravn/contracts';
import type { Repos, PluginRecord } from '../db/repos.js';
import type { LogStore } from '../logstore.js';
import type { Logger } from 'pino';
import type { Encryptor } from '../crypto.js';
import { SEED_PLUGINS } from './examples.js';

export class PluginDenied extends Error {
  constructor(public pluginId: string, message: string) {
    super(message);
    this.name = 'PluginDenied';
  }
}

interface LoadError {
  source: string;
  error: string;
}

/** Import a module from its source held in memory — no filesystem dependency. */
function dataUrl(code: string): string {
  return 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64');
}

/** How the pipeline trace builds a context for each hook point: which payload key it mutates, and its kind. */
const HOOK_TRACE_SPEC: Record<string, { kind: 'list' | 'pre' | 'post'; key: string }> = {
  onListTools: { kind: 'list', key: 'tools' },
  onListResources: { kind: 'list', key: 'resources' },
  onListPrompts: { kind: 'list', key: 'prompts' },
  onToolCall: { kind: 'pre', key: 'arguments' },
  onResourceRead: { kind: 'pre', key: 'uri' },
  onPromptGet: { kind: 'pre', key: 'arguments' },
  onResolveUser: { kind: 'pre', key: 'user' },
  onToolResult: { kind: 'post', key: 'result' },
  onResourceResult: { kind: 'post', key: 'result' },
  onPromptResult: { kind: 'post', key: 'result' },
};

function traceClone<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v ?? null));
  }
}
function traceEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Reserved scope key for the mandatory base chain (vs. a mcpEndpointId for an overlay). */
const PIPELINE_GLOBAL = 'global';
/** Hooks that are global-only (auth runs at sign-in, before any virtual server is chosen). */
const GLOBAL_ONLY_HOOKS = new Set(['onResolveUser']);

/**
 * Discovers, persists, loads and runs plugins.
 *
 * The DATABASE is the single source of truth: a plugin's module source lives in the `plugins` table,
 * so imported plugins survive pod restarts and are shared across replicas (no PVC required). Plugins
 * are loaded by importing a `data:` URL built from that source — nothing is required on disk.
 *
 * The plugins directory is an optional "inbox" for developers: any single-file plugin dropped there is
 * ingested into the DB on scan. Plugins run IN-PROCESS with the server's privileges — only install
 * plugins you trust (see PLUGINS.md → Trust model).
 */
export class PluginManager {
  private loaded = new Map<string, KravnPlugin>();
  private records = new Map<string, PluginRecord>();
  /**
   * Composed hook chains, keyed scope → hookPoint → ordered [{pluginId, enabled}]. Scope is `'global'`
   * (the mandatory base that runs for all traffic) or a mcpEndpointId (an opt-in overlay that runs, in
   * addition to global, only for calls routed through that virtual server).
   */
  private pipeline = new Map<string, Map<string, Array<{ pluginId: string; enabled: boolean }>>>();
  private loadErrors: LoadError[] = [];
  /** Native (in-code, privileged) plugins, keyed by id — not loaded from stored source. Hook OR mcp-server. */
  private native: Map<string, KravnPlugin>;
  onChange?: () => void | Promise<void>;

  constructor(
    private dir: string,
    private repos: Repos,
    private log: Logger,
    private logstore: LogStore,
    nativePlugins: KravnPlugin[] = [],
    private encryptor?: Encryptor,
  ) {
    this.native = new Map(nativePlugins.map((p) => [p.manifest.id, p]));
  }

  private isNative(id: string): boolean {
    return this.native.has(id);
  }

  /** Resolve a plugin object by id from either the native (in-code) set or the loaded (DB source) set. */
  private pluginFor(id: string): KravnPlugin | undefined {
    return this.native.get(id) ?? this.loaded.get(id);
  }

  // ─── Config secrets ──────────────────────────────────────────────────────────────────────────
  // Config fields marked `secret: true` in a plugin's configSchema (e.g. a client secret) are encrypted
  // at rest (prefixed `enc:`), decrypted only when handed to the plugin at runtime, and never returned
  // to the UI — write-only, matching how upstream-server and LLM credentials are handled.

  /** Secret field keys from a plugin manifest's configSchema. Manifest-based so instance config (stored on a
   *  server row, not a PluginRecord) can reuse the exact same encryption against the plugin TYPE's schema. */
  private secretFieldsOfManifest(manifest: unknown): string[] {
    const props = (manifest as { configSchema?: { properties?: Record<string, { secret?: boolean }> } })?.configSchema
      ?.properties;
    if (!props) return [];
    return Object.entries(props)
      .filter(([, p]) => p?.secret === true)
      .map(([k]) => k);
  }
  private secretFieldsOf(r: PluginRecord): string[] {
    return this.secretFieldsOfManifest(r.manifest);
  }

  /** Encrypt incoming secret fields against a manifest; a blank/absent secret preserves the previously stored value. */
  private encryptSecrets(manifest: unknown, incoming: Record<string, unknown>, prev: Record<string, unknown>): Record<string, unknown> {
    const out = { ...incoming };
    for (const k of this.secretFieldsOfManifest(manifest)) {
      const v = incoming[k];
      if (typeof v === 'string' && v.length > 0) {
        out[k] = this.encryptor ? this.encryptor.encrypt(v) : v; // encrypt() is prefixed + idempotent
      } else if (prev[k] !== undefined) {
        out[k] = prev[k]; // write-only: keep the existing secret when the field is left blank
      } else {
        delete out[k];
      }
    }
    return out;
  }
  private encryptConfig(r: PluginRecord, incoming: Record<string, unknown>, prev: Record<string, unknown>): Record<string, unknown> {
    return this.encryptSecrets(r.manifest, incoming, prev);
  }

  /** Decrypt secret fields (against a manifest) for runtime use by the plugin. */
  private decryptSecrets(manifest: unknown, config: Record<string, unknown>): Record<string, unknown> {
    const out = { ...config };
    if (!this.encryptor) return out;
    for (const k of this.secretFieldsOfManifest(manifest)) {
      const v = out[k];
      if (typeof v === 'string' && this.encryptor.isEncrypted(v)) {
        try {
          out[k] = this.encryptor.decrypt(v);
        } catch {
          out[k] = '';
        }
      }
    }
    return out;
  }
  private decryptConfig(r: PluginRecord): Record<string, unknown> {
    return this.decryptSecrets(r.manifest, r.config);
  }

  /** Strip secret values for the UI, plus a map of which secrets are currently set. */
  private maskConfig(r: PluginRecord): { config: Record<string, unknown>; secretsSet: Record<string, boolean> } {
    const config = { ...r.config };
    const secretsSet: Record<string, boolean> = {};
    for (const k of this.secretFieldsOf(r)) {
      secretsSet[k] = typeof config[k] === 'string' && (config[k] as string).length > 0;
      config[k] = '';
    }
    return { config, secretsSet };
  }

  // ─── Loading (from source held in the DB / memory) ─────────────────────────────────────────────

  private async loadModule(code: string): Promise<KravnPlugin> {
    const mod = await import(dataUrl(code));
    const plugin = (mod.default ?? mod.plugin) as KravnPlugin | undefined;
    if (!plugin || typeof plugin !== 'object' || !('manifest' in plugin)) {
      throw new Error('module does not default-export a plugin object with a manifest');
    }
    return plugin;
  }

  private validateShape(plugin: KravnPlugin, type: string): void {
    if (type === 'hook') {
      if (!('hooks' in plugin) || typeof (plugin as HookPlugin).hooks !== 'object') {
        throw new Error("hook plugin must export a 'hooks' object");
      }
    } else if (type === 'mcp-server') {
      const s = (plugin as McpServerPlugin).server;
      if (!s || typeof s.listTools !== 'function' || typeof s.callTool !== 'function') {
        throw new Error("mcp-server plugin must export 'server' with listTools() and callTool()");
      }
    }
  }

  /** Validate source and persist it to the DB (preserving enabled/config). Returns the plugin id. */
  private async ingest(code: string, origin: string): Promise<string> {
    const plugin = await this.loadModule(code);
    const manifest = pluginManifestSchema.parse((plugin as KravnPlugin).manifest);
    this.validateShape(plugin as KravnPlugin, manifest.type);
    await this.repos.plugins.upsertDiscovered({
      id: manifest.id,
      type: manifest.type,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      priority: manifest.priority,
      source: origin,
      code,
      manifest,
    });
    return manifest.id;
  }

  // ─── Discovery / scan ──────────────────────────────────────────────────────────────────────────

  private inboxFiles(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((n) => !n.startsWith('.') && (n.endsWith('.mjs') || n.endsWith('.js')));
    } catch {
      return [];
    }
  }

  async scan(): Promise<void> {
    this.loadErrors = [];

    // Example plugins: seed into an empty DB (disabled), and refresh existing ones so manifest/code
    // stay current — but never resurrect an example the operator has deleted.
    const existing = await this.repos.plugins.list();
    const dbEmpty = existing.length === 0;
    const existingIds = new Set(existing.map((r) => r.id));
    for (const ex of SEED_PLUGINS) {
      if (!dbEmpty && !existingIds.has(ex.id)) continue;
      try {
        await this.ingest(ex.source, `example:${ex.filename}`);
      } catch (err) {
        this.log.warn({ err, file: ex.filename }, 'failed to seed example plugin');
      }
    }

    // Native (built-in) plugins: always present (re-seeded if removed), enabled by default on first install.
    // They run in-code (privileged); the DB record only manages metadata + enabled/config state.
    for (const n of this.native.values()) {
      try {
        this.validateShape(n, n.manifest.type); // catch a malformed native server at seed time
        const m = pluginManifestSchema.parse(n.manifest);
        await this.repos.plugins.upsertDiscovered({
          id: m.id,
          type: m.type,
          name: m.name,
          version: m.version,
          description: m.description,
          author: m.author,
          priority: m.priority,
          source: 'native',
          code: '',
          manifest: m,
        });
        // Enable on first install — unless the plugin requires config (credentials), in which case it
        // stays disabled until the operator fills it in, so unconfigured tools don't pollute the catalog.
        const req = (n.manifest as { configSchema?: { required?: unknown[] } })?.configSchema?.required;
        const needsConfig = Array.isArray(req) && req.length > 0;
        // Native mcp-servers (tools) enable on first install unless they need config; native HOOK plugins
        // (content interceptors) start DISABLED — they change behaviour, so the operator opts in + composes them.
        if (!existingIds.has(m.id)) await this.repos.plugins.setEnabled(m.id, m.type === 'mcp-server' && !needsConfig);
      } catch (err) {
        this.log.warn({ err, plugin: n.manifest.id }, 'failed to seed native plugin');
      }
    }

    // Ingest any single-file plugins dropped in the inbox directory (developer convenience).
    for (const file of this.inboxFiles()) {
      try {
        const code = fs.readFileSync(path.join(this.dir, file), 'utf8');
        await this.ingest(code, file);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.loadErrors.push({ source: file, error: message });
        this.log.warn({ err, file }, 'failed to ingest inbox plugin');
      }
    }

    // Load every plugin from the DB (the source of truth) via in-memory data: URLs.
    this.loaded.clear();
    for (const rec of await this.repos.plugins.list()) {
      if (this.isNative(rec.id)) continue; // native plugins are in-code, not loaded from stored source
      if (!rec.code) {
        await this.repos.plugins.setError(rec.id, 'no source stored');
        continue;
      }
      try {
        const plugin = await this.loadModule(rec.code);
        this.validateShape(plugin, rec.type);
        this.loaded.set(rec.id, plugin);
        if (rec.error) await this.repos.plugins.setError(rec.id, '');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.repos.plugins.setError(rec.id, message);
        this.loadErrors.push({ source: rec.source || rec.id, error: message });
        this.log.warn({ err, plugin: rec.id }, 'failed to load plugin');
      }
    }

    await this.refreshRecords();
    await this.onChange?.();
    this.log.info({ loaded: this.loaded.size, errors: this.loadErrors.length }, 'plugin scan complete');
  }

  private async refreshRecords(): Promise<void> {
    const list = await this.repos.plugins.list();
    this.records = new Map(list.map((r) => [r.id, r]));
    // Pipelines are OPT-IN at every scope (global included): a plugin runs only where the admin explicitly
    // adds it to a junction. Nothing is auto-seeded — so with N plugins the chains stay curated, not a wall.
    await this.loadPipeline();
  }

  /** Raw hook method keys a loaded hook plugin implements (e.g. ['onToolCall','onToolResult']). */
  private hookMethodsOf(id: string): string[] {
    const p = this.pluginFor(id) as HookPlugin | undefined;
    if (!p || !('hooks' in p) || !p.hooks) return [];
    return Object.keys(p.hooks).filter((k) => typeof (p.hooks as any)[k] === 'function' && HOOK_POINTS[k]);
  }

  private async loadPipeline(): Promise<void> {
    const steps = await this.repos.pipeline.list(); // ordered by scope, hook_point, position
    const map = new Map<string, Map<string, Array<{ pluginId: string; enabled: boolean }>>>();
    for (const s of steps) {
      let byMethod = map.get(s.scope);
      if (!byMethod) map.set(s.scope, (byMethod = new Map()));
      const arr = byMethod.get(s.hookPoint) ?? [];
      arr.push({ pluginId: s.pluginId, enabled: s.enabled });
      byMethod.set(s.hookPoint, arr);
    }
    this.pipeline = map;
  }

  /** Reload the in-memory pipeline chains from the DB (call after external mutations, e.g. a VS removal). */
  async reloadPipeline(): Promise<void> {
    await this.loadPipeline();
  }

  /** Enabled step records for one scope+method, in stored order (or [] if that scope has no chain there). */
  private scopeChain(scope: string, method: string): Array<PluginRecord | undefined> {
    const order = this.pipeline.get(scope)?.get(method);
    return order ? order.filter((s) => s.enabled).map((s) => this.records.get(s.pluginId)) : [];
  }

  private logger(id: string): (m: string) => void {
    return (m: string) => this.logstore.add('info', `[plugin:${id}] ${m}`);
  }

  // ─── Hook execution ──────────────────────────────────────────────────────────────────────────

  private enabledHooks(method: string, vsId?: string) {
    // GLOBAL base (opt-in): the plugins the admin explicitly added to this junction, in order. Empty ⇒ none.
    const globalRecs = this.scopeChain(PIPELINE_GLOBAL, method);
    // Per-VS OVERLAY (opt-in): runs AFTER the global base, only for calls routed through this virtual server.
    const vsRecs = vsId && !GLOBAL_ONLY_HOOKS.has(method) ? this.scopeChain(vsId, method) : [];
    const seen = new Set<string>();
    return [...globalRecs, ...vsRecs]
      .filter((r): r is PluginRecord => !!r && r.enabled && r.type === 'hook') // r.enabled = global master switch
      .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))) // a plugin runs at most once per junction
      .map((r) => ({ r, plugin: this.pluginFor(r.id) as HookPlugin | undefined }))
      .filter((x) => x.plugin && x.plugin.hooks && typeof (x.plugin.hooks as any)[method] === 'function')
      .map((x) => ({ id: x.r.id, plugin: x.plugin as HookPlugin, config: this.decryptConfig(x.r) }));
  }

  hasResolveUser(): boolean {
    return this.enabledHooks('onResolveUser').length > 0;
  }

  // ─── Pipeline composition (per-hook-point ordering) ────────────────────────────────────────────

  /**
   * The pipeline view for one scope: `'global'` (the base) or a mcpEndpointId (an overlay). For a VS scope,
   * each junction also carries the `inherited` global steps (read-only) and the `available` plugins you can add.
   * The global-only auth junction is omitted under a VS scope.
   */
  pipelineView(scope: string = PIPELINE_GLOBAL): PipelineView {
    const isGlobal = scope === PIPELINE_GLOBAL;
    const scopes = HOOK_LIFECYCLE.map((sc) => ({
      key: sc.key,
      label: sc.label,
      spine: sc.spine,
      points: sc.points
        .filter((pt) => isGlobal || !GLOBAL_ONLY_HOOKS.has(pt.method))
        .map((pt) => ({
          ...pt,
          steps: this.stepsForScope(scope, pt.method),
          inherited: isGlobal ? [] : this.stepsForScope(PIPELINE_GLOBAL, pt.method),
          available: this.availableFor(scope, pt.method),
        })),
    })).filter((sc) => sc.points.length > 0);
    return { scope, global: isGlobal, scopes };
  }

  private stepView = (r: PluginRecord, enabled: boolean): PipelineStepView => ({
    pluginId: r.id,
    name: r.name,
    description: r.description,
    enabled,
    pluginEnabled: r.enabled,
  });

  /** Ordered steps EXPLICITLY added to one scope+junction (opt-in at every scope, global included). */
  private stepsForScope(scope: string, method: string): PipelineStepView[] {
    const out: PipelineStepView[] = [];
    const seen = new Set<string>();
    for (const s of this.pipeline.get(scope)?.get(method) ?? []) {
      const r = this.records.get(s.pluginId);
      // Only show steps whose plugin still exists AND still implements this junction.
      if (!r || seen.has(s.pluginId) || r.type !== 'hook' || !this.hookMethodsOf(s.pluginId).includes(method)) continue;
      out.push(this.stepView(r, s.enabled));
      seen.add(s.pluginId);
    }
    return out;
  }

  /** Hook plugins that implement this junction but aren't in this scope's chain yet (the "add" picker).
   *  Only ENABLED plugins (the org-level master switch on the Plugins screen) are offered — you can't add
   *  one that can't run; enable it first. */
  private availableFor(scope: string, method: string): Array<{ pluginId: string; name: string }> {
    const inScope = new Set((this.pipeline.get(scope)?.get(method) ?? []).map((s) => s.pluginId));
    return [...this.records.values()]
      .filter((r) => r.enabled && r.type === 'hook' && !inScope.has(r.id) && this.hookMethodsOf(r.id).includes(method))
      .map((r) => ({ pluginId: r.id, name: r.name }));
  }

  /** Replace the ordered chain at one junction, for one scope. Validates the scope and that plugins fit. */
  async setPipeline(scope: string, hookPoint: string, steps: Array<{ pluginId: string; enabled: boolean }>): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(HOOK_POINTS, hookPoint)) throw new Error('Unknown hook point.');
    const isGlobal = scope === PIPELINE_GLOBAL;
    if (!isGlobal) {
      if (GLOBAL_ONLY_HOOKS.has(hookPoint)) throw new Error(`${hookPoint} runs globally and cannot be overlaid per virtual server.`);
      if (!(await this.repos.mcpEndpoints.getById(scope))) throw new Error('Unknown virtual server.');
    }
    const seen = new Set<string>();
    const clean: Array<{ pluginId: string; enabled: boolean }> = [];
    for (const s of steps) {
      if (seen.has(s.pluginId)) continue; // a plugin appears at most once per junction
      if (!this.hookMethodsOf(s.pluginId).includes(hookPoint)) {
        throw new Error(`Plugin '${s.pluginId}' does not implement ${hookPoint}.`);
      }
      seen.add(s.pluginId);
      clean.push({ pluginId: s.pluginId, enabled: s.enabled });
    }
    // Opt-in at every scope: the chain is EXACTLY what was submitted (order = position). Omitted plugins are
    // simply not part of it — nothing is auto-added.
    await this.repos.pipeline.replaceHook(scope, hookPoint, clean);
    await this.loadPipeline();
    await this.onChange?.();
  }

  /**
   * Dry-run a junction's EFFECTIVE chain (global base + the given scope's overlay) on a sample payload,
   * capturing each step's before/after (and any deny). Runs the REAL plugin code on synthetic admin input.
   */
  async trace(scope: string, hookPoint: string, payload: unknown, hints: { server?: string; tool?: string } = {}): Promise<PipelineTraceResult> {
    const spec = Object.prototype.hasOwnProperty.call(HOOK_TRACE_SPEC, hookPoint) ? HOOK_TRACE_SPEC[hookPoint] : undefined;
    if (!spec) throw new Error('Unknown hook point.');
    const vsId = scope === PIPELINE_GLOBAL ? undefined : scope;
    if (vsId && GLOBAL_ONLY_HOOKS.has(hookPoint)) throw new Error(`${hookPoint} runs globally, not per virtual server.`);
    const extra: Record<string, unknown> =
      spec.kind === 'list' || hookPoint === 'onResolveUser'
        ? {}
        : { server: hints.server ?? 'sample-server', tool: hints.tool ?? 'sample-tool', prompt: hints.tool ?? 'sample-prompt' };
    const actor = { id: 'trace', email: 'trace@local', role: 'admin' };
    let current = traceClone(payload);
    const input = traceClone(current);
    const steps: PipelineTraceStep[] = [];
    let denied: { pluginId: string; reason: string } | undefined;

    for (const h of this.enabledHooks(hookPoint, vsId)) {
      const before = traceClone(current);
      const name = this.records.get(h.id)?.name ?? h.id;
      let denyReason: string | null = null;
      let error: string | undefined;
      const ctx: any = { ...extra, [spec.key]: current, actor, mcpEndpointId: vsId, config: h.config, log: this.logger(h.id), deny: (r: string) => { denyReason = r; } };
      try {
        await (h.plugin.hooks as any)[hookPoint](ctx);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      if (denyReason != null) {
        steps.push({ pluginId: h.id, name, before, after: before, changed: false, denied: denyReason });
        denied = { pluginId: h.id, reason: denyReason };
        break;
      }
      const after = traceClone(ctx[spec.key]);
      steps.push({ pluginId: h.id, name, before, after, changed: !traceEqual(before, after), error });
      current = ctx[spec.key];
    }
    return { hookPoint, kind: spec.kind, input, output: traceClone(current), steps, denied };
  }

  /** List filter (tools/resources/prompts): plugins may filter/annotate the array. */
  private async applyList(method: string, key: string, items: any[], actor?: any, vsId?: string): Promise<any[]> {
    let current = items;
    for (const h of this.enabledHooks(method, vsId)) {
      const ctx: any = { [key]: current, actor, mcpEndpointId: vsId, config: h.config, log: this.logger(h.id) };
      try {
        await (h.plugin.hooks as any)[method](ctx);
        current = ctx[key];
      } catch (err) {
        this.log.warn({ err, plugin: h.id, method }, 'list hook failed (skipped)');
      }
    }
    return current;
  }

  /** Pre hook: plugins may mutate `value` or deny. */
  private async applyPre(method: string, key: string, extra: object, value: any, actor?: any, vsId?: string): Promise<any> {
    let current = value;
    for (const h of this.enabledHooks(method, vsId)) {
      let denied: string | null = null;
      const ctx: any = { ...extra, [key]: current, actor, mcpEndpointId: vsId, config: h.config, log: this.logger(h.id), deny: (r: string) => { denied = r; } };
      try {
        await (h.plugin.hooks as any)[method](ctx);
      } catch (err) {
        this.log.warn({ err, plugin: h.id, method }, 'pre hook failed (skipped, fail-open)');
        continue;
      }
      if (denied != null) throw new PluginDenied(h.id, denied);
      current = ctx[key];
    }
    return current;
  }

  /** Post hook: plugins may mutate the result. */
  private async applyPost(method: string, extra: object, result: any, actor?: any, vsId?: string): Promise<any> {
    let current = result;
    for (const h of this.enabledHooks(method, vsId)) {
      const ctx: any = { ...extra, result: current, actor, mcpEndpointId: vsId, config: h.config, log: this.logger(h.id) };
      try {
        await (h.plugin.hooks as any)[method](ctx);
        current = ctx.result;
      } catch (err) {
        this.log.warn({ err, plugin: h.id, method }, 'post hook failed (skipped)');
      }
    }
    return current;
  }

  // Tools
  applyListTools(tools: any[], actor?: any, vsId?: string) { return this.applyList('onListTools', 'tools', tools, actor, vsId); }
  applyToolPre(server: string, tool: string, args: Record<string, unknown>, actor?: any, vsId?: string) {
    return this.applyPre('onToolCall', 'arguments', { server, tool }, args, actor, vsId) as Promise<Record<string, unknown>>;
  }
  applyToolPost(server: string, tool: string, result: any, actor?: any, vsId?: string) {
    return this.applyPost('onToolResult', { server, tool }, result, actor, vsId);
  }

  // Resources
  applyListResources(resources: any[], actor?: any, vsId?: string) { return this.applyList('onListResources', 'resources', resources, actor, vsId); }
  applyResourcePre(server: string, uri: string, actor?: any, vsId?: string) {
    return this.applyPre('onResourceRead', 'uri', { server }, uri, actor, vsId) as Promise<string>;
  }
  applyResourcePost(server: string, uri: string, result: any, actor?: any, vsId?: string) {
    return this.applyPost('onResourceResult', { server, uri }, result, actor, vsId);
  }

  // Prompts
  applyListPrompts(prompts: any[], actor?: any, vsId?: string) { return this.applyList('onListPrompts', 'prompts', prompts, actor, vsId); }
  applyPromptPre(server: string, prompt: string, args: Record<string, unknown>, actor?: any, vsId?: string) {
    return this.applyPre('onPromptGet', 'arguments', { server, prompt }, args, actor, vsId) as Promise<Record<string, unknown>>;
  }
  applyPromptPost(server: string, prompt: string, result: any, actor?: any, vsId?: string) {
    return this.applyPost('onPromptResult', { server, prompt }, result, actor, vsId);
  }

  // Auth
  async applyResolveUser<T extends object>(user: T): Promise<T> {
    let current = user;
    for (const h of this.enabledHooks('onResolveUser')) {
      let denied: string | null = null;
      const ctx: any = { user: current, actor: current, config: h.config, log: this.logger(h.id), deny: (r: string) => { denied = r; } };
      try {
        await (h.plugin.hooks as any).onResolveUser(ctx);
      } catch (err) {
        this.log.warn({ err, plugin: h.id }, 'onResolveUser hook failed (skipped)');
        continue;
      }
      if (denied != null) throw new PluginDenied(h.id, denied);
      current = ctx.user;
    }
    return current;
  }

  /** Human labels of the hook points a hook plugin implements (for the admin UI). Resolves native ∪ loaded. */
  private hookPointsOf(id: string): string[] {
    const p = this.pluginFor(id) as HookPlugin | undefined;
    if (!p || !('hooks' in p) || !p.hooks) return [];
    return Object.keys(p.hooks)
      .filter((k) => typeof (p.hooks as any)[k] === 'function' && HOOK_POINTS[k])
      .map((k) => HOOK_POINTS[k]);
  }

  // ─── MCP-server plugins ──────────────────────────────────────────────────────────────────────

  enabledMcpServers(): Array<{ id: string; name: string }> {
    return [...this.records.values()]
      .filter((r) => r.enabled && r.type === 'mcp-server' && (this.loaded.has(r.id) || this.isNative(r.id)))
      .map((r) => ({ id: r.id, name: r.name }));
  }

  /** All mcp-server plugin TYPE ids (native or loaded), regardless of enabled — for instance validation + GC.
   *  An instance is independent of the type's "default" enabled state (it has its own config + server enabled). */
  mcpServerTypeIds(): Set<string> {
    return new Set(
      [...this.records.values()]
        .filter((r) => r.type === 'mcp-server' && (this.loaded.has(r.id) || this.isNative(r.id)))
        .map((r) => r.id),
    );
  }

  /** Resolve the plugin TYPE object + record by plugin id (no config yet). */
  private mcpPluginObject(typeId: string): { plugin: McpServerPlugin; record: PluginRecord } {
    const r = this.records.get(typeId);
    // Native plugins are in-code; user/imported ones come from the loaded map.
    const p = (this.native.get(typeId) ?? this.loaded.get(typeId)) as McpServerPlugin | undefined;
    // No `enabled` gate here: a plugin INSTANCE runs based on its own server's enabled flag, independent of the
    // type's "default" enabled state (which only governs the auto-created default instance).
    if (!r || r.type !== 'mcp-server' || !p) {
      throw new Error(`plugin server '${typeId}' is not available`);
    }
    return { plugin: p, record: r };
  }

  /** Config for a call: a specific INSTANCE's plugin_config (from its server row) if present, else the plugin
   *  TYPE's own config (the "default instance" — the pre-existing seeded config, unchanged). Secrets decrypted
   *  against the TYPE's configSchema either way. */
  private async resolveConfig(record: PluginRecord, instanceServerId?: string): Promise<Record<string, unknown>> {
    if (instanceServerId) {
      const raw = await this.repos.servers.getPluginConfig(instanceServerId);
      if (raw && raw !== '{}') {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* fall through to the type config */
        }
        return this.decryptSecrets(record.manifest, parsed);
      }
    }
    return this.decryptConfig(record);
  }

  async serverListTools(id: string, instanceServerId?: string) {
    const { plugin, record } = this.mcpPluginObject(id);
    return { tools: await plugin.server.listTools(await this.resolveConfig(record, instanceServerId)) };
  }
  async serverListResources(id: string, instanceServerId?: string) {
    const { plugin, record } = this.mcpPluginObject(id);
    return { resources: plugin.server.listResources ? await plugin.server.listResources(await this.resolveConfig(record, instanceServerId)) : [] };
  }
  async serverListPrompts(id: string, instanceServerId?: string) {
    const { plugin, record } = this.mcpPluginObject(id);
    return { prompts: plugin.server.listPrompts ? await plugin.server.listPrompts(await this.resolveConfig(record, instanceServerId)) : [] };
  }
  async serverCallTool(id: string, name: string, args: Record<string, unknown>, ctx?: McpCallContext, instanceServerId?: string) {
    const { plugin, record } = this.mcpPluginObject(id);
    return plugin.server.callTool(name, args, await this.resolveConfig(record, instanceServerId), ctx);
  }
  async serverReadResource(id: string, uri: string, instanceServerId?: string) {
    const { plugin, record } = this.mcpPluginObject(id);
    if (!plugin.server.readResource) throw new Error('plugin does not support resources');
    return plugin.server.readResource(uri, await this.resolveConfig(record, instanceServerId));
  }
  async serverGetPrompt(id: string, name: string, args: Record<string, unknown>, instanceServerId?: string) {
    const { plugin, record } = this.mcpPluginObject(id);
    if (!plugin.server.getPrompt) throw new Error('plugin does not support prompts');
    return plugin.server.getPrompt(name, args, await this.resolveConfig(record, instanceServerId));
  }

  /** Create/update a native-plugin INSTANCE's config, stored (secrets encrypted, write-only preserve) on its
   *  server row. `typeId` is the plugin type (the server's `command`). */
  async setInstanceConfig(instanceServerId: string, typeId: string, config: Record<string, unknown>): Promise<void> {
    const r = this.records.get(typeId);
    if (!r) throw new Error('Unknown plugin type.');
    let prev: Record<string, unknown> = {};
    const raw = await this.repos.servers.getPluginConfig(instanceServerId);
    if (raw) {
      try {
        prev = JSON.parse(raw);
      } catch {
        /* ignore */
      }
    }
    await this.repos.servers.setPluginConfig(instanceServerId, JSON.stringify(this.encryptSecrets(r.manifest, config, prev)));
    await this.onChange?.();
  }

  /** Masked view of an instance's config for the UI (secret values blanked + which are set). */
  async instanceConfigView(instanceServerId: string, typeId: string): Promise<{ config: Record<string, unknown>; secretsSet: Record<string, boolean> }> {
    const r = this.records.get(typeId);
    const raw = await this.repos.servers.getPluginConfig(instanceServerId);
    let cfg: Record<string, unknown> = {};
    if (raw) {
      try {
        cfg = JSON.parse(raw);
      } catch {
        /* ignore */
      }
    }
    const config = { ...cfg };
    const secretsSet: Record<string, boolean> = {};
    for (const k of this.secretFieldsOfManifest(r?.manifest)) {
      secretsSet[k] = typeof config[k] === 'string' && (config[k] as string).length > 0;
      config[k] = '';
    }
    return { config, secretsSet };
  }

  // ─── Management ──────────────────────────────────────────────────────────────────────────────

  list(): { plugins: PluginView[]; loadErrors: LoadError[] } {
    return { plugins: [...this.records.values()].map((r) => this.toView(r)), loadErrors: this.loadErrors };
  }

  private toView(r: PluginRecord): PluginView {
    const { config, secretsSet } = this.maskConfig(r);
    return {
      id: r.id,
      name: r.name,
      version: r.version,
      type: r.type,
      description: r.description,
      author: r.author,
      priority: r.priority,
      enabled: r.enabled,
      source: r.source,
      error: r.error,
      config,
      configSecretsSet: secretsSet,
      configSchema: (r.manifest as any)?.configSchema,
      setup: (r.manifest as any)?.setup,
      hookPoints: r.type === 'hook' ? this.hookPointsOf(r.id) : [],
      installedAt: r.installedAt,
      updatedAt: r.updatedAt,
    };
  }

  /** Is a plugin (e.g. a native one like the code interpreter) currently enabled? */
  isEnabled(id: string): boolean {
    return this.records.get(id)?.enabled ?? false;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (!this.records.has(id)) throw new Error('Unknown plugin.');
    // Native plugins are in-code (not in `loaded`); only guard against enabling failed user plugins.
    if (enabled && !this.isNative(id) && !this.loaded.has(id)) throw new Error('Cannot enable a plugin that failed to load.');
    await this.repos.plugins.setEnabled(id, enabled);
    await this.refreshRecords();
    await this.onChange?.();
  }

  async setConfig(id: string, config: Record<string, unknown>): Promise<void> {
    const r = this.records.get(id);
    if (!r) throw new Error('Unknown plugin.');
    await this.repos.plugins.setConfig(id, this.encryptConfig(r, config, r.config));
    await this.refreshRecords();
    await this.onChange?.();
  }

  /** Install a plugin from pasted source: persisted to the DB, then reloaded. */
  async importSource(_idHint: string, source: string): Promise<PluginView> {
    let id: string;
    try {
      id = await this.ingest(source, 'import');
    } catch (err) {
      throw new Error(`Plugin failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.scan();
    const rec = this.records.get(id);
    if (!rec) throw new Error('Plugin did not register.');
    return this.toView(rec);
  }

  async remove(id: string): Promise<void> {
    // Native plugins are built-in: they'd just be re-seeded (and re-enabled) on the next scan, so
    // "delete" would silently revert a prior disable. Disable them instead.
    if (this.isNative(id)) throw new Error('Built-in plugins cannot be removed — disable it instead.');
    const rec = this.records.get(id);
    await this.repos.plugins.delete(id);
    await this.repos.pipeline.deleteByPlugin(id); // drop its steps from every junction
    // Best-effort: also remove a matching inbox file so it isn't re-ingested next scan.
    if (rec?.source && /\.(mjs|js)$/.test(rec.source)) {
      try {
        fs.rmSync(path.join(this.dir, rec.source), { force: true });
      } catch {
        /* ignore */
      }
    }
    await this.scan();
  }
}
