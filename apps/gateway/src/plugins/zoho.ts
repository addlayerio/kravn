import crypto from 'node:crypto';
import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native Zoho CRM plugin — talk to Zoho CRM over MCP via its v6 REST API. Exposes record read/search/CRUD
 * over ANY module plus **COQL** (the CRM query language, with GROUP BY + COUNT/SUM/AVG aggregates — the
 * "how much / how many" tool) and convenience search for the common modules.
 *
 * Auth is Zoho's server-to-server OAuth 2.0: a **Self Client** (client id + secret) and a long-lived
 * **refresh token** the operator generates once. The secret + refresh token are `secret: true`, so
 * PluginManager encrypts them at rest and write-only-masks them; Kravn refreshes short-lived access tokens
 * automatically. There is NO user-supplied URL — the accounts host is a fixed per-region domain and the API
 * host comes from Zoho's own token response — so there is no SSRF surface. Outbound requests refuse redirects
 * (anti token-exfil), time out, and cap the response.
 */
export const ZOHO_ID = 'kravn-zoho';

class ZohoError extends Error {}

interface ZohoConfig {
  region: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

// Accounts (token) host per Zoho data center. The API host is taken from the token response's api_domain.
const ACCOUNTS: Record<string, string> = {
  US: 'https://accounts.zoho.com',
  EU: 'https://accounts.zoho.eu',
  IN: 'https://accounts.zoho.in',
  AU: 'https://accounts.zoho.com.au',
  JP: 'https://accounts.zoho.jp',
  CA: 'https://accounts.zohocloud.ca',
  CN: 'https://accounts.zoho.com.cn',
};

// Known Zoho CRM API host suffixes — the token response's api_domain must be one of these (or a subdomain).
const ZOHO_API_SUFFIXES = [
  'zohoapis.com',
  'zohoapis.eu',
  'zohoapis.in',
  'zohoapis.com.au',
  'zohoapis.jp',
  'zohoapis.ca',
  'zohoapis.com.cn',
];

const MAX_RESPONSE_BYTES = 10_000_000;
interface Token {
  accessToken: string;
  apiDomain: string;
  expiresAt: number;
}
const tokenCache = new Map<string, Token>(); // config fingerprint -> access token

function clip(s: string, max = 4000): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}
function parseJson(v: unknown, what: string): unknown {
  if (v == null || v === '') return undefined;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    throw new ZohoError(`${what} must be valid JSON.`);
  }
}
/** Zoho module API names are word chars (e.g. Leads, Deals, CustomModule1). Reject anything else so a
 *  module/id can't be used for path traversal. */
function safeModule(m: unknown): string {
  const s = String(m ?? '').trim();
  if (!/^\w+$/.test(s)) throw new ZohoError('Invalid module — use its API name, e.g. Leads, Contacts, Deals.');
  return s;
}
function safeId(id: unknown): string {
  const s = String(id ?? '').trim();
  if (!/^\d+$/.test(s)) throw new ZohoError('Invalid record id (Zoho ids are numeric).');
  return s;
}
function clampPerPage(v: unknown, def = 50): number {
  return Math.min(200, Math.max(1, Number(v) || def));
}

function readConfig(config: Record<string, unknown>): ZohoConfig {
  const region = String(config.region ?? '').trim().toUpperCase();
  const clientId = String(config.clientId ?? '').trim();
  const clientSecret = String(config.clientSecret ?? '').trim();
  const refreshToken = String(config.refreshToken ?? '').trim();
  if (!ACCOUNTS[region] || !clientId || !clientSecret || !refreshToken) {
    throw new ZohoError(
      'Zoho CRM is not configured. Set the Data center, Client ID, Client Secret and Refresh Token ' +
        '(from a Self Client in the Zoho API Console).',
    );
  }
  return { region, clientId, clientSecret, refreshToken };
}

function fingerprint(cfg: ZohoConfig): string {
  return crypto
    .createHash('sha256')
    .update(`${cfg.region}|${cfg.clientId}|${cfg.clientSecret}|${cfg.refreshToken}`)
    .digest('hex');
}

async function getToken(cfg: ZohoConfig, force = false): Promise<Token> {
  const fp = fingerprint(cfg);
  if (!force) {
    const cached = tokenCache.get(fp);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
  }
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
  });
  let res: Response;
  try {
    res = await fetch(`${ACCOUNTS[cfg.region]}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ZohoError(`Could not reach the Zoho accounts server: ${(err as Error).message}`);
  }
  const body = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: { access_token?: string; api_domain?: string; expires_in?: number; error?: string };
  try {
    data = JSON.parse(body);
  } catch {
    throw new ZohoError(`Zoho token endpoint returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!data.access_token) {
    throw new ZohoError(`Zoho token refresh failed: ${clip(String(data.error || `HTTP ${res.status}`), 400)}`);
  }
  const apiDomain = String(data.api_domain || '').replace(/\/$/, '');
  // Defensive: the api host comes from Zoho's own response (reached only via the region-fixed HTTPS
  // accounts endpoint), but pin it to a known `zohoapis.<tld>` host anyway so it can never be pointed
  // elsewhere. Reject anything that isn't exactly, or a subdomain of, a Zoho API domain.
  let host = '';
  try {
    host = new URL(apiDomain).hostname.toLowerCase();
  } catch {
    /* falls through to the check below */
  }
  const okHost = ZOHO_API_SUFFIXES.some((suf) => host === suf || host.endsWith(`.${suf}`));
  if (!apiDomain.startsWith('https://') || !okHost) {
    throw new ZohoError('Zoho token response returned an unexpected api_domain.');
  }
  const token: Token = {
    accessToken: String(data.access_token),
    apiDomain,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  tokenCache.set(fp, token);
  return token;
}

async function zohoApi(
  cfg: ZohoConfig,
  method: string,
  path: string,
  opts: { query?: Record<string, unknown>; body?: unknown } = {},
  retried = false,
): Promise<any> {
  const token = await getToken(cfg);
  const url = new URL(`${token.apiDomain}${path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Zoho-oauthtoken ${token.accessToken}`,
        accept: 'application/json',
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ZohoError(`Could not reach Zoho CRM: ${(err as Error).message}`);
  }
  // A revoked/rotated access token → refresh once and retry.
  if (res.status === 401 && !retried) {
    await getToken(cfg, true);
    return zohoApi(cfg, method, path, opts, true);
  }
  if (res.status === 204) return { data: [] }; // No Content (e.g. empty search)
  const bodyText = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: any;
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new ZohoError(`Zoho returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!res.ok || data?.status === 'error') {
    const msg = data?.message || data?.code || `HTTP ${res.status}`;
    throw new ZohoError(clip(`Zoho CRM error: ${msg}`, 800));
  }
  return data;
}

// ─── Convenience per-module search tools, generated from a table ────────────────────────────────────
interface ModuleSpec {
  tool: string;
  module: string;
  fields: string;
  desc: string;
}
const MODULES: ModuleSpec[] = [
  { tool: 'zoho_crm_leads', module: 'Leads', fields: 'Last_Name,First_Name,Company,Email,Phone,Lead_Status,Lead_Source', desc: 'Search/list CRM Leads.' },
  { tool: 'zoho_crm_contacts', module: 'Contacts', fields: 'Last_Name,First_Name,Email,Phone,Account_Name,Title', desc: 'Search/list CRM Contacts.' },
  { tool: 'zoho_crm_accounts', module: 'Accounts', fields: 'Account_Name,Phone,Website,Industry,Billing_City', desc: 'Search/list CRM Accounts (companies).' },
  { tool: 'zoho_crm_deals', module: 'Deals', fields: 'Deal_Name,Stage,Amount,Closing_Date,Account_Name,Pipeline', desc: 'Search/list CRM Deals (opportunities).' },
];

async function moduleSearch(cfg: ZohoConfig, spec: ModuleSpec, args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query ?? '').trim();
  const perPage = clampPerPage(args.limit);
  const data = q
    ? await zohoApi(cfg, 'GET', `/crm/v6/${spec.module}/search`, { query: { word: q, fields: spec.fields, per_page: perPage } })
    : await zohoApi(cfg, 'GET', `/crm/v6/${spec.module}`, { query: { fields: spec.fields, per_page: perPage } });
  const rows = (data.data ?? []) as unknown[];
  return text(`${rows.length} ${spec.module} record(s):\n\n${clip(JSON.stringify(rows, null, 2))}`);
}

const GENERIC_TOOLS: McpToolDef[] = [
  {
    name: 'zoho_crm_modules',
    description: 'List the Zoho CRM modules (Leads, Contacts, Deals, custom modules…). Returns each module\'s API name (used by the other tools) and label.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zoho_crm_fields',
    description: 'List the fields of a module (API name, type, label) — use this to know what to read/write/query.',
    inputSchema: {
      type: 'object',
      properties: { module: { type: 'string', description: 'Module API name, e.g. Leads.' } },
      required: ['module'],
    },
  },
  {
    name: 'zoho_crm_get_records',
    description: 'List records of a module. v6 needs `fields` (comma-separated API names); use zoho_crm_fields if unsure. Paginate with `page` + `perPage` (max 200).',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Module API name, e.g. Contacts.' },
        fields: { type: 'string', description: 'Comma-separated field API names, e.g. Last_Name,Email,Phone.' },
        page: { type: 'number', description: 'Page number (default 1).' },
        perPage: { type: 'number', description: 'Records per page (default 50, max 200).' },
      },
      required: ['module'],
    },
  },
  {
    name: 'zoho_crm_search',
    description: 'Search a module. Provide exactly ONE of `criteria` / `email` / `phone` / `word`. `criteria` is a Zoho criteria string, e.g. ((Last_Name:equals:Smith)and(City:starts_with:San)).',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Module API name, e.g. Leads.' },
        criteria: { type: 'string', description: 'Zoho criteria string, e.g. (Email:equals:x@y.com).' },
        email: { type: 'string', description: 'Match by email.' },
        phone: { type: 'string', description: 'Match by phone.' },
        word: { type: 'string', description: 'Free-text word search.' },
        fields: { type: 'string', description: 'Comma-separated field API names to return.' },
        perPage: { type: 'number', description: 'Records per page (default 50, max 200).' },
      },
      required: ['module'],
    },
  },
  {
    name: 'zoho_crm_get_record',
    description: 'Get a single record by id.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Module API name.' },
        id: { type: 'string', description: 'Record id (numeric).' },
        fields: { type: 'string', description: 'Optional comma-separated field API names.' },
      },
      required: ['module', 'id'],
    },
  },
  {
    name: 'zoho_crm_coql',
    description:
      'Run a COQL query — the tool for totals/counts/filters ("how much / how many"). Body is a single ' +
      'SELECT string with WHERE, GROUP BY, ORDER BY, LIMIT and aggregates COUNT()/SUM()/AVG()/MIN()/MAX(). ' +
      'Max 2000 rows/call, 50 fields, 25 WHERE criteria. Example — pipeline value by stage: ' +
      "`SELECT Stage, SUM(Amount), COUNT(id) FROM Deals WHERE Closing_Date between '2026-01-01' and '2026-06-30' GROUP BY Stage`.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The COQL SELECT statement.' } },
      required: ['query'],
    },
  },
  {
    name: 'zoho_crm_create',
    description: 'Create record(s) in a module. `records` is a JSON array of field maps, e.g. [{"Last_Name":"Doe","Company":"Acme"}].',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Module API name.' },
        records: { type: 'string', description: 'JSON array of records (field API name → value).' },
      },
      required: ['module', 'records'],
    },
  },
  {
    name: 'zoho_crm_update',
    description: 'Update a single record by id. `record` is a JSON object of field API name → new value.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Module API name.' },
        id: { type: 'string', description: 'Record id (numeric).' },
        record: { type: 'string', description: 'JSON object of fields to set.' },
      },
      required: ['module', 'id', 'record'],
    },
  },
  {
    name: 'zoho_crm_delete',
    description: 'Delete record(s) by id. Irreversible — use with care.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Module API name.' },
        ids: { type: 'string', description: 'JSON array of record ids, e.g. ["123","456"].' },
      },
      required: ['module', 'ids'],
    },
  },
];

async function listModules(cfg: ZohoConfig): Promise<McpToolResult> {
  const data = await zohoApi(cfg, 'GET', '/crm/v6/settings/modules');
  const mods = ((data.modules ?? []) as any[])
    .filter((m) => m.api_supported !== false)
    .map((m) => `• ${m.api_name}  —  ${m.plural_label || m.module_name || ''}`);
  return text(mods.length ? clip(mods.join('\n')) : 'No modules found.');
}

async function listFields(cfg: ZohoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const module = safeModule(args.module);
  const data = await zohoApi(cfg, 'GET', '/crm/v6/settings/fields', { query: { module } });
  const lines = ((data.fields ?? []) as any[]).map(
    (f) => `• ${f.api_name}  (${f.data_type})  —  ${f.field_label ?? ''}`,
  );
  return text(`Fields of ${module} (${lines.length}):\n\n${clip(lines.join('\n'))}`);
}

async function getRecords(cfg: ZohoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const module = safeModule(args.module);
  const data = await zohoApi(cfg, 'GET', `/crm/v6/${module}`, {
    query: { fields: args.fields, page: args.page, per_page: clampPerPage(args.perPage) },
  });
  const rows = (data.data ?? []) as unknown[];
  return text(`${rows.length} ${module} record(s):\n\n${clip(JSON.stringify(rows, null, 2))}`);
}

async function searchRecords(cfg: ZohoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const module = safeModule(args.module);
  const query: Record<string, unknown> = { fields: args.fields, per_page: clampPerPage(args.perPage) };
  // Exactly one search key is honored by Zoho; pass the first provided.
  for (const k of ['criteria', 'email', 'phone', 'word'] as const) {
    if (args[k]) {
      query[k] = args[k];
      break;
    }
  }
  const data = await zohoApi(cfg, 'GET', `/crm/v6/${module}/search`, { query });
  const rows = (data.data ?? []) as unknown[];
  return text(`${rows.length} ${module} record(s):\n\n${clip(JSON.stringify(rows, null, 2))}`);
}

async function getRecord(cfg: ZohoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const module = safeModule(args.module);
  const id = safeId(args.id);
  const data = await zohoApi(cfg, 'GET', `/crm/v6/${module}/${id}`, { query: { fields: args.fields } });
  return text(clip(JSON.stringify((data.data ?? [])[0] ?? data, null, 2)));
}

async function coql(cfg: ZohoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) return text('Error: query (a COQL SELECT statement) is required.', true);
  const data = await zohoApi(cfg, 'POST', '/crm/v6/coql', { body: { select_query: query } });
  const rows = (data.data ?? []) as unknown[];
  return text(`${rows.length} row(s):\n\n${clip(JSON.stringify(rows, null, 2))}`);
}

async function createRecords(cfg: ZohoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const module = safeModule(args.module);
  const records = parseJson(args.records, 'records');
  if (!Array.isArray(records) || !records.length) return text('Error: records must be a non-empty JSON array.', true);
  const data = await zohoApi(cfg, 'POST', `/crm/v6/${module}`, { body: { data: records } });
  return text(clip(JSON.stringify(data.data ?? data, null, 2)));
}

async function updateRecord(cfg: ZohoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const module = safeModule(args.module);
  const id = safeId(args.id);
  const record = parseJson(args.record, 'record');
  if (!record || typeof record !== 'object') return text('Error: record must be a JSON object of fields.', true);
  const data = await zohoApi(cfg, 'PUT', `/crm/v6/${module}/${id}`, { body: { data: [record] } });
  return text(clip(JSON.stringify(data.data ?? data, null, 2)));
}

async function deleteRecords(cfg: ZohoConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const module = safeModule(args.module);
  const ids = parseJson(args.ids, 'ids');
  if (!Array.isArray(ids) || !ids.length) return text('Error: ids must be a non-empty JSON array.', true);
  const idCsv = ids.map((x) => safeId(x)).join(',');
  const data = await zohoApi(cfg, 'DELETE', `/crm/v6/${module}`, { query: { ids: idCsv } });
  return text(clip(JSON.stringify(data.data ?? data, null, 2)));
}

const MODULE_TOOLS: McpToolDef[] = MODULES.map((spec) => ({
  name: spec.tool,
  description: `${spec.desc} Optional \`query\` (free-text) and \`limit\`.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional free-text to match.' },
      limit: { type: 'number', description: 'Max records (default 50, max 200).' },
    },
  },
}));

const TOOLS: McpToolDef[] = [...GENERIC_TOOLS, ...MODULE_TOOLS];

const SETUP = [
  "Zoho CRM's external API uses OAuth 2.0. Create a **Self Client** and generate a long-lived **refresh token** once:",
  '',
  '1. Open the **[Zoho API Console](https://api-console.zoho.com/)** → **Add Client → Self Client**, create it, and copy the **Client ID** and **Client Secret**.',
  '2. On the **Generate Code** tab, enter the scope `ZohoCRM.modules.ALL,ZohoCRM.settings.READ,ZohoCRM.coql.READ`, pick a duration + description, and **Create** — copy the **grant code** (valid a few minutes).',
  '3. Exchange the grant code for a refresh token **once**, against the accounts server for your region:',
  '   `curl -X POST "https://accounts.zoho.com/oauth/v2/token" -d "grant_type=authorization_code&client_id=…&client_secret=…&code=THE_CODE"`',
  '   Copy the `refresh_token` from the response.',
  '',
  'Then set: **Data center** (the region your Zoho account is in), **Client ID**, **Client Secret** and **Refresh Token**. Kravn refreshes short-lived access tokens automatically; the tools can only do what the refresh token\'s scopes allow.',
].join('\n');

export function zohoPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: ZOHO_ID,
      name: 'Zoho CRM',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Interact with Zoho CRM over MCP via its v6 REST API — read/search/CRUD over any module, plus COQL ' +
        '(queries with GROUP BY and COUNT/SUM/AVG aggregates) and convenience search for Leads, Contacts, ' +
        'Accounts and Deals. Server-to-server OAuth 2.0 (Self Client + refresh token); region-aware.',
      author: 'Kravn',
      priority: 100,
      setup: SETUP,
      configSchema: {
        type: 'object',
        properties: {
          region: {
            type: 'string',
            title: 'Data center',
            enum: ['US', 'EU', 'IN', 'AU', 'JP', 'CA', 'CN'],
            description: 'The Zoho data center your account lives in (US = .com, EU = .eu, IN = .in, AU, JP, CA, CN).',
          },
          clientId: { type: 'string', title: 'Client ID', description: 'Self Client ID from the Zoho API Console.' },
          clientSecret: { type: 'string', title: 'Client Secret', description: 'Self Client secret.', secret: true },
          refreshToken: { type: 'string', title: 'Refresh Token', description: 'The long-lived OAuth refresh token you generated.', secret: true },
        },
        required: ['region', 'clientId', 'clientSecret', 'refreshToken'],
      },
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const cfg = readConfig(config);
          const spec = MODULES.find((s) => s.tool === name);
          if (spec) return await moduleSearch(cfg, spec, args);
          switch (name) {
            case 'zoho_crm_modules':
              return await listModules(cfg);
            case 'zoho_crm_fields':
              return await listFields(cfg, args);
            case 'zoho_crm_get_records':
              return await getRecords(cfg, args);
            case 'zoho_crm_search':
              return await searchRecords(cfg, args);
            case 'zoho_crm_get_record':
              return await getRecord(cfg, args);
            case 'zoho_crm_coql':
              return await coql(cfg, args);
            case 'zoho_crm_create':
              return await createRecords(cfg, args);
            case 'zoho_crm_update':
              return await updateRecord(cfg, args);
            case 'zoho_crm_delete':
              return await deleteRecords(cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Zoho CRM request failed.', true);
        }
      },
    },
  };
}
