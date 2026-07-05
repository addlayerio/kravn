import crypto from 'node:crypto';
import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native Odoo plugin — talk to any Odoo instance (self-hosted or Odoo Online) over MCP via Odoo's external
 * **JSON-RPC** API (no XML-RPC dependency; just fetch). Exposes generic CRUD over ANY model (so the whole of
 * Odoo is reachable) plus convenience search tools for the common CRM / ERP models.
 *
 * Auth is Odoo's standard external-API model: database + username + API key (Preferences → Account Security →
 * New API Key), or the user password. The key is `secret: true`, so PluginManager encrypts it at rest and
 * write-only-masks it. Outbound requests refuse redirects (anti token-exfil), time out, and cap the response.
 */
export const ODOO_ID = 'kravn-odoo';

class OdooError extends Error {}
interface OdooConfig {
  url: string;
  db: string;
  username: string;
  apiKey: string;
}

const MAX_RESPONSE_BYTES = 10_000_000;
const uidCache = new Map<string, number>(); // config fingerprint -> authenticated uid (stable per user/key)

function clip(s: string, max = 4000): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}

/** https/http only; reject loopback/link-local/IPv6 literals so the API key can't be aimed at localhost/metadata. */
function normalizeOdooUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new OdooError('Invalid Odoo URL. Use e.g. https://your-instance.odoo.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new OdooError('Odoo URL must be http(s).');
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes(':')) throw new OdooError('Odoo URL host cannot be an IPv6 literal.');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || /^127\./.test(h) || /^169\.254\./.test(h)) {
    throw new OdooError('Odoo URL host is not allowed.');
  }
  return `${u.protocol}//${u.host}`;
}

function readConfig(config: Record<string, unknown>): OdooConfig {
  const url = String(config.url ?? '').trim();
  const db = String(config.db ?? '').trim();
  const username = String(config.username ?? '').trim();
  const apiKey = String(config.apiKey ?? '').trim();
  if (!url || !db || !username || !apiKey) {
    throw new OdooError(
      'Odoo is not configured. Set the Odoo URL, Database, Username and API Key (Odoo → Preferences → ' +
        'Account Security → New API Key).',
    );
  }
  return { url: normalizeOdooUrl(url), db, username, apiKey };
}

function fingerprint(cfg: OdooConfig): string {
  return crypto.createHash('sha256').update(`${cfg.url}|${cfg.db}|${cfg.username}|${cfg.apiKey}`).digest('hex');
}

async function odooRpc(cfg: OdooConfig, service: string, method: string, args: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args } }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new OdooError(`Could not reach Odoo at ${cfg.url}: ${(err as Error).message}`);
  }
  const body = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: { result?: unknown; error?: { message?: string; data?: { message?: string } } };
  try {
    data = JSON.parse(body);
  } catch {
    throw new OdooError(`Odoo returned a non-JSON response (HTTP ${res.status}). Check the URL points at Odoo.`);
  }
  if (data.error) {
    throw new OdooError(clip(String(data.error.data?.message || data.error.message || 'Odoo RPC error'), 800));
  }
  return data.result;
}

async function authenticate(cfg: OdooConfig): Promise<number> {
  const fp = fingerprint(cfg);
  const cached = uidCache.get(fp);
  if (cached) return cached;
  const uid = await odooRpc(cfg, 'common', 'authenticate', [cfg.db, cfg.username, cfg.apiKey, {}]);
  if (!uid || typeof uid !== 'number') {
    throw new OdooError('Odoo authentication failed — check the Database, Username and API Key.');
  }
  uidCache.set(fp, uid);
  return uid;
}

async function execKw(
  cfg: OdooConfig,
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {},
): Promise<unknown> {
  const uid = await authenticate(cfg);
  return odooRpc(cfg, 'object', 'execute_kw', [cfg.db, uid, cfg.apiKey, model, method, args, kwargs]);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────
function clampLimit(v: unknown, def = 20, max = 100): number {
  return Math.min(max, Math.max(1, Number(v) || def));
}
function parseJson(v: unknown, what: string): unknown {
  if (v == null || v === '') return undefined;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    throw new OdooError(`${what} must be valid JSON.`);
  }
}
/** Build an Odoo OR-domain over `fields` all `ilike` the query (n-1 leading '|' operators). */
function orIlike(fields: string[], q: string): unknown[] {
  const terms = fields.map((f) => [f, 'ilike', q]);
  return [...Array(Math.max(0, terms.length - 1)).fill('|'), ...terms];
}
function fmtVal(v: unknown): string {
  if (Array.isArray(v)) return v.length === 2 && typeof v[1] === 'string' ? v[1] : JSON.stringify(v); // many2one [id,name]
  if (v === false || v == null) return '—';
  return String(v);
}
function fmtRecords(records: Record<string, unknown>[], fields: string[]): string {
  if (!records.length) return 'No records found.';
  return records
    .map((r) => `• #${r.id}  ` + fields.map((f) => `${f}: ${fmtVal(r[f])}`).join('  ·  '))
    .join('\n');
}

// ─── Domain (CRM / ERP) search tools, generated from a table ──────────────────────────────────────
interface DomainSpec {
  tool: string;
  model: string;
  fields: string[];
  search: string[];
  desc: string;
}
const DOMAIN: DomainSpec[] = [
  { tool: 'odoo_crm_leads', model: 'crm.lead', fields: ['name', 'contact_name', 'email_from', 'stage_id', 'expected_revenue', 'user_id'], search: ['name', 'contact_name', 'email_from'], desc: 'Search CRM leads/opportunities (crm.lead) by title, contact or email.' },
  { tool: 'odoo_contacts', model: 'res.partner', fields: ['name', 'email', 'phone', 'city', 'country_id', 'is_company'], search: ['name', 'email', 'phone'], desc: 'Search contacts/companies (res.partner) by name, email or phone.' },
  { tool: 'odoo_sale_orders', model: 'sale.order', fields: ['name', 'partner_id', 'state', 'amount_total', 'date_order'], search: ['name'], desc: 'Search sales orders (sale.order) by reference.' },
  { tool: 'odoo_invoices', model: 'account.move', fields: ['name', 'partner_id', 'state', 'amount_total', 'invoice_date', 'move_type'], search: ['name'], desc: 'Search invoices/bills (account.move) by number.' },
  { tool: 'odoo_products', model: 'product.product', fields: ['name', 'default_code', 'list_price', 'qty_available'], search: ['name', 'default_code'], desc: 'Search products (product.product) by name or internal reference.' },
  { tool: 'odoo_project_tasks', model: 'project.task', fields: ['name', 'project_id', 'stage_id', 'date_deadline'], search: ['name'], desc: 'Search project tasks (project.task) by name.' },
  { tool: 'odoo_employees', model: 'hr.employee', fields: ['name', 'job_title', 'work_email', 'department_id'], search: ['name', 'work_email'], desc: 'Search employees (hr.employee) by name or work email.' },
];

async function domainSearch(cfg: OdooConfig, spec: DomainSpec, args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query ?? '').trim();
  const limit = clampLimit(args.limit);
  const domain = q ? orIlike(spec.search, q) : [];
  const records = (await execKw(cfg, spec.model, 'search_read', [domain], { fields: spec.fields, limit })) as Record<string, unknown>[];
  return text(`${records.length} ${spec.model} record(s):\n\n${fmtRecords(records, spec.fields)}`);
}

// ─── Generic + domain tool definitions ────────────────────────────────────────────────────────────
const GENERIC_TOOLS: McpToolDef[] = [
  {
    name: 'odoo_list_models',
    description: 'List Odoo models (tables) available, optionally filtered. Returns the technical model name (e.g. crm.lead) and label.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional filter over model name/label.' }, limit: { type: 'number', description: 'Max results (default 40, max 100).' } },
    },
  },
  {
    name: 'odoo_fields',
    description: 'Describe the fields of an Odoo model (name, type, label, required) — use this to know what to read/write.',
    inputSchema: {
      type: 'object',
      properties: { model: { type: 'string', description: 'Technical model name, e.g. crm.lead.' } },
      required: ['model'],
    },
  },
  {
    name: 'odoo_search_read',
    description: 'Search + read records of ANY Odoo model. `domain` is an Odoo domain as JSON (e.g. [["name","ilike","acme"]]); `fields` limits columns.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Technical model name, e.g. res.partner.' },
        domain: { type: 'string', description: 'Odoo domain as a JSON array, e.g. [["is_company","=",true]]. Empty = all.' },
        fields: { type: 'string', description: 'JSON array of field names to return, e.g. ["name","email"]. Empty = a default set.' },
        limit: { type: 'number', description: 'Max records (default 20, max 100).' },
      },
      required: ['model'],
    },
  },
  {
    name: 'odoo_create',
    description: 'Create a record in any Odoo model. `values` is a JSON object of field → value. Returns the new record id.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Technical model name, e.g. crm.lead.' },
        values: { type: 'string', description: 'JSON object of field values, e.g. {"name":"New lead","email_from":"x@y.com"}.' },
      },
      required: ['model', 'values'],
    },
  },
  {
    name: 'odoo_write',
    description: 'Update existing records in any Odoo model. Provide the record ids and a JSON object of field → new value.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Technical model name.' },
        ids: { type: 'string', description: 'JSON array of record ids, e.g. [12,15].' },
        values: { type: 'string', description: 'JSON object of field values to set.' },
      },
      required: ['model', 'ids', 'values'],
    },
  },
  {
    name: 'odoo_unlink',
    description: 'Delete records from any Odoo model by id. Irreversible — use with care.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Technical model name.' },
        ids: { type: 'string', description: 'JSON array of record ids to delete, e.g. [12,15].' },
      },
      required: ['model', 'ids'],
    },
  },
];

const DEFAULT_FIELDS = ['id', 'display_name', 'name'];

async function listModels(cfg: OdooConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query ?? '').trim();
  const limit = clampLimit(args.limit, 40);
  const domain = q ? orIlike(['model', 'name'], q) : [];
  const rows = (await execKw(cfg, 'ir.model', 'search_read', [domain], { fields: ['model', 'name'], limit })) as Record<string, unknown>[];
  if (!rows.length) return text('No models found.');
  return text(rows.map((r) => `• ${r.model}  —  ${r.name}`).join('\n'));
}

async function describeFields(cfg: OdooConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const model = String(args.model ?? '').trim();
  if (!model) return text('Error: model is required.', true);
  const fields = (await execKw(cfg, model, 'fields_get', [], { attributes: ['string', 'type', 'required'] })) as Record<string, { string?: string; type?: string; required?: boolean }>;
  const lines = Object.entries(fields).map(([name, m]) => `• ${name}  (${m.type})${m.required ? ' *required' : ''}  —  ${m.string ?? ''}`);
  return text(`Fields of ${model} (${lines.length}):\n\n${clip(lines.join('\n'))}`);
}

async function searchRead(cfg: OdooConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const model = String(args.model ?? '').trim();
  if (!model) return text('Error: model is required.', true);
  const domain = (parseJson(args.domain, 'domain') as unknown[]) ?? [];
  const fields = (parseJson(args.fields, 'fields') as string[]) ?? DEFAULT_FIELDS;
  const limit = clampLimit(args.limit);
  const records = (await execKw(cfg, model, 'search_read', [domain], { fields, limit })) as Record<string, unknown>[];
  return text(`${records.length} ${model} record(s):\n\n${clip(JSON.stringify(records, null, 2))}`);
}

async function createRecord(cfg: OdooConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const model = String(args.model ?? '').trim();
  const values = parseJson(args.values, 'values');
  if (!model || !values) return text('Error: model and values are required.', true);
  const id = await execKw(cfg, model, 'create', [values]);
  return text(`Created ${model} #${id}.`);
}

async function writeRecord(cfg: OdooConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const model = String(args.model ?? '').trim();
  const ids = parseJson(args.ids, 'ids') as number[];
  const values = parseJson(args.values, 'values');
  if (!model || !Array.isArray(ids) || !ids.length || !values) return text('Error: model, ids (non-empty array) and values are required.', true);
  await execKw(cfg, model, 'write', [ids, values]);
  return text(`Updated ${model} ${JSON.stringify(ids)}.`);
}

async function unlinkRecord(cfg: OdooConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const model = String(args.model ?? '').trim();
  const ids = parseJson(args.ids, 'ids') as number[];
  if (!model || !Array.isArray(ids) || !ids.length) return text('Error: model and ids (non-empty array) are required.', true);
  await execKw(cfg, model, 'unlink', [ids]);
  return text(`Deleted ${model} ${JSON.stringify(ids)}.`);
}

const DOMAIN_TOOLS: McpToolDef[] = DOMAIN.map((spec) => ({
  name: spec.tool,
  description: `${spec.desc} Optional \`query\` (text filter) and \`limit\`.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional text to match.' },
      limit: { type: 'number', description: 'Max records (default 20, max 100).' },
    },
  },
}));

const TOOLS: McpToolDef[] = [...GENERIC_TOOLS, ...DOMAIN_TOOLS];

export function odooPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: ODOO_ID,
      name: 'Odoo',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Interact with Odoo (CRM & ERP) over MCP via its JSON-RPC external API — works with any hosting: ' +
        'Odoo Online (odoo.com), Odoo.sh, and self-hosted. Generic CRUD over any model plus convenience ' +
        'search for leads, contacts, sales orders, invoices, products, tasks and employees. Requires the ' +
        'Odoo URL, database, username and API key.',
      author: 'Kravn',
      priority: 100,
      setup:
        'Works with Odoo Online, Odoo.sh and self-hosted — they all expose the same JSON-RPC API. Create an ' +
        'API key in Odoo: top-right avatar → Preferences → Account Security → New API Key (Odoo Online ' +
        'requires a key; self-hosted also accepts the password). Then set: Odoo URL (Online: ' +
        'https://your-company.odoo.com · Odoo.sh: your project/branch URL · self-hosted: your URL), the ' +
        'Database name, the Username (login email) and the API Key. Finding the database name: Online it is ' +
        'usually your-company; on Odoo.sh it is NOT the subdomain — open your Odoo with ?debug=1 and copy the ' +
        'name shown top-right in brackets (it may include a build-id suffix, e.g. company-branch-18-0-1234567), ' +
        "and make sure the URL and database are from the SAME build. The user's Odoo access rights govern what the tools can do.",
      configSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', title: 'Odoo URL', description: 'Online: https://your-company.odoo.com · Odoo.sh or self-hosted: your instance URL.' },
          db: {
            type: 'string',
            title: 'Database',
            description:
              'The Odoo database name. Online: usually your-company. Odoo.sh: it is NOT the subdomain — ' +
              'open your Odoo with ?debug=1 (e.g. https://your-company.odoo.com/web?debug=1) and copy the ' +
              'name shown top-right in brackets next to your user; it may include a build-id suffix, e.g. ' +
              'company-branch-18-0-1234567.',
          },
          username: { type: 'string', title: 'Username', description: 'The login (email) of the API user.' },
          apiKey: { type: 'string', title: 'API Key', description: 'Odoo API key (Preferences → Account Security → New API Key), or the user password.', secret: true },
        },
        required: ['url', 'db', 'username', 'apiKey'],
      },
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const cfg = readConfig(config);
          const spec = DOMAIN.find((s) => s.tool === name);
          if (spec) return await domainSearch(cfg, spec, args);
          switch (name) {
            case 'odoo_list_models':
              return await listModels(cfg, args);
            case 'odoo_fields':
              return await describeFields(cfg, args);
            case 'odoo_search_read':
              return await searchRead(cfg, args);
            case 'odoo_create':
              return await createRecord(cfg, args);
            case 'odoo_write':
              return await writeRecord(cfg, args);
            case 'odoo_unlink':
              return await unlinkRecord(cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Odoo request failed.', true);
        }
      },
    },
  };
}
