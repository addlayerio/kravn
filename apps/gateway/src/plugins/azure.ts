import crypto from 'node:crypto';
import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native Azure plugin — read-only diagnostics + cost over Azure's REST APIs (no external MCP runner, no SDK).
 *
 * Rather than run Microsoft's full Azure MCP server as a sidecar, this exposes a small, curated, **read-only**
 * toolset that covers the high-value use cases end-to-end:
 *   • Resource Graph (KQL over EVERY resource in the tenant — inventory/state of "any resource")
 *   • Log Analytics (KQL — logs & platform diagnostics, e.g. a SQL Hyperscale DB)
 *   • Cost Management (spend grouped by service/resource-group/… — "cost by service type")
 *   • Azure Monitor metrics (+ metric discovery)
 *
 * There are NO write tools by construction, so there is no mutating surface at all (stronger than a
 * `--read-only` flag on a full server). Auth is Microsoft Entra **client-credentials** (a service principal):
 * tenant + client id + client **secret** (`secret: true` → encrypted at rest by PluginManager). Kravn caches
 * short-lived access tokens per resource audience. All hosts are fixed per Azure cloud (public/Gov/China) — no
 * user-supplied URL — so there is no SSRF surface; outbound requests refuse redirects, time out and cap the body.
 *
 * The service principal should be granted read-only RBAC (Reader + Cost Management Reader + Monitoring Reader).
 */
export const AZURE_ID = 'kravn-azure';

class AzureError extends Error {}

interface AzureConfig {
  cloud: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  workspaceId: string; // optional default Log Analytics workspace (GUID)
}

// Per-cloud endpoints. Hosts are fixed here (never user-supplied) so there is no SSRF surface.
interface CloudEndpoints {
  login: string;
  arm: string;
  logs: string;
}
const CLOUDS: Record<string, CloudEndpoints> = {
  AzureCloud: {
    login: 'https://login.microsoftonline.com',
    arm: 'https://management.azure.com',
    logs: 'https://api.loganalytics.io',
  },
  AzureUSGovernment: {
    login: 'https://login.microsoftonline.us',
    arm: 'https://management.usgovcloudapi.net',
    logs: 'https://api.loganalytics.us',
  },
  AzureChinaCloud: {
    login: 'https://login.chinacloudapi.cn',
    arm: 'https://management.chinacloudapi.cn',
    logs: 'https://api.loganalytics.azure.cn',
  },
};

const MAX_RESPONSE_BYTES = 10_000_000;
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type Resource = 'arm' | 'logs';
interface Token {
  accessToken: string;
  expiresAt: number;
}
const tokenCache = new Map<string, Token>(); // `${configFingerprint}|${resource}` -> token

function clip(s: string, max = 6000): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}
function guid(v: unknown, what: string): string {
  const s = String(v ?? '').trim();
  if (!GUID_RE.test(s)) throw new AzureError(`${what} must be a GUID.`);
  return s;
}
/** Validate an ARM resource id so it can't break out of the fixed ARM host path.
 *  Shape: /subscriptions/{guid}/resourceGroups/{rg}/providers/{ns}/{type}/{name}[/...] */
function safeResourceId(v: unknown): string {
  const s = String(v ?? '').trim();
  if (
    !/^\/subscriptions\/[0-9a-fA-F-]{36}\/[A-Za-z0-9._()\/\-]+$/.test(s) ||
    s.includes('..') ||
    s.includes('//')
  ) {
    throw new AzureError('Invalid resourceId — expected a full Azure resource id, e.g. /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Sql/servers/<name>.');
  }
  return s;
}

function readConfig(config: Record<string, unknown>): AzureConfig {
  const cloud = String(config.cloud ?? 'AzureCloud').trim() || 'AzureCloud';
  if (!CLOUDS[cloud]) throw new AzureError(`Unknown Azure cloud '${cloud}'.`);
  const tenantId = String(config.tenantId ?? '').trim();
  const clientId = String(config.clientId ?? '').trim();
  const clientSecret = String(config.clientSecret ?? '').trim();
  const subscriptionId = String(config.subscriptionId ?? '').trim();
  const workspaceId = String(config.workspaceId ?? '').trim();
  if (!GUID_RE.test(tenantId) || !GUID_RE.test(clientId) || !clientSecret) {
    throw new AzureError(
      'Azure is not configured. Set the Tenant ID, Client ID and Client Secret of a service principal ' +
        '(App registration) with read-only RBAC (Reader + Cost Management Reader + Monitoring Reader).',
    );
  }
  return { cloud, tenantId, clientId, clientSecret, subscriptionId, workspaceId };
}

function fingerprint(cfg: AzureConfig): string {
  return crypto
    .createHash('sha256')
    .update(`${cfg.cloud}|${cfg.tenantId}|${cfg.clientId}|${cfg.clientSecret}`)
    .digest('hex');
}

async function getToken(cfg: AzureConfig, resource: Resource, force = false): Promise<string> {
  const eps = CLOUDS[cfg.cloud];
  const key = `${fingerprint(cfg)}|${resource}`;
  if (!force) {
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
  }
  const scope = `${resource === 'logs' ? eps.logs : eps.arm}/.default`;
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope,
  });
  let res: Response;
  try {
    res = await fetch(`${eps.login}/${cfg.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new AzureError(`Could not reach Microsoft Entra: ${(err as Error).message}`);
  }
  const body = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  try {
    data = JSON.parse(body);
  } catch {
    throw new AzureError(`Entra token endpoint returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!data.access_token) {
    throw new AzureError(`Azure sign-in failed: ${clip(String(data.error_description || data.error || `HTTP ${res.status}`), 400)}`);
  }
  const token: Token = {
    accessToken: String(data.access_token),
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  tokenCache.set(key, token);
  return token.accessToken;
}

/** Call an ARM (management.azure.com) endpoint. `path` is a fixed-host absolute path; query is url-encoded. */
async function armApi(
  cfg: AzureConfig,
  method: string,
  path: string,
  opts: { apiVersion: string; query?: Record<string, unknown>; body?: unknown } = { apiVersion: '' },
  retried = false,
): Promise<any> {
  const eps = CLOUDS[cfg.cloud];
  const token = await getToken(cfg, 'arm');
  const url = new URL(`${eps.arm}${path}`);
  url.searchParams.set('api-version', opts.apiVersion);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  return sendJson(cfg, 'arm', method, url, opts.body, retried, () => armApi(cfg, method, path, opts, true));
}

/** Run a Log Analytics KQL query against a workspace (api.loganalytics.io). */
async function logsApi(cfg: AzureConfig, workspaceId: string, query: string, timespan?: string): Promise<any> {
  const eps = CLOUDS[cfg.cloud];
  const url = new URL(`${eps.logs}/v1/workspaces/${workspaceId}/query`);
  const body: Record<string, unknown> = { query };
  if (timespan) body.timespan = timespan;
  return sendJson(cfg, 'logs', 'POST', url, body, false, () => logsApi(cfg, workspaceId, query, timespan));
}

async function sendJson(
  cfg: AzureConfig,
  resource: Resource,
  method: string,
  url: URL,
  body: unknown,
  retried: boolean,
  retry: () => Promise<any>,
): Promise<any> {
  const token = await getToken(cfg, resource);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new AzureError(`Could not reach Azure: ${(err as Error).message}`);
  }
  // A revoked/expired token → refresh once and retry.
  if (res.status === 401 && !retried) {
    await getToken(cfg, resource, true);
    return retry();
  }
  const bodyText = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: any;
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new AzureError(`Azure returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!res.ok || data?.error) {
    const e = data?.error;
    const msg = (e && (e.message || e.code)) || `HTTP ${res.status}`;
    throw new AzureError(clip(`Azure error: ${msg}`, 800));
  }
  return data;
}

// ─── Tools (all read-only) ──────────────────────────────────────────────────────────────────────────

const TOOLS: McpToolDef[] = [
  {
    name: 'azure_list_subscriptions',
    description: 'List the Azure subscriptions the service principal can see (id, display name, state). Use to discover subscription ids for the other tools.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'azure_resource_graph_query',
    description:
      'Query Azure Resource Graph with **KQL** — the general-purpose tool to inspect ANY resource across the ' +
      'tenant (inventory, state, config, tags). Example: `Resources | where type =~ "microsoft.sql/servers/databases" ' +
      '| project name, location, sku.name, resourceGroup`. Optional `subscriptions` (JSON array) overrides the default.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A Resource Graph KQL query.' },
        subscriptions: { type: 'string', description: 'Optional JSON array of subscription GUIDs to scope to; defaults to the configured subscription.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'azure_logs_query',
    description:
      'Run a **KQL** query against a Log Analytics workspace — logs, platform diagnostics and metrics for any ' +
      'monitored resource (e.g. a SQL Hyperscale DB: `AzureDiagnostics | where ResourceProvider == "MICROSOFT.SQL" ' +
      '| take 50`). Optional `workspaceId` (GUID) overrides the configured default; `timespan` is ISO-8601 (e.g. PT1H, P1D, or start/end).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A Log Analytics KQL query.' },
        workspaceId: { type: 'string', description: 'Optional Log Analytics workspace GUID; defaults to the configured one.' },
        timespan: { type: 'string', description: 'Optional ISO-8601 timespan, e.g. PT1H, P1D, or 2026-07-01T00:00:00Z/2026-07-02T00:00:00Z.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'azure_cost_by_service',
    description:
      'Total Azure cost grouped by a dimension (default **ServiceName** — "cost by service type"). ' +
      '`timeframe`: MonthToDate (default), TheLastMonth, BillingMonthToDate, TheLastBillingMonth, WeekToDate, or Custom ' +
      '(then pass `from`/`to` as ISO dates). `groupBy`: ServiceName (default), ResourceGroupName, ResourceLocation, MeterCategory. ' +
      'Optional `subscriptionId` overrides the default.',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: { type: 'string', description: 'MonthToDate | TheLastMonth | BillingMonthToDate | TheLastBillingMonth | WeekToDate | Custom.' },
        groupBy: { type: 'string', description: 'Dimension to group by (default ServiceName).' },
        from: { type: 'string', description: 'For Custom timeframe: start date (ISO, e.g. 2026-07-01).' },
        to: { type: 'string', description: 'For Custom timeframe: end date (ISO).' },
        subscriptionId: { type: 'string', description: 'Optional subscription GUID; defaults to the configured one.' },
      },
    },
  },
  {
    name: 'azure_metric_definitions',
    description: 'List the metrics available for a resource (name + unit + supported aggregations). Use before azure_metrics_query. `resourceId` is the full Azure resource id.',
    inputSchema: {
      type: 'object',
      properties: { resourceId: { type: 'string', description: 'Full Azure resource id (/subscriptions/…/providers/…/<name>).' } },
      required: ['resourceId'],
    },
  },
  {
    name: 'azure_metrics_query',
    description:
      'Read Azure Monitor metrics for a resource. `metricNames` is comma-separated (from azure_metric_definitions, ' +
      'e.g. "cpu_percent,storage_percent"). Optional `timespan` (ISO-8601 or start/end, default last 1h), ' +
      '`interval` (e.g. PT5M), `aggregation` (Average|Minimum|Maximum|Total|Count, default Average).',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'string', description: 'Full Azure resource id.' },
        metricNames: { type: 'string', description: 'Comma-separated metric names.' },
        timespan: { type: 'string', description: 'Optional ISO-8601 timespan; defaults to the last hour.' },
        interval: { type: 'string', description: 'Optional aggregation interval, e.g. PT1M, PT5M, PT1H.' },
        aggregation: { type: 'string', description: 'Average | Minimum | Maximum | Total | Count (default Average).' },
      },
      required: ['resourceId', 'metricNames'],
    },
  },
];

async function listSubscriptions(cfg: AzureConfig): Promise<McpToolResult> {
  const data = await armApi(cfg, 'GET', '/subscriptions', { apiVersion: '2020-01-01' });
  const subs = ((data.value ?? []) as any[]).map(
    (s) => `• ${s.subscriptionId}  —  ${s.displayName ?? ''}  (${s.state ?? ''})`,
  );
  return text(subs.length ? clip(subs.join('\n')) : 'No subscriptions visible to this service principal.');
}

async function resourceGraph(cfg: AzureConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) return text('Error: query (a Resource Graph KQL statement) is required.', true);
  let subscriptions: string[];
  if (args.subscriptions) {
    let arr: unknown;
    try {
      arr = JSON.parse(String(args.subscriptions));
    } catch {
      throw new AzureError('subscriptions must be a JSON array of subscription GUIDs.');
    }
    if (!Array.isArray(arr) || !arr.length) throw new AzureError('subscriptions must be a non-empty JSON array.');
    subscriptions = arr.map((s) => guid(s, 'subscription'));
  } else {
    subscriptions = [guid(cfg.subscriptionId, 'subscriptionId (configure a default or pass subscriptions)')];
  }
  const data = await armApi(cfg, 'POST', '/providers/Microsoft.ResourceGraph/resources', {
    apiVersion: '2022-10-01',
    body: { subscriptions, query },
  });
  const rows = (data.data ?? []) as unknown[];
  return text(`${data.count ?? rows.length} row(s):\n\n${clip(JSON.stringify(rows, null, 2))}`);
}

async function logsQuery(cfg: AzureConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) return text('Error: query (a Log Analytics KQL statement) is required.', true);
  const wid = guid(args.workspaceId || cfg.workspaceId, 'workspaceId (configure a default or pass one)');
  const timespan = args.timespan ? String(args.timespan) : undefined;
  const data = await logsApi(cfg, wid, query, timespan);
  // Log Analytics returns { tables: [{ name, columns:[{name,type}], rows:[[...]] }] }
  const table = (data.tables ?? [])[0];
  if (!table) return text('No results.');
  const cols = (table.columns ?? []).map((c: any) => c.name);
  const rows = (table.rows ?? []) as unknown[][];
  const objs = rows.map((r) => Object.fromEntries(cols.map((c: string, i: number) => [c, r[i]])));
  return text(`${objs.length} row(s):\n\n${clip(JSON.stringify(objs, null, 2))}`);
}

const COST_TIMEFRAMES = ['MonthToDate', 'BillingMonthToDate', 'TheLastMonth', 'TheLastBillingMonth', 'WeekToDate', 'Custom'];
const COST_DIMENSIONS = ['ServiceName', 'ResourceGroupName', 'ResourceLocation', 'MeterCategory', 'MeterSubcategory', 'ResourceType'];

async function costByService(cfg: AzureConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const subId = guid(args.subscriptionId || cfg.subscriptionId, 'subscriptionId (configure a default or pass one)');
  const timeframe = String(args.timeframe ?? 'MonthToDate');
  if (!COST_TIMEFRAMES.includes(timeframe)) throw new AzureError(`timeframe must be one of: ${COST_TIMEFRAMES.join(', ')}.`);
  const groupBy = String(args.groupBy ?? 'ServiceName');
  if (!COST_DIMENSIONS.includes(groupBy)) throw new AzureError(`groupBy must be one of: ${COST_DIMENSIONS.join(', ')}.`);
  const body: Record<string, unknown> = {
    type: 'ActualCost',
    timeframe,
    dataset: {
      granularity: 'None',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      grouping: [{ type: 'Dimension', name: groupBy }],
    },
  };
  if (timeframe === 'Custom') {
    const from = String(args.from ?? '').trim();
    const to = String(args.to ?? '').trim();
    if (!from || !to) throw new AzureError('Custom timeframe requires `from` and `to` (ISO dates).');
    body.timePeriod = { from, to };
  }
  const data = await armApi(cfg, 'POST', `/subscriptions/${subId}/providers/Microsoft.CostManagement/query`, {
    apiVersion: '2023-11-01',
    body,
  });
  const cols = ((data.properties?.columns ?? []) as any[]).map((c) => c.name);
  const rows = (data.properties?.rows ?? []) as unknown[][];
  const objs = rows.map((r) => Object.fromEntries(cols.map((c: string, i: number) => [c, r[i]])));
  return text(`Cost by ${groupBy} (${timeframe}) — ${objs.length} row(s):\n\n${clip(JSON.stringify(objs, null, 2))}`);
}

async function metricDefinitions(cfg: AzureConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const rid = safeResourceId(args.resourceId);
  const data = await armApi(cfg, 'GET', `${rid}/providers/Microsoft.Insights/metricDefinitions`, { apiVersion: '2018-01-01' });
  const defs = ((data.value ?? []) as any[]).map((d) => {
    const name = d.name?.value ?? d.name;
    const aggs = (d.supportedAggregationTypes ?? []).join('/');
    return `• ${name}  (${d.unit ?? ''}${aggs ? `, ${aggs}` : ''})  —  ${d.displayDescription ?? d.name?.localizedValue ?? ''}`;
  });
  return text(defs.length ? `Metrics for the resource (${defs.length}):\n\n${clip(defs.join('\n'))}` : 'No metric definitions for this resource.');
}

async function metricsQuery(cfg: AzureConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const rid = safeResourceId(args.resourceId);
  const metricNames = String(args.metricNames ?? '').trim();
  if (!metricNames) return text('Error: metricNames (comma-separated) is required.', true);
  const now = Date.now();
  const timespan = args.timespan
    ? String(args.timespan)
    : `${new Date(now - 3600_000).toISOString()}/${new Date(now).toISOString()}`;
  const query: Record<string, unknown> = {
    metricnames: metricNames,
    timespan,
    aggregation: String(args.aggregation ?? 'Average'),
  };
  if (args.interval) query.interval = String(args.interval);
  const data = await armApi(cfg, 'GET', `${rid}/providers/Microsoft.Insights/metrics`, {
    apiVersion: '2018-01-01',
    query,
  });
  const series = ((data.value ?? []) as any[]).map((m) => ({
    name: m.name?.value ?? m.name,
    unit: m.unit,
    points: ((m.timeseries ?? [])[0]?.data ?? []).slice(-200),
  }));
  return text(clip(JSON.stringify(series, null, 2)));
}

const SETUP = [
  'Azure diagnostics & cost use a **service principal** (App registration) with **read-only** RBAC. Once:',
  '',
  '1. **Microsoft Entra ID → App registrations → New registration**. Copy the **Application (client) ID** and **Directory (tenant) ID**.',
  '2. **Certificates & secrets → New client secret** — copy the secret **value** (shown once).',
  '3. Assign the app **read-only** roles at the **subscription** scope (**Access control (IAM) → Add role assignment**):',
  '   • **Reader** — resource inventory (Resource Graph) **and** Azure Monitor metrics.',
  '   • **Log Analytics Reader** — to run Log Analytics **KQL** queries. (Monitoring Reader is *not* enough — the query API needs `workspaces/analytics/query`.)',
  '   • **Cost Management Reader** — spend.',
  '4. (For `azure_logs_query`) grab the **Log Analytics workspace** GUID (workspace → **Overview → Workspace ID**). The subscription-scoped Log Analytics Reader above already covers it; assign that role directly on the workspace if it lives in another subscription.',
  '',
  'Then set: **Tenant ID**, **Client ID**, **Client Secret**, **Subscription ID** (default for resource/cost queries) and, optionally, **Log Analytics Workspace ID**. Every tool here is read-only — the app cannot change anything even if its role were broader.',
].join('\n');

export function azurePlugin(): McpServerPlugin {
  return {
    manifest: {
      id: AZURE_ID,
      name: 'Azure',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Read-only Azure diagnostics & cost over the Azure REST APIs — Resource Graph (KQL over any resource), ' +
        'Log Analytics (KQL logs/diagnostics), Cost Management (spend by service/resource group), and Azure ' +
        'Monitor metrics. Entra service-principal auth; supports public, US Gov and China clouds. No write tools.',
      author: 'Kravn',
      priority: 100,
      setup: SETUP,
      configSchema: {
        type: 'object',
        properties: {
          cloud: {
            type: 'string',
            title: 'Azure cloud',
            enum: ['AzureCloud', 'AzureUSGovernment', 'AzureChinaCloud'],
            description: 'The Azure environment (default AzureCloud = public).',
          },
          tenantId: { type: 'string', title: 'Tenant ID', description: 'Microsoft Entra Directory (tenant) ID (GUID).' },
          clientId: { type: 'string', title: 'Client ID', description: 'App registration Application (client) ID (GUID).' },
          clientSecret: { type: 'string', title: 'Client Secret', description: 'App registration client secret value.', secret: true },
          subscriptionId: { type: 'string', title: 'Subscription ID', description: 'Default subscription GUID for resource/cost queries.' },
          workspaceId: { type: 'string', title: 'Log Analytics Workspace ID', description: 'Optional default Log Analytics workspace GUID for azure_logs_query.' },
        },
        required: ['tenantId', 'clientId', 'clientSecret'],
      },
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const cfg = readConfig(config);
          switch (name) {
            case 'azure_list_subscriptions':
              return await listSubscriptions(cfg);
            case 'azure_resource_graph_query':
              return await resourceGraph(cfg, args);
            case 'azure_logs_query':
              return await logsQuery(cfg, args);
            case 'azure_cost_by_service':
              return await costByService(cfg, args);
            case 'azure_metric_definitions':
              return await metricDefinitions(cfg, args);
            case 'azure_metrics_query':
              return await metricsQuery(cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Azure request failed.', true);
        }
      },
    },
  };
}
