import { readFileSync } from 'node:fs';
import { fetch as undiciFetch, Agent } from 'undici';
import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native Kubernetes plugin — drive any Kubernetes cluster over MCP via the Kubernetes REST API.
 *
 * In-process (no external runner, no heavy client SDK — raw REST to the API server, like the cloud plugins), so
 * the image stays lean. Auth is a bearer token + the cluster CA:
 *  - IN-CLUSTER (default): if no `apiServer` is configured, use the pod's ServiceAccount — token + CA from
 *    /var/run/secrets/kubernetes.io/serviceaccount and the KUBERNETES_SERVICE_HOST/PORT env. Zero config for the
 *    cluster Kravn runs in. The pod's ServiceAccount RBAC is the ceiling of what these tools can do.
 *  - PER-INSTANCE (other clusters): set `apiServer` + a ServiceAccount `token` (+ the cluster `caCert` for TLS).
 *    Every integration is multi-instance, so one Kravn can talk to many clusters, each with its own scoped RBAC.
 *
 * GOVERNANCE: this is the highest-risk integration — it can delete workloads and read/mutate secrets. Read tools
 * (k8s_get/list/logs/events/api_resources/top) are safe; the MUTATING + secret-reading tools are named so an
 * admin can hold them for maker-checker approval via the pipeline approval-gate. Recommended gate glob on the
 * endpoint: `k8s_apply, k8s_delete, k8s_patch, k8s_scale, k8s_rollout_restart, k8s_get_secret`. k8s_get redacts
 * Secret values by default; the explicit (gate-able) k8s_get_secret returns them decoded.
 */
export const K8S_ID = 'kravn-kubernetes';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const MAX_RESPONSE_BYTES = 10_000_000;

interface KubeConfig {
  apiServer: string; // https base, no trailing slash
  token: string;
  ca?: string; // PEM; undefined -> verify with system CAs
  namespace: string; // default namespace for namespaced ops
}

function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}
function clip(s: string, max = 600): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function readKubeConfig(config: Record<string, unknown>): KubeConfig {
  let apiServer = String(config.apiServer ?? '').trim().replace(/\/+$/, '');
  let token = String(config.token ?? '').trim();
  let ca = String(config.caCert ?? '').trim();
  const namespace = String(config.namespace ?? '').trim() || 'default';

  // In-cluster fallback when no explicit API server is configured.
  if (!apiServer) {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || '443';
    if (!host) {
      throw new Error(
        'Kubernetes is not configured: set the API server URL + a ServiceAccount token (+ cluster CA), or run ' +
          'Kravn in-cluster so the pod ServiceAccount can be used.',
      );
    }
    apiServer = `https://${host}:${port}`;
    if (!token) {
      try {
        token = readFileSync(`${SA_DIR}/token`, 'utf8').trim();
      } catch {
        /* fall through to the check below */
      }
    }
    if (!ca) {
      try {
        ca = readFileSync(`${SA_DIR}/ca.crt`, 'utf8');
      } catch {
        /* no in-cluster CA available */
      }
    }
  }

  if (!/^https:\/\//.test(apiServer)) throw new Error('Kubernetes API server URL must be https.');
  if (!token) throw new Error('No Kubernetes token: set a ServiceAccount token, or run in-cluster with a mounted ServiceAccount.');
  return { apiServer, token, ca: ca || undefined, namespace };
}

// Cache one undici Agent per (apiServer + CA) so we do not rebuild the TLS context on every call.
const agents = new Map<string, Agent>();
function agentFor(cfg: KubeConfig): Agent {
  const key = `${cfg.apiServer}\n${cfg.ca ?? ''}`;
  let a = agents.get(key);
  if (!a) {
    a = new Agent({ connect: cfg.ca ? { ca: cfg.ca } : {}, connectTimeout: 10_000 });
    agents.set(key, a);
  }
  return a;
}

async function kfetch(
  cfg: KubeConfig,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  contentType = 'application/json',
): Promise<any> {
  const res = await undiciFetch(`${cfg.apiServer}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': contentType } : {}),
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
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
    throw new Error(
      `Kubernetes rejected the request (${res.status}). The token's RBAC does not allow this — grant the ` +
        `ServiceAccount permission for this verb/resource. (${clip(String(data?.message ?? ''), 200)})`,
    );
  }
  if (!res.ok) {
    throw new Error(clip(String(data?.message || `Kubernetes HTTP ${res.status}`)));
  }
  return data;
}

// ─── API discovery + path resolution ────────────────────────────────────────────────────────────

function apiBase(apiVersion: string): string {
  // "v1" -> /api/v1 (core group) ; "apps/v1" -> /apis/apps/v1 (named group)
  return apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
}

const discoveryCache = new Map<string, any[]>();
async function resourcesFor(cfg: KubeConfig, apiVersion: string): Promise<any[]> {
  const key = `${cfg.apiServer}\n${apiVersion}`;
  const cached = discoveryCache.get(key);
  if (cached) return cached;
  const data = await kfetch(cfg, 'GET', apiBase(apiVersion));
  const list: any[] = Array.isArray(data?.resources) ? data.resources : [];
  discoveryCache.set(key, list);
  return list;
}

/** Resolve (apiVersion, kind) to its REST resource name + whether it is namespaced, via discovery. */
async function resolveResource(cfg: KubeConfig, apiVersion: string, kind: string): Promise<{ resource: string; namespaced: boolean }> {
  const list = await resourcesFor(cfg, apiVersion);
  const r = list.find((x: any) => x.kind === kind && typeof x.name === 'string' && !x.name.includes('/'));
  if (!r) throw new Error(`Kind "${kind}" not found in apiVersion "${apiVersion}". Run k8s_api_resources to discover valid kinds.`);
  return { resource: r.name, namespaced: !!r.namespaced };
}

function resourcePath(apiVersion: string, resource: string, namespaced: boolean, namespace: string, name?: string): string {
  const base = apiBase(apiVersion);
  const nsPart = namespaced && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : '';
  const namePart = name ? `/${encodeURIComponent(name)}` : '';
  return `${base}${nsPart}/${resource}${namePart}`;
}

function ns(cfg: KubeConfig, args: Record<string, unknown>): string {
  return String(args.namespace ?? '').trim() || cfg.namespace;
}

/** Redact Secret `.data`/`.stringData` values (keys stay visible) so a plain k8s_get can't leak credentials. */
function redactSecret(obj: any): any {
  if (obj?.kind === 'Secret' && obj?.data && typeof obj.data === 'object') {
    obj = { ...obj, data: Object.fromEntries(Object.keys(obj.data).map((k) => [k, '«redacted — use k8s_get_secret»'])) };
  }
  return obj;
}
function summarizeItem(it: any): string {
  const m = it?.metadata ?? {};
  const kind = it?.kind ?? '';
  const phase = it?.status?.phase ?? it?.status?.conditions?.slice(-1)?.[0]?.type ?? '';
  const ready =
    it?.status?.readyReplicas !== undefined ? ` ${it.status.readyReplicas ?? 0}/${it.spec?.replicas ?? '?'} ready` : '';
  return `• ${m.namespace ? `${m.namespace}/` : ''}${m.name}${kind ? `  (${kind})` : ''}${phase ? `  [${phase}]` : ''}${ready}`;
}

// ─── Tools ─────────────────────────────────────────────────────────────────────────────────────

const KIND_ARGS = {
  apiVersion: { type: 'string', description: 'API version, e.g. "v1", "apps/v1", "networking.k8s.io/v1".' },
  kind: { type: 'string', description: 'Resource kind, e.g. Pod, Deployment, Service, Secret, Ingress.' },
  name: { type: 'string', description: 'Resource name.' },
  namespace: { type: 'string', description: 'Namespace (defaults to the configured namespace; ignored for cluster-scoped kinds).' },
};

export const K8S_TOOLS: McpToolDef[] = [
  {
    name: 'k8s_api_resources',
    description: 'Discover the resource kinds the cluster supports (kind, apiVersion, namespaced). Start here when unsure which apiVersion/kind to use.',
    inputSchema: {
      type: 'object',
      properties: { apiVersion: { type: 'string', description: 'Optional: only this group/version, e.g. "apps/v1". Default: core "v1".' } },
    },
  },
  {
    name: 'k8s_list',
    description: 'List resources of a kind, in a namespace or across all namespaces. Optional label selector. Returns a compact summary line per item.',
    inputSchema: {
      type: 'object',
      properties: {
        apiVersion: KIND_ARGS.apiVersion,
        kind: KIND_ARGS.kind,
        namespace: KIND_ARGS.namespace,
        allNamespaces: { type: 'boolean', description: 'List across all namespaces (namespaced kinds only).' },
        labelSelector: { type: 'string', description: 'Optional label selector, e.g. "app=web,tier=frontend".' },
        limit: { type: 'number', description: 'Max items to return (default 100, max 500).' },
      },
      required: ['apiVersion', 'kind'],
    },
  },
  {
    name: 'k8s_get',
    description: 'Get one resource as its full manifest (JSON). Secret VALUES are redacted here — use k8s_get_secret to decode them.',
    inputSchema: {
      type: 'object',
      properties: { apiVersion: KIND_ARGS.apiVersion, kind: KIND_ARGS.kind, name: KIND_ARGS.name, namespace: KIND_ARGS.namespace },
      required: ['apiVersion', 'kind', 'name'],
    },
  },
  {
    name: 'k8s_get_secret',
    description: 'Read and DECODE a Secret (base64 → plaintext). Sensitive: exposes credentials — a good candidate for the maker-checker approval gate.',
    inputSchema: {
      type: 'object',
      properties: { name: KIND_ARGS.name, namespace: KIND_ARGS.namespace },
      required: ['name'],
    },
  },
  {
    name: 'k8s_apply',
    description:
      'Create OR update any resource from a manifest via server-side apply. Pass the full manifest (JSON object or JSON string) with apiVersion, kind, metadata.name (and namespace for namespaced kinds). MUTATING.',
    inputSchema: {
      type: 'object',
      properties: { manifest: { type: 'object', description: 'The full resource manifest (apiVersion, kind, metadata, spec, …).' } },
      required: ['manifest'],
    },
  },
  {
    name: 'k8s_delete',
    description: 'Delete a resource. MUTATING / destructive.',
    inputSchema: {
      type: 'object',
      properties: { apiVersion: KIND_ARGS.apiVersion, kind: KIND_ARGS.kind, name: KIND_ARGS.name, namespace: KIND_ARGS.namespace },
      required: ['apiVersion', 'kind', 'name'],
    },
  },
  {
    name: 'k8s_patch',
    description: 'Patch a resource. patchType: "merge" (default, JSON merge patch), "strategic", or "json" (JSON patch array). MUTATING.',
    inputSchema: {
      type: 'object',
      properties: {
        apiVersion: KIND_ARGS.apiVersion,
        kind: KIND_ARGS.kind,
        name: KIND_ARGS.name,
        namespace: KIND_ARGS.namespace,
        patch: { type: 'object', description: 'The patch body (object for merge/strategic, array for json patch).' },
        patchType: { type: 'string', enum: ['merge', 'strategic', 'json'], description: 'Default "merge".' },
      },
      required: ['apiVersion', 'kind', 'name', 'patch'],
    },
  },
  {
    name: 'k8s_scale',
    description: 'Scale a Deployment/StatefulSet/ReplicaSet to a replica count. MUTATING.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Deployment, StatefulSet or ReplicaSet.' },
        name: KIND_ARGS.name,
        namespace: KIND_ARGS.namespace,
        replicas: { type: 'number', description: 'Desired replica count.' },
      },
      required: ['kind', 'name', 'replicas'],
    },
  },
  {
    name: 'k8s_rollout_restart',
    description: 'Trigger a rolling restart of a Deployment/StatefulSet/DaemonSet (sets a restartedAt annotation). MUTATING.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Deployment, StatefulSet or DaemonSet.' },
        name: KIND_ARGS.name,
        namespace: KIND_ARGS.namespace,
      },
      required: ['kind', 'name'],
    },
  },
  {
    name: 'k8s_logs',
    description: 'Read a pod container log (tail). Great for analysing a failing deployment together with k8s_events.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Pod name.' },
        namespace: KIND_ARGS.namespace,
        container: { type: 'string', description: 'Container name (optional; defaults to the first).' },
        tailLines: { type: 'number', description: 'Lines from the end (default 200, max 2000).' },
        previous: { type: 'boolean', description: 'Read the previous (crashed) container instance.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'k8s_events',
    description: 'List recent events in a namespace (optionally for one object) — the fastest way to see WHY something is failing (image pull errors, scheduling, probes).',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: KIND_ARGS.namespace,
        name: { type: 'string', description: 'Optional: only events whose involvedObject has this name.' },
        limit: { type: 'number', description: 'Max events (default 50, max 200).' },
      },
    },
  },
  {
    name: 'k8s_top_pods',
    description: 'Show pod CPU/memory usage in a namespace (requires metrics-server). Useful for capacity/analysis.',
    inputSchema: {
      type: 'object',
      properties: { namespace: KIND_ARGS.namespace, allNamespaces: { type: 'boolean', description: 'Across all namespaces.' } },
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────────────────────────────────

function num(v: unknown, def: number, max: number): number {
  return Math.min(max, Math.max(1, Math.trunc(Number(v)) || def));
}

async function apiResources(cfg: KubeConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const apiVersion = String(args.apiVersion ?? 'v1').trim() || 'v1';
  const list = await resourcesFor(cfg, apiVersion);
  const rows = list
    .filter((r: any) => typeof r.name === 'string' && !r.name.includes('/'))
    .map((r: any) => `• ${r.kind}  (${apiVersion}, ${r.namespaced ? 'namespaced' : 'cluster'})  → ${r.name}`);
  if (!rows.length) return text(`No resources for apiVersion "${apiVersion}".`);
  return text(`Resources in ${apiVersion}:\n\n${rows.join('\n')}`);
}

async function list(cfg: KubeConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const apiVersion = String(args.apiVersion ?? '').trim();
  const kind = String(args.kind ?? '').trim();
  if (!apiVersion || !kind) return text('Error: apiVersion and kind are required.', true);
  const { resource, namespaced } = await resolveResource(cfg, apiVersion, kind);
  const all = Boolean(args.allNamespaces);
  const namespace = all ? '' : ns(cfg, args);
  const qs = new URLSearchParams();
  if (args.labelSelector) qs.set('labelSelector', String(args.labelSelector));
  qs.set('limit', String(num(args.limit, 100, 500)));
  const path = resourcePath(apiVersion, resource, namespaced && !all, namespace) + `?${qs.toString()}`;
  const data = await kfetch(cfg, 'GET', path);
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return text(`No ${kind} found${namespace ? ` in ${namespace}` : ''}.`);
  const lines = items.map((it) => summarizeItem({ ...it, kind }));
  return text(`${items.length} ${kind}${namespace ? ` in ${namespace}` : ' (all namespaces)'}:\n\n${lines.join('\n')}`);
}

async function get(cfg: KubeConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const apiVersion = String(args.apiVersion ?? '').trim();
  const kind = String(args.kind ?? '').trim();
  const name = String(args.name ?? '').trim();
  if (!apiVersion || !kind || !name) return text('Error: apiVersion, kind and name are required.', true);
  const { resource, namespaced } = await resolveResource(cfg, apiVersion, kind);
  const path = resourcePath(apiVersion, resource, namespaced, ns(cfg, args), name);
  const obj = redactSecret(await kfetch(cfg, 'GET', path));
  return text('```json\n' + clip(JSON.stringify(obj, null, 2), 20_000) + '\n```');
}

async function getSecret(cfg: KubeConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name ?? '').trim();
  if (!name) return text('Error: name is required.', true);
  const path = resourcePath('v1', 'secrets', true, ns(cfg, args), name);
  const obj = await kfetch(cfg, 'GET', path);
  const data: Record<string, string> = obj?.data ?? {};
  const decoded = Object.entries(data).map(([k, v]) => {
    let val = '';
    try {
      val = Buffer.from(String(v), 'base64').toString('utf8');
    } catch {
      val = '(binary)';
    }
    return `${k}: ${val}`;
  });
  return text(`Secret ${obj?.metadata?.namespace}/${name} (type ${obj?.type ?? 'Opaque'}):\n\n${decoded.join('\n') || '(no data)'}`);
}

function manifestOf(args: Record<string, unknown>): any {
  const m = args.manifest;
  if (typeof m === 'string') {
    try {
      return JSON.parse(m);
    } catch {
      throw new Error('manifest must be a JSON object (or JSON string).');
    }
  }
  return m;
}

async function apply(cfg: KubeConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const manifest = manifestOf(args);
  const apiVersion = String(manifest?.apiVersion ?? '').trim();
  const kind = String(manifest?.kind ?? '').trim();
  const name = String(manifest?.metadata?.name ?? '').trim();
  if (!apiVersion || !kind || !name) return text('Error: manifest needs apiVersion, kind and metadata.name.', true);
  const { resource, namespaced } = await resolveResource(cfg, apiVersion, kind);
  const namespace = namespaced ? String(manifest?.metadata?.namespace ?? '').trim() || cfg.namespace : '';
  // Server-side apply: PATCH the object path with apply-patch content type. JSON is valid YAML, so the JSON
  // manifest is sent as-is. force=true takes ownership of conflicting fields under our field manager.
  const path = resourcePath(apiVersion, resource, namespaced, namespace, name) + '?fieldManager=kravn&force=true';
  const obj = await kfetch(cfg, 'PATCH', path, JSON.stringify(manifest), 'application/apply-patch+yaml');
  return text(`Applied ${kind}/${name}${namespace ? ` in ${namespace}` : ''} (resourceVersion ${obj?.metadata?.resourceVersion ?? '?'}).`);
}

async function del(cfg: KubeConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const apiVersion = String(args.apiVersion ?? '').trim();
  const kind = String(args.kind ?? '').trim();
  const name = String(args.name ?? '').trim();
  if (!apiVersion || !kind || !name) return text('Error: apiVersion, kind and name are required.', true);
  const { resource, namespaced } = await resolveResource(cfg, apiVersion, kind);
  const path = resourcePath(apiVersion, resource, namespaced, ns(cfg, args), name);
  await kfetch(cfg, 'DELETE', path);
  return text(`Deleted ${kind}/${name}${namespaced ? ` in ${ns(cfg, args)}` : ''}.`);
}

const PATCH_CT: Record<string, string> = {
  merge: 'application/merge-patch+json',
  strategic: 'application/strategic-merge-patch+json',
  json: 'application/json-patch+json',
};
async function patch(cfg: KubeConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const apiVersion = String(args.apiVersion ?? '').trim();
  const kind = String(args.kind ?? '').trim();
  const name = String(args.name ?? '').trim();
  if (!apiVersion || !kind || !name || args.patch === undefined) return text('Error: apiVersion, kind, name and patch are required.', true);
  const type = String(args.patchType ?? 'merge');
  const ct = PATCH_CT[type];
  if (!ct) return text('Error: patchType must be merge, strategic or json.', true);
  const { resource, namespaced } = await resolveResource(cfg, apiVersion, kind);
  const path = resourcePath(apiVersion, resource, namespaced, ns(cfg, args), name);
  await kfetch(cfg, 'PATCH', path, JSON.stringify(args.patch), ct);
  return text(`Patched ${kind}/${name}.`);
}

async function scale(cfg: KubeConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const kind = String(args.kind ?? '').trim();
  const name = String(args.name ?? '').trim();
  const replicas = Math.max(0, Math.trunc(Number(args.replicas)));
  if (!kind || !name || !Number.isFinite(replicas)) return text('Error: kind, name and replicas are required.', true);
  const { resource, namespaced } = await resolveResource(cfg, 'apps/v1', kind);
  const path = resourcePath('apps/v1', resource, namespaced, ns(cfg, args), name) + '/scale';
  await kfetch(cfg, 'PATCH', path, JSON.stringify({ spec: { replicas } }), 'application/merge-patch+json');
  return text(`Scaled ${kind}/${name} to ${replicas} replica(s).`);
}

async function rolloutRestart(cfg: KubeConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const kind = String(args.kind ?? '').trim();
  const name = String(args.name ?? '').trim();
  if (!kind || !name) return text('Error: kind and name are required.', true);
  const { resource, namespaced } = await resolveResource(cfg, 'apps/v1', kind);
  const path = resourcePath('apps/v1', resource, namespaced, ns(cfg, args), name);
  // No wall clock in this process is guaranteed stable; use resourceVersion-independent unique-ish marker.
  const stamp = String((await kfetch(cfg, 'GET', path))?.metadata?.resourceVersion ?? Math.trunc(performance.now()));
  const body = { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': `kravn-${stamp}` } } } } };
  await kfetch(cfg, 'PATCH', path, JSON.stringify(body), 'application/strategic-merge-patch+json');
  return text(`Triggered a rolling restart of ${kind}/${name}.`);
}

async function logs(cfg: KubeConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name ?? '').trim();
  if (!name) return text('Error: name (pod) is required.', true);
  const qs = new URLSearchParams({ tailLines: String(num(args.tailLines, 200, 2000)) });
  if (args.container) qs.set('container', String(args.container));
  if (args.previous) qs.set('previous', 'true');
  const path = `/api/v1/namespaces/${encodeURIComponent(ns(cfg, args))}/pods/${encodeURIComponent(name)}/log?${qs.toString()}`;
  const res = await undiciFetch(`${cfg.apiServer}${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${cfg.token}`, accept: 'text/plain' },
    dispatcher: agentFor(cfg),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.text()).slice(0, 200_000);
  if (!res.ok) return text(`Could not read logs (${res.status}): ${clip(body, 300)}`, true);
  return text(body.trim() ? '```\n' + body.trim() + '\n```' : '(log is empty)');
}

async function events(cfg: KubeConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const namespace = ns(cfg, args);
  const qs = new URLSearchParams({ limit: String(num(args.limit, 50, 200)) });
  if (args.name) qs.set('fieldSelector', `involvedObject.name=${String(args.name)}`);
  const data = await kfetch(cfg, 'GET', `/api/v1/namespaces/${encodeURIComponent(namespace)}/events?${qs.toString()}`);
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return text(`No events in ${namespace}${args.name ? ` for ${args.name}` : ''}.`);
  const lines = items.map((e) => {
    const t = e.lastTimestamp ?? e.eventTime ?? '';
    const obj = `${e.involvedObject?.kind ?? ''}/${e.involvedObject?.name ?? ''}`;
    return `• [${e.type}] ${obj}  ${e.reason}: ${clip(String(e.message ?? '').replace(/\s+/g, ' '), 160)}  (${t})`;
  });
  return text(`Events in ${namespace}:\n\n${lines.join('\n')}`);
}

async function topPods(cfg: KubeConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const all = Boolean(args.allNamespaces);
  const namespace = all ? '' : ns(cfg, args);
  const path = all
    ? '/apis/metrics.k8s.io/v1beta1/pods'
    : `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/pods`;
  const data = await kfetch(cfg, 'GET', path);
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return text('No pod metrics (is metrics-server installed?).');
  const lines = items.map((p) => {
    const cpu = (p.containers ?? []).reduce((s: number, c: any) => s + cpuToMilli(c.usage?.cpu), 0);
    const mem = (p.containers ?? []).reduce((s: number, c: any) => s + memToMi(c.usage?.memory), 0);
    return `• ${p.metadata?.namespace}/${p.metadata?.name}  ${cpu}m CPU  ${mem}Mi`;
  });
  return text(`Pod usage:\n\n${lines.join('\n')}`);
}
function cpuToMilli(v?: string): number {
  if (!v) return 0;
  if (v.endsWith('n')) return Math.round(parseInt(v) / 1_000_000);
  if (v.endsWith('u')) return Math.round(parseInt(v) / 1000);
  if (v.endsWith('m')) return parseInt(v);
  return Math.round(parseFloat(v) * 1000);
}
function memToMi(v?: string): number {
  if (!v) return 0;
  const n = parseInt(v);
  if (v.endsWith('Ki')) return Math.round(n / 1024);
  if (v.endsWith('Mi')) return n;
  if (v.endsWith('Gi')) return n * 1024;
  return Math.round(n / (1024 * 1024));
}

export async function callK8s(cfg: KubeConfig, name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
  switch (name) {
    case 'k8s_api_resources':
      return apiResources(cfg, args);
    case 'k8s_list':
      return list(cfg, args);
    case 'k8s_get':
      return get(cfg, args);
    case 'k8s_get_secret':
      return getSecret(cfg, args);
    case 'k8s_apply':
      return apply(cfg, args);
    case 'k8s_delete':
      return del(cfg, args);
    case 'k8s_patch':
      return patch(cfg, args);
    case 'k8s_scale':
      return scale(cfg, args);
    case 'k8s_rollout_restart':
      return rolloutRestart(cfg, args);
    case 'k8s_logs':
      return logs(cfg, args);
    case 'k8s_events':
      return events(cfg, args);
    case 'k8s_top_pods':
      return topPods(cfg, args);
    default:
      return null;
  }
}

export function kubernetesPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: K8S_ID,
      name: 'Kubernetes',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Operate any Kubernetes cluster over MCP via the Kubernetes REST API: discover kinds, get/list resources, ' +
        'read pod logs and events, and apply/delete/patch/scale/restart workloads. Runs in-cluster with the pod ' +
        'ServiceAccount by default, or point it at another cluster with an API server URL + token + CA. Mutating ' +
        'and secret-reading tools are named for the maker-checker approval gate; the token RBAC is the hard ceiling.',
      author: 'Kravn',
      priority: 100,
      // Highest-risk connector + in-cluster mode needs zero config, so do NOT auto-create an enabled default
      // instance. An admin adds a cluster deliberately (in-cluster or per-cluster) and enables it.
      seedDisabled: true,
      configSchema: {
        type: 'object',
        description:
          "PERMISSIONS: a tool can only do what the ServiceAccount's Kubernetes RBAC allows — that RBAC is the " +
          'hard ceiling. Grant least-privilege. IN-CLUSTER (empty API server): bind a Role/ClusterRole to KRAVN\'s ' +
          'own pod ServiceAccount (via the Helm chart / a (Cluster)RoleBinding). PER-CLUSTER: create a ServiceAccount ' +
          'in the target cluster, bind its RBAC, and paste its token below. Read needs verbs get/list/watch; writes ' +
          'need create/update/patch and delete on the resources/namespaces you want to allow (e.g. deployments, ' +
          'services, configmaps; add secrets only if you want secret access). Scope with a namespaced Role or go ' +
          'cluster-wide with a ClusterRole.',
        properties: {
          apiServer: {
            type: 'string',
            title: 'API Server URL',
            description:
              'e.g. https://my-cluster:6443. Leave EMPTY to use the in-cluster ServiceAccount (the cluster Kravn ' +
              "runs in) — then grant the RBAC to KRAVN's pod ServiceAccount, not a token here.",
          },
          token: {
            type: 'string',
            title: 'ServiceAccount Token',
            description:
              'Bearer token of a ServiceAccount in the target cluster (leave empty when running in-cluster). Its ' +
              'RBAC is the ceiling: bind a Role (get/list/watch for read; create/update/patch/delete for write) to ' +
              'that ServiceAccount for the namespaces/resources you want to allow.',
            secret: true,
          },
          caCert: {
            type: 'string',
            title: 'Cluster CA (PEM)',
            description: "The API server's CA certificate (PEM). Required for a self-signed external cluster; empty uses the in-cluster CA.",
          },
          namespace: {
            type: 'string',
            title: 'Default Namespace',
            description: 'Namespace used when a tool call omits one (default: "default").',
          },
        },
        required: [],
      },
    },
    server: {
      listTools: () => K8S_TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const cfg = readKubeConfig(config);
          const r = await callK8s(cfg, name, args);
          return r ?? text(`Unknown tool: ${name}`, true);
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Kubernetes request failed.', true);
        }
      },
    },
  };
}
