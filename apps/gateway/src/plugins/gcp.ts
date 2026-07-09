import crypto from 'node:crypto';
import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native Google Cloud plugin — read-only diagnostics + cost over the GCP REST APIs (no external runner, no SDK).
 *
 * Curated, **read-only** toolset:
 *   • Cloud Asset Inventory — search ANY resource in the project (inventory/state)
 *   • Cloud Logging  — query log entries for diagnostics
 *   • Cloud Monitoring — read time-series metrics
 *   • BigQuery  — query the **billing export** table for spend ("cost by service"; requires billing export set up)
 *   • Resource Manager — list projects
 *
 * There are NO write tools by construction. Auth is a **service-account JSON** key (`secret: true` → encrypted
 * at rest): Kravn signs a short-lived **RS256 JWT** with the key and exchanges it for an OAuth access token
 * (read-only scope for diagnostics; a BigQuery scope only for the cost tool). Hosts are fixed Google API
 * endpoints (never user-supplied) so there is no SSRF surface; outbound requests refuse redirects, time out and
 * cap the body. Grant the service account read-only IAM (e.g. Viewer / Cloud Asset Viewer / Logging Viewer /
 * Monitoring Viewer; for cost: BigQuery Data Viewer + Job User on the billing-export dataset).
 */
export const GCP_ID = 'kravn-gcp';

class GcpError extends Error {}

interface GcpConfig {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  projectId: string;
  billingExportTable: string;
}

const MAX_RESPONSE_BYTES = 10_000_000;
const PROJECT_RE = /^[a-z][-a-z0-9]{4,28}[a-z0-9]$/;
const SCOPE_RO = 'https://www.googleapis.com/auth/cloud-platform.read-only';
const SCOPE_BQ = 'https://www.googleapis.com/auth/bigquery';

function clip(s: string, max = 6000): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}
function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString('base64url');
}

function readConfig(config: Record<string, unknown>): GcpConfig {
  const raw = config.serviceAccountJson;
  if (!raw) throw new GcpError('Google Cloud is not configured. Paste a service-account JSON key with read-only IAM.');
  let sa: any;
  try {
    sa = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new GcpError('serviceAccountJson must be the full service-account JSON key.');
  }
  if (sa.type !== 'service_account' || !sa.client_email || !sa.private_key) {
    throw new GcpError('That does not look like a service-account JSON key (need type, client_email, private_key).');
  }
  const projectId = String(config.projectId ?? sa.project_id ?? '').trim();
  const billingExportTable = String(config.billingExportTable ?? '').trim();
  return {
    clientEmail: String(sa.client_email),
    privateKey: String(sa.private_key),
    tokenUri: String(sa.token_uri || 'https://oauth2.googleapis.com/token'),
    projectId,
    billingExportTable,
  };
}
function reqProject(cfg: GcpConfig, arg?: unknown): string {
  const p = String(arg || cfg.projectId || '').trim();
  if (!PROJECT_RE.test(p)) throw new GcpError('A valid GCP projectId is required (configure a default or pass one).');
  return p;
}

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function getToken(cfg: GcpConfig, scope: string): Promise<string> {
  const key = `${crypto.createHash('sha256').update(`${cfg.clientEmail}|${cfg.privateKey}|${scope}`).digest('hex')}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: cfg.clientEmail, scope, aud: cfg.tokenUri, iat: now, exp: now + 3600 }));
  const signingInput = `${header}.${claims}`;
  let signature: string;
  try {
    signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(cfg.privateKey).toString('base64url');
  } catch (err) {
    throw new GcpError(`Could not sign the JWT (bad private key?): ${(err as Error).message}`);
  }
  const assertion = `${signingInput}.${signature}`;
  let res: Response;
  try {
    res = await fetch(cfg.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new GcpError(`Could not reach Google's token endpoint: ${(err as Error).message}`);
  }
  const body = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  try {
    data = JSON.parse(body);
  } catch {
    throw new GcpError(`Google token endpoint returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!data.access_token) throw new GcpError(`Google sign-in failed: ${clip(String(data.error_description || data.error || `HTTP ${res.status}`), 400)}`);
  tokenCache.set(key, { accessToken: String(data.access_token), expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  return String(data.access_token);
}

async function gcpApi(
  cfg: GcpConfig,
  scope: string,
  method: string,
  url: URL,
  body?: unknown,
): Promise<any> {
  const token = await getToken(cfg, scope);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new GcpError(`Could not reach Google Cloud: ${(err as Error).message}`);
  }
  const bodyText = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: any;
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new GcpError(`Google Cloud returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!res.ok || data?.error) {
    const e = data?.error;
    const msg = (e && (e.message || (typeof e === 'string' ? e : e.status))) || `HTTP ${res.status}`;
    throw new GcpError(clip(`Google Cloud error: ${msg}`, 800));
  }
  return data;
}

// ─── Tools (all read-only) ──────────────────────────────────────────────────────────────────────────

const TOOLS: McpToolDef[] = [
  {
    name: 'gcp_list_projects',
    description: 'List the GCP projects the service account can see (id, name, state). Use to discover project ids.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gcp_asset_search',
    description:
      'Search Cloud Asset Inventory — the general-purpose tool to inspect ANY resource in a project. ' +
      '`query` is an asset query, e.g. `state:RUNNING` or `location:us-central1`. Optional `assetTypes` ' +
      '(JSON array, e.g. ["compute.googleapis.com/Instance"]) and `project`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Asset search query (optional; empty = all resources).' },
        assetTypes: { type: 'string', description: 'Optional JSON array of asset types.' },
        project: { type: 'string', description: 'Project id (defaults to the configured one).' },
      },
    },
  },
  {
    name: 'gcp_logging_query',
    description:
      'Query Cloud Logging entries for diagnostics. `filter` is a Logging filter, e.g. ' +
      '`severity>=ERROR AND resource.type="cloudsql_database"`. Optional `project`, `limit` (default 50).',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'A Cloud Logging filter expression.' },
        project: { type: 'string', description: 'Project id (defaults to the configured one).' },
        limit: { type: 'number', description: 'Max entries (default 50, max 500).' },
      },
      required: ['filter'],
    },
  },
  {
    name: 'gcp_monitoring_query',
    description:
      'Read Cloud Monitoring time series. `filter` selects the metric, e.g. ' +
      '`metric.type="cloudsql.googleapis.com/database/cpu/utilization"`. Optional `hours` (lookback, default 1), `project`.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'A Monitoring metric filter.' },
        hours: { type: 'number', description: 'Lookback window in hours (default 1).' },
        project: { type: 'string', description: 'Project id (defaults to the configured one).' },
      },
      required: ['filter'],
    },
  },
  {
    name: 'gcp_cost',
    description:
      'Cost by service from the **BigQuery billing export**. Requires the billing export table to be configured ' +
      '(Billing → Billing export → BigQuery). Optional `days` (lookback, default 30) and `groupBy` column ' +
      '(default service.description). Runs a read-only SQL query against the export table.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback window in days (default 30).' },
        groupBy: { type: 'string', description: 'Column to group by (default "service.description").' },
      },
    },
  },
];

async function listProjects(cfg: GcpConfig): Promise<McpToolResult> {
  const data = await gcpApi(cfg, SCOPE_RO, 'GET', new URL('https://cloudresourcemanager.googleapis.com/v1/projects?pageSize=100'));
  const projs = ((data.projects ?? []) as any[]).map((p) => `• ${p.projectId}  —  ${p.name ?? ''}  (${p.lifecycleState ?? ''})`);
  return text(projs.length ? clip(projs.join('\n')) : 'No projects visible to this service account.');
}

async function assetSearch(cfg: GcpConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const project = reqProject(cfg, args.project);
  const url = new URL(`https://cloudasset.googleapis.com/v1/projects/${project}:searchAllResources`);
  url.searchParams.set('pageSize', '100');
  if (args.query) url.searchParams.set('query', String(args.query));
  if (args.assetTypes) {
    let arr: unknown;
    try {
      arr = JSON.parse(String(args.assetTypes));
    } catch {
      throw new GcpError('assetTypes must be a JSON array.');
    }
    if (Array.isArray(arr)) for (const t of arr) url.searchParams.append('assetTypes', String(t));
  }
  const data = await gcpApi(cfg, SCOPE_RO, 'GET', url);
  const rows = ((data.results ?? []) as any[]).map((r) => ({ name: r.name, assetType: r.assetType, location: r.location, state: r.state, labels: r.labels }));
  return text(`${rows.length} resource(s):\n\n${clip(JSON.stringify(rows, null, 2))}`);
}

async function loggingQuery(cfg: GcpConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const project = reqProject(cfg, args.project);
  const filter = String(args.filter ?? '').trim();
  if (!filter) return text('Error: filter (a Cloud Logging filter) is required.', true);
  const limit = Math.min(500, Math.max(1, Number(args.limit) || 50));
  const data = await gcpApi(cfg, SCOPE_RO, 'POST', new URL('https://logging.googleapis.com/v2/entries:list'), {
    resourceNames: [`projects/${project}`],
    filter,
    orderBy: 'timestamp desc',
    pageSize: limit,
  });
  const entries = ((data.entries ?? []) as any[]).map((e) => ({
    timestamp: e.timestamp,
    severity: e.severity,
    resource: e.resource?.type,
    log: e.logName?.split('/').pop(),
    message: e.textPayload ?? e.jsonPayload ?? e.protoPayload,
  }));
  return text(`${entries.length} entr(y/ies):\n\n${clip(JSON.stringify(entries, null, 2))}`);
}

async function monitoringQuery(cfg: GcpConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const project = reqProject(cfg, args.project);
  const filter = String(args.filter ?? '').trim();
  if (!filter) return text('Error: filter (a Monitoring metric filter) is required.', true);
  const hours = Math.min(168, Math.max(1, Number(args.hours) || 1));
  const now = Date.now();
  const url = new URL(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries`);
  url.searchParams.set('filter', filter);
  url.searchParams.set('interval.startTime', new Date(now - hours * 3600_000).toISOString());
  url.searchParams.set('interval.endTime', new Date(now).toISOString());
  url.searchParams.set('view', 'FULL');
  const data = await gcpApi(cfg, SCOPE_RO, 'GET', url);
  const series = ((data.timeSeries ?? []) as any[]).map((s) => ({
    metric: s.metric?.type,
    labels: s.metric?.labels,
    resource: s.resource?.labels,
    points: (s.points ?? []).slice(0, 100).map((p: any) => ({ t: p.interval?.endTime, v: p.value })),
  }));
  return text(series.length ? clip(JSON.stringify(series, null, 2)) : 'No time series for that filter/window.');
}

async function cost(cfg: GcpConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const project = reqProject(cfg);
  if (!cfg.billingExportTable) {
    return text(
      'Cost needs the BigQuery billing export. Set up Billing → Billing export → BigQuery, then set the ' +
        '**Billing export table** in this plugin (e.g. my-project.billing.gcp_billing_export_v1_XXXXXX).',
      true,
    );
  }
  // Table id is operator-configured (not model input). Validate its shape and quote it defensively.
  if (!/^[A-Za-z0-9_.-]+$/.test(cfg.billingExportTable) || (cfg.billingExportTable.match(/\./g) || []).length < 2) {
    throw new GcpError('Billing export table must be `project.dataset.table`.');
  }
  const days = Math.min(365, Math.max(1, Number(args.days) || 30));
  const groupBy = String(args.groupBy ?? 'service.description');
  if (!/^[A-Za-z0-9_.]+$/.test(groupBy)) throw new GcpError('groupBy must be a column name.');
  const [p, d, t] = cfg.billingExportTable.split('.');
  const table = `\`${p}\`.\`${d}\`.\`${t}\``;
  const query =
    `SELECT ${groupBy} AS group_key, ROUND(SUM(cost), 2) AS cost, currency ` +
    `FROM ${table} ` +
    `WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${days} DAY) ` +
    `GROUP BY group_key, currency ORDER BY cost DESC LIMIT 200`;
  const data = await gcpApi(cfg, SCOPE_BQ, 'POST', new URL(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`), {
    query,
    useLegacySql: false,
    timeoutMs: 30_000,
    maxResults: 200,
  });
  const cols = ((data.schema?.fields ?? []) as any[]).map((f) => f.name);
  const rows = ((data.rows ?? []) as any[]).map((r) => Object.fromEntries(cols.map((c: string, i: number) => [c, r.f?.[i]?.v])));
  if (!data.jobComplete) return text('BigQuery job still running — try a smaller window.', true);
  return text(`Cost by ${groupBy} (last ${days}d) — ${rows.length} row(s):\n\n${clip(JSON.stringify(rows, null, 2))}`);
}

const SETUP = [
  'Google Cloud diagnostics & cost use a **service account** with **read-only** IAM. Once:',
  '',
  '1. **IAM & Admin → Service Accounts → Create** (or pick one), then **Keys → Add key → JSON** and download it.',
  '2. Grant the service account **read-only** roles on the project: **Viewer** (`roles/viewer`) covers resources, ' +
    'logs and metrics; add **Cloud Asset Viewer** for asset search. For cost, also **BigQuery Data Viewer** + ' +
    '**BigQuery Job User** on the billing-export dataset.',
  '3. Enable the APIs you use: Cloud Asset, Cloud Logging, Cloud Monitoring, Cloud Resource Manager (and BigQuery for cost).',
  '4. (Cost) Set up **Billing → Billing export → BigQuery**, then note the export table id (`project.dataset.gcp_billing_export_v1_XXXXXX`).',
  '',
  'Then paste the **Service account JSON**, set a default **Project ID**, and (optionally) the **Billing export table**. Every tool here is read-only.',
].join('\n');

export function gcpPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: GCP_ID,
      name: 'Google Cloud',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Read-only Google Cloud diagnostics & cost over the GCP REST APIs — Cloud Asset (search any resource), ' +
        'Cloud Logging, Cloud Monitoring, and cost from the BigQuery billing export. Service-account (RS256 JWT) ' +
        'auth, no google SDK. No write tools.',
      author: 'Kravn',
      priority: 100,
      setup: SETUP,
      configSchema: {
        type: 'object',
        properties: {
          serviceAccountJson: { type: 'string', title: 'Service account JSON', description: 'The full service-account JSON key.', secret: true },
          projectId: { type: 'string', title: 'Project ID', description: 'Default GCP project id.' },
          billingExportTable: { type: 'string', title: 'Billing export table', description: 'Optional BigQuery billing-export table for gcp_cost (project.dataset.table).' },
        },
        required: ['serviceAccountJson'],
      },
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const cfg = readConfig(config);
          switch (name) {
            case 'gcp_list_projects':
              return await listProjects(cfg);
            case 'gcp_asset_search':
              return await assetSearch(cfg, args);
            case 'gcp_logging_query':
              return await loggingQuery(cfg, args);
            case 'gcp_monitoring_query':
              return await monitoringQuery(cfg, args);
            case 'gcp_cost':
              return await cost(cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Google Cloud request failed.', true);
        }
      },
    },
  };
}
