import { fetch as undiciFetch, Agent } from 'undici';
import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native Argo CD plugin — GitOps automation over the Argo CD REST API.
 *
 * In-process, raw REST (no SDK), auth via an Argo CD API bearer token. Separate from the Kubernetes plugin on
 * purpose: Argo CD has its own API and richer domain semantics (sync, health, history, rollback, ApplicationSets)
 * than treating its Application CRDs as raw k8s objects.
 *
 * Headline use case (self-service devops): understand a live application and CLONE it across environments —
 * `argocd_get_app` to read app X's spec, then `argocd_clone_app` to stamp X into dev/qa/prod in one call.
 *
 * GOVERNANCE: read tools (list/get/manifests/history/projects/clusters) are safe. Mutating tools
 * (create/update/sync/delete app, clone, rollback, create appset) are named for the maker-checker approval gate —
 * recommended endpoint gate glob: `argocd_create_app, argocd_update_app, argocd_sync_app, argocd_delete_app,
 * argocd_clone_app, argocd_rollback_app, argocd_create_appset`. The token's Argo CD RBAC is the hard ceiling.
 *
 * Token: `argocd account generate-token` (an account with apiKey capability) or a project token.
 */
export const ARGOCD_ID = 'kravn-argocd';
const MAX_RESPONSE_BYTES = 10_000_000;

interface ArgoConfig {
  serverUrl: string; // https base, no trailing slash
  token: string;
  ca?: string;
}

function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}
function clip(s: string, max = 600): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function readArgoConfig(config: Record<string, unknown>): ArgoConfig {
  const serverUrl = String(config.serverUrl ?? '').trim().replace(/\/+$/, '');
  const token = String(config.token ?? '').trim();
  const ca = String(config.caCert ?? '').trim();
  if (!serverUrl || !token) {
    throw new Error('Argo CD is not configured: set the server URL (https://argocd.example.com) and an API token.');
  }
  if (!/^https:\/\//.test(serverUrl)) throw new Error('Argo CD server URL must be https.');
  return { serverUrl, token, ca: ca || undefined };
}

const agents = new Map<string, Agent>();
function agentFor(cfg: ArgoConfig): Agent {
  const key = `${cfg.serverUrl}\n${cfg.ca ?? ''}`;
  let a = agents.get(key);
  if (!a) {
    a = new Agent({ connect: cfg.ca ? { ca: cfg.ca } : {}, connectTimeout: 10_000 });
    agents.set(key, a);
  }
  return a;
}

async function afetch(cfg: ArgoConfig, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<any> {
  const res = await undiciFetch(`${cfg.serverUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    dispatcher: agentFor(cfg),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Argo CD rejected the request (${res.status}). Check the API token and its RBAC. (${clip(String(data?.message ?? ''), 200)})`);
  }
  if (!res.ok) throw new Error(clip(String(data?.error || data?.message || `Argo CD HTTP ${res.status}`)));
  return data;
}

function srcSummary(app: any): string {
  const s = app?.spec?.source ?? (app?.spec?.sources ?? [])[0] ?? {};
  return `${s.repoURL ?? '?'} @ ${s.targetRevision ?? 'HEAD'}${s.path ? ` (${s.path})` : ''}${s.chart ? ` chart ${s.chart}` : ''}`;
}
function appLine(app: any): string {
  const m = app?.metadata ?? {};
  const st = app?.status ?? {};
  const dest = app?.spec?.destination ?? {};
  return `• ${m.name}  [sync ${st.sync?.status ?? '?'} / health ${st.health?.status ?? '?'}]  proj ${app?.spec?.project ?? '?'}  → ${dest.namespace ?? '?'}@${dest.name || dest.server || '?'}`;
}

// ─── Tools ─────────────────────────────────────────────────────────────────────────────────────

export const ARGOCD_TOOLS: McpToolDef[] = [
  {
    name: 'argocd_list_apps',
    description: 'List Argo CD applications with sync status, health, project, destination and source. Optionally filter by project or label selector.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional: only apps in this project.' },
        selector: { type: 'string', description: 'Optional label selector, e.g. "env=prod".' },
      },
    },
  },
  {
    name: 'argocd_get_app',
    description: 'Get one application in full (spec source(s), destination, project, sync policy, plus live sync/health status and history). Use this to understand an app before cloning it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Application name.' }, appNamespace: { type: 'string', description: 'Optional app namespace (apps-in-any-namespace).' } },
      required: ['name'],
    },
  },
  {
    name: 'argocd_clone_app',
    description:
      'Clone an existing application into one or more new applications (e.g. dev/qa/prod) from its live spec. Reads the SOURCE app, then for each target creates a new Application copying the source spec with the given overrides. MUTATING.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Name of the source application to base the clones on.' },
        targets: {
          type: 'array',
          description: 'One entry per new application to create.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'New application name (required).' },
              destinationNamespace: { type: 'string', description: 'Override spec.destination.namespace.' },
              destinationServer: { type: 'string', description: 'Override spec.destination.server (cluster URL).' },
              destinationName: { type: 'string', description: 'Override spec.destination.name (named cluster).' },
              targetRevision: { type: 'string', description: 'Override the source targetRevision (branch/tag/ref).' },
              project: { type: 'string', description: 'Override spec.project.' },
              path: { type: 'string', description: 'Override the source path.' },
            },
            required: ['name'],
          },
        },
        upsert: { type: 'boolean', description: 'If true, overwrite an existing app of the same name (default false).' },
      },
      required: ['source', 'targets'],
    },
  },
  {
    name: 'argocd_create_app',
    description: 'Create an application from a full Argo CD Application manifest (JSON object). MUTATING.',
    inputSchema: {
      type: 'object',
      properties: {
        application: { type: 'object', description: 'A full Argo CD Application object (metadata.name, spec.project, spec.source(s), spec.destination, …).' },
        upsert: { type: 'boolean', description: 'Overwrite if it already exists (default false).' },
      },
      required: ['application'],
    },
  },
  {
    name: 'argocd_update_app',
    description: 'Replace an application spec with a full Application manifest (JSON object). MUTATING.',
    inputSchema: {
      type: 'object',
      properties: { application: { type: 'object', description: 'The full Application object; metadata.name must match the target.' } },
      required: ['application'],
    },
  },
  {
    name: 'argocd_sync_app',
    description: 'Trigger a sync of an application (deploy the target state). Optional prune and dryRun. MUTATING.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Application name.' },
        prune: { type: 'boolean', description: 'Prune resources no longer in git.' },
        dryRun: { type: 'boolean', description: 'Server-side dry run (no changes applied).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'argocd_delete_app',
    description: 'Delete an application. cascade=true (default) also deletes its live resources. Destructive / MUTATING.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Application name.' }, cascade: { type: 'boolean', description: 'Also delete live resources (default true).' } },
      required: ['name'],
    },
  },
  {
    name: 'argocd_get_manifests',
    description: 'Get the rendered Kubernetes manifests Argo CD would apply for an application (optionally at a revision).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Application name.' }, revision: { type: 'string', description: 'Optional git revision to render.' } },
      required: ['name'],
    },
  },
  {
    name: 'argocd_app_history',
    description: 'Show the deployment history of an application (revision + id, newest first) — the ids you can roll back to.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Application name.' } }, required: ['name'] },
  },
  {
    name: 'argocd_rollback_app',
    description: 'Roll an application back to a previous deployment history id (from argocd_app_history). MUTATING.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Application name.' }, id: { type: 'number', description: 'History id to roll back to.' } },
      required: ['name', 'id'],
    },
  },
  {
    name: 'argocd_list_projects',
    description: 'List Argo CD projects (the policy boundaries: allowed repos, destinations, cluster resources).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'argocd_list_clusters',
    description: 'List the clusters (destinations) Argo CD can deploy to, with name and server URL.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'argocd_create_appset',
    description: 'Create an ApplicationSet from a full manifest (JSON object) — e.g. a list/git generator that fans one template across dev/qa/prod. MUTATING.',
    inputSchema: {
      type: 'object',
      properties: { applicationSet: { type: 'object', description: 'A full ApplicationSet object (metadata.name, spec.generators, spec.template).' } },
      required: ['applicationSet'],
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────────────────────────────────

function objArg(args: Record<string, unknown>, key: string): any {
  const v = args[key];
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      throw new Error(`${key} must be a JSON object.`);
    }
  }
  return v;
}

async function listApps(cfg: ArgoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const qs = new URLSearchParams();
  if (args.project) qs.set('projects', String(args.project));
  if (args.selector) qs.set('selector', String(args.selector));
  const data = await afetch(cfg, 'GET', `/api/v1/applications?${qs.toString()}`);
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return text('No applications found.');
  return text(`${items.length} application(s):\n\n${items.map(appLine).join('\n')}`);
}

async function getApp(cfg: ArgoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name ?? '').trim();
  if (!name) return text('Error: name is required.', true);
  const qs = args.appNamespace ? `?appNamespace=${encodeURIComponent(String(args.appNamespace))}` : '';
  const app = await afetch(cfg, 'GET', `/api/v1/applications/${encodeURIComponent(name)}${qs}`);
  const view = {
    metadata: { name: app?.metadata?.name, namespace: app?.metadata?.namespace, labels: app?.metadata?.labels },
    spec: app?.spec,
    status: {
      sync: app?.status?.sync?.status,
      health: app?.status?.health?.status,
      revision: app?.status?.sync?.revision,
    },
  };
  return text(`# ${name}\n${srcSummary(app)}\n\n\`\`\`json\n${clip(JSON.stringify(view, null, 2), 20_000)}\n\`\`\``);
}

/** Deep-copy just the parts of a source app that make sense to clone (drop status, metadata bookkeeping). */
function baseFromSource(source: any): any {
  const spec = JSON.parse(JSON.stringify(source?.spec ?? {}));
  return { metadata: { name: '', labels: source?.metadata?.labels }, spec };
}
function applyOverrides(app: any, t: any): void {
  app.metadata.name = String(t.name);
  if (t.project) app.spec.project = String(t.project);
  const dest = (app.spec.destination = app.spec.destination ?? {});
  if (t.destinationNamespace) dest.namespace = String(t.destinationNamespace);
  if (t.destinationServer) {
    dest.server = String(t.destinationServer);
    delete dest.name;
  }
  if (t.destinationName) {
    dest.name = String(t.destinationName);
    delete dest.server;
  }
  // source may be single (spec.source) or multi (spec.sources)
  for (const src of app.spec.source ? [app.spec.source] : app.spec.sources ?? []) {
    if (t.targetRevision) src.targetRevision = String(t.targetRevision);
    if (t.path) src.path = String(t.path);
  }
}

async function cloneApp(cfg: ArgoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const source = String(args.source ?? '').trim();
  const targets: any[] = Array.isArray(args.targets) ? args.targets : [];
  if (!source || !targets.length) return text('Error: source and a non-empty targets[] are required.', true);
  const upsert = Boolean(args.upsert);
  const src = await afetch(cfg, 'GET', `/api/v1/applications/${encodeURIComponent(source)}`);
  const base = baseFromSource(src);
  const created: string[] = [];
  const failed: string[] = [];
  for (const t of targets) {
    if (!t?.name) {
      failed.push('(missing name)');
      continue;
    }
    const app = JSON.parse(JSON.stringify(base));
    try {
      applyOverrides(app, t);
      await afetch(cfg, 'POST', `/api/v1/applications?upsert=${upsert}`, app);
      created.push(String(t.name));
    } catch (err) {
      failed.push(`${t.name} (${err instanceof Error ? err.message : 'failed'})`);
    }
  }
  const lines = [`Cloned "${source}" → ${created.length}/${targets.length} created.`];
  if (created.length) lines.push(`Created: ${created.join(', ')}`);
  if (failed.length) lines.push(`Failed: ${failed.join('; ')}`);
  return text(lines.join('\n'), failed.length > 0 && created.length === 0);
}

async function createApp(cfg: ArgoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const app = objArg(args, 'application');
  if (!app?.metadata?.name) return text('Error: application.metadata.name is required.', true);
  const upsert = Boolean(args.upsert);
  const out = await afetch(cfg, 'POST', `/api/v1/applications?upsert=${upsert}`, app);
  return text(`Created application ${out?.metadata?.name}.`);
}

async function updateApp(cfg: ArgoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const app = objArg(args, 'application');
  const name = String(app?.metadata?.name ?? '').trim();
  if (!name) return text('Error: application.metadata.name is required.', true);
  await afetch(cfg, 'PUT', `/api/v1/applications/${encodeURIComponent(name)}`, app);
  return text(`Updated application ${name}.`);
}

async function syncApp(cfg: ArgoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name ?? '').trim();
  if (!name) return text('Error: name is required.', true);
  const body: Record<string, unknown> = { prune: Boolean(args.prune), dryRun: Boolean(args.dryRun) };
  const out = await afetch(cfg, 'POST', `/api/v1/applications/${encodeURIComponent(name)}/sync`, body);
  return text(`Sync requested for ${name} — sync ${out?.status?.sync?.status ?? '?'} / health ${out?.status?.health?.status ?? '?'}${args.dryRun ? ' (dry run)' : ''}.`);
}

async function deleteApp(cfg: ArgoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name ?? '').trim();
  if (!name) return text('Error: name is required.', true);
  const cascade = args.cascade === undefined ? true : Boolean(args.cascade);
  await afetch(cfg, 'DELETE', `/api/v1/applications/${encodeURIComponent(name)}?cascade=${cascade}`);
  return text(`Deleted application ${name}${cascade ? ' (and its resources)' : ''}.`);
}

async function getManifests(cfg: ArgoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name ?? '').trim();
  if (!name) return text('Error: name is required.', true);
  const qs = args.revision ? `?revision=${encodeURIComponent(String(args.revision))}` : '';
  const data = await afetch(cfg, 'GET', `/api/v1/applications/${encodeURIComponent(name)}/manifests${qs}`);
  const manifests: string[] = Array.isArray(data?.manifests) ? data.manifests : [];
  if (!manifests.length) return text(`No manifests rendered for ${name}.`);
  return text('```yaml\n' + clip(manifests.join('\n---\n'), 20_000) + '\n```');
}

async function appHistory(cfg: ArgoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name ?? '').trim();
  if (!name) return text('Error: name is required.', true);
  const app = await afetch(cfg, 'GET', `/api/v1/applications/${encodeURIComponent(name)}`);
  const hist: any[] = Array.isArray(app?.status?.history) ? app.status.history : [];
  if (!hist.length) return text(`No deployment history for ${name}.`);
  const lines = hist
    .slice()
    .reverse()
    .map((h) => `• id ${h.id}  rev ${String(h.revision ?? '').slice(0, 12)}  ${h.deployedAt ?? ''}`);
  return text(`History for ${name} (newest first):\n\n${lines.join('\n')}`);
}

async function rollbackApp(cfg: ArgoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name ?? '').trim();
  const id = Math.trunc(Number(args.id));
  if (!name || !Number.isFinite(id)) return text('Error: name and a numeric history id are required.', true);
  await afetch(cfg, 'POST', `/api/v1/applications/${encodeURIComponent(name)}/rollback`, { id });
  return text(`Rolled ${name} back to history id ${id}.`);
}

async function listProjects(cfg: ArgoConfig): Promise<McpToolResult> {
  const data = await afetch(cfg, 'GET', '/api/v1/projects');
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return text('No projects found.');
  return text(`Projects:\n\n${items.map((p) => `• ${p.metadata?.name}${p.spec?.description ? ` — ${p.spec.description}` : ''}`).join('\n')}`);
}

async function listClusters(cfg: ArgoConfig): Promise<McpToolResult> {
  const data = await afetch(cfg, 'GET', '/api/v1/clusters');
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return text('No clusters found.');
  return text(`Clusters:\n\n${items.map((c) => `• ${c.name || '(in-cluster)'} — ${c.server}`).join('\n')}`);
}

async function createAppset(cfg: ArgoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const appset = objArg(args, 'applicationSet');
  if (!appset?.metadata?.name) return text('Error: applicationSet.metadata.name is required.', true);
  const out = await afetch(cfg, 'POST', '/api/v1/applicationsets', appset);
  return text(`Created ApplicationSet ${out?.metadata?.name}.`);
}

export function argocdPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: ARGOCD_ID,
      name: 'Argo CD',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'GitOps automation over the Argo CD API: list/get applications with sync & health, create/update/sync/' +
        'delete apps, clone an app across environments (dev/qa/prod), inspect rendered manifests, roll back, and ' +
        'manage ApplicationSets. Mutating tools are named for the maker-checker approval gate; the token RBAC is ' +
        'the hard ceiling. Requires the Argo CD server URL and an API token.',
      author: 'Kravn',
      priority: 100,
      // Configure-first: needs a server URL + token, so an admin adds and configures an instance before use
      // (no empty auto-enabled default in the servers list).
      seedDisabled: true,
      configSchema: {
        type: 'object',
        properties: {
          serverUrl: { type: 'string', title: 'Server URL', description: 'Your Argo CD server, e.g. https://argocd.example.com' },
          token: {
            type: 'string',
            title: 'API Token',
            description: 'Argo CD API bearer token (`argocd account generate-token`, or a project token).',
            secret: true,
          },
          caCert: { type: 'string', title: 'Server CA (PEM)', description: 'Optional CA certificate (PEM) for a self-signed Argo CD server.' },
        },
        required: ['serverUrl', 'token'],
      },
    },
    server: {
      listTools: () => ARGOCD_TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const cfg = readArgoConfig(config);
          switch (name) {
            case 'argocd_list_apps':
              return await listApps(cfg, args);
            case 'argocd_get_app':
              return await getApp(cfg, args);
            case 'argocd_clone_app':
              return await cloneApp(cfg, args);
            case 'argocd_create_app':
              return await createApp(cfg, args);
            case 'argocd_update_app':
              return await updateApp(cfg, args);
            case 'argocd_sync_app':
              return await syncApp(cfg, args);
            case 'argocd_delete_app':
              return await deleteApp(cfg, args);
            case 'argocd_get_manifests':
              return await getManifests(cfg, args);
            case 'argocd_app_history':
              return await appHistory(cfg, args);
            case 'argocd_rollback_app':
              return await rollbackApp(cfg, args);
            case 'argocd_list_projects':
              return await listProjects(cfg);
            case 'argocd_list_clusters':
              return await listClusters(cfg);
            case 'argocd_create_appset':
              return await createAppset(cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Argo CD request failed.', true);
        }
      },
    },
  };
}
