import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native Testmo plugin — read a Testmo test-management instance over MCP via its REST API v1.
 *
 * In-process TypeScript like Kravn's other native plugins. Auth is a single Bearer token, marked
 * `secret: true` so PluginManager stores it encrypted and masks it write-only. Create it in Testmo:
 *
 *     Testmo → your profile → API tokens
 *
 * (or have an admin create a dedicated API user — the token's own permissions are the hard ceiling,
 * e.g. `/groups` and `/roles` are admin-only and 403 for a normal user.)
 *
 * The instance is per-tenant (`https://<name>.testmo.net`), so the site URL is config, not a constant —
 * it goes through the same normalization the Atlassian plugins use (https-only, no loopback/link-local)
 * on top of the gateway's global SSRF-pinning dispatcher.
 *
 * WRITES ARE OPT-IN. The read tools are always exposed; the mutating ones (cases + folders CRUD) appear
 * only when `allowWrites` is on, so an instance that already exists keeps its read-only behaviour until an
 * admin deliberately turns writing on. They are named create/update/delete so an admin can additionally hold
 * them behind the maker-checker approval gate. The token's own Testmo permissions remain the hard ceiling.
 *
 * What the API can and cannot write (verified against Testmo's OpenAPI-generated client, not guessed):
 *  - repository CASES and FOLDERS: full create / update / delete, all BULK collection endpoints keyed by `ids`.
 *  - manual RUNS, MILESTONES and RUN RESULTS: **GET only** — the API exposes no way to create or edit them.
 *  - automation runs/threads: writable (create → thread → append tests → complete), deliberately NOT exposed
 *    here; that is a CI submission contract, and an LLM appending test results fabricates a compliance record.
 *  - attachments: writable, but need file bytes this plugin has no way to source.
 *
 * Every list endpoint shares one envelope: { page, prev_page, next_page, last_page, per_page, total,
 * result: [...] }. Single-resource GETs return the object (some wrapped in `result`) — `unwrap` handles both.
 */
export const TESTMO_ID = 'kravn-testmo';

const MAX_RESPONSE_BYTES = 10_000_000;
const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 100;
/** Cap the rows rendered into one tool result so a 10k-case project can't blow the model's context. */
const MAX_RENDERED = 200;

class TestmoError extends Error {}

/** Testmo's bulk write endpoints cap a request at 100 items. */
const MAX_BULK = 100;

interface TestmoConfig {
  baseUrl: string;
  apiToken: string;
  allowWrites: boolean;
}

function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}

function clip(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** https-only, no loopback/link-local, path+query stripped. Mirrors the Atlassian plugins' guard. */
function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new TestmoError('Invalid site URL. Use your Testmo site, e.g. https://your-team.testmo.net');
  }
  if (u.protocol !== 'https:') throw new TestmoError('Site URL must use https.');
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes(':')) throw new TestmoError('Site URL host is not allowed (use a hostname, not an IPv6 literal).');
  const blocked =
    h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || /^127\./.test(h) || /^169\.254\./.test(h);
  if (blocked) throw new TestmoError('Site URL host is not allowed.');
  return `${u.protocol}//${u.host}`;
}

function readConfig(config: Record<string, unknown>): TestmoConfig {
  const baseUrlRaw = String(config.baseUrl ?? '').trim();
  const apiToken = String(config.apiToken ?? '').trim();
  if (!baseUrlRaw || !apiToken) {
    throw new TestmoError(
      'Testmo is not configured. Set the Site URL (e.g. https://your-team.testmo.net) and an API token ' +
        '(Testmo → your profile → API tokens).',
    );
  }
  return { baseUrl: normalizeBaseUrl(baseUrlRaw), apiToken, allowWrites: config.allowWrites === true };
}

async function testmoFetch(
  cfg: TestmoConfig,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  jsonBody?: unknown,
): Promise<any> {
  const res = await fetch(`${cfg.baseUrl}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.apiToken}`,
      accept: 'application/json',
      // Testmo answers 415 when a write arrives without an explicit JSON content-type.
      ...(jsonBody !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
    redirect: 'error', // never follow a redirect with the token attached (anti-SSRF / anti-exfil)
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 204) return {}; // bulk delete answers 204 with no body
  if (res.status === 401 || res.status === 403) {
    throw new TestmoError(
      `Testmo rejected the request (${res.status}). Check the API token, and note that some endpoints ` +
        '(users, groups, roles) need an admin account — the token\'s own permissions are the ceiling.',
    );
  }
  if (res.status === 404) throw new TestmoError('Not found (check the project / run / case id).');
  if (Number(res.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) {
    throw new TestmoError('Testmo response is too large to process.');
  }
  const body = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: any = {};
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    // 422 carries per-field validation detail — surface it, it's what makes a failed write fixable.
    const fields = data?.errors && typeof data.errors === 'object'
      ? Object.entries(data.errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('; ')
      : '';
    const msg = fields || data?.error?.message || data?.message || `Testmo HTTP ${res.status}`;
    throw new TestmoError(clip(`HTTP ${res.status} — ${msg}`));
  }
  return data;
}

/** Parse a caller-supplied id list into the numeric array Testmo's bulk endpoints expect. */
function idList(v: unknown, name: string): number[] {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(',');
  const ids = raw.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new TestmoError(`${name} is required — pass one or more numeric ids.`);
  if (ids.length > MAX_BULK) throw new TestmoError(`${name}: Testmo accepts at most ${MAX_BULK} ids per request (got ${ids.length}).`);
  return ids;
}

/** Copy only the optional fields the caller actually set, so a PATCH never blanks an unmentioned field. */
function pick(args: Record<string, unknown>, spec: Array<[string, string, 'string' | 'number' | 'strings' | 'numbers']>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [argName, apiName, kind] of spec) {
    const v = args[argName];
    if (v === undefined || v === null || v === '') continue;
    if (kind === 'number') out[apiName] = Number(v);
    else if (kind === 'string') out[apiName] = String(v);
    else if (kind === 'numbers') out[apiName] = (Array.isArray(v) ? v : String(v).split(',')).map((x) => Number(String(x).trim())).filter(Number.isFinite);
    else out[apiName] = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
  }
  return out;
}

/** List envelope → rows. */
const rows = (data: any): any[] => (Array.isArray(data?.result) ? data.result : Array.isArray(data) ? data : []);
/** Single-resource GET → the object, whether or not it's wrapped in `result`. */
function unwrap(data: any): any {
  const r = data?.result;
  if (Array.isArray(r)) return r[0] ?? {};
  return r && typeof r === 'object' ? r : data;
}

/** "page 1/4 · 41 total" — the envelope's paging metadata, when present. */
function pageInfo(data: any): string {
  const parts: string[] = [];
  if (data?.page != null) parts.push(`page ${data.page}${data?.last_page != null ? `/${data.last_page}` : ''}`);
  if (data?.total != null) parts.push(`${data.total} total`);
  return parts.length ? `  (${parts.join(' · ')})` : '';
}

function num(v: unknown, fallback: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function reqId(v: unknown, name: string): string {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) throw new TestmoError(`${name} must be a numeric id.`);
  return s;
}

/** Build a query string from paging + whichever optional filters the caller actually passed. */
function query(args: Record<string, unknown>, extra: string[] = []): string {
  const qs = [`page=${num(args.page, 1, 100_000)}`, `per_page=${num(args.perPage, DEFAULT_PER_PAGE, MAX_PER_PAGE)}`, ...extra];
  return `?${qs.join('&')}`;
}

function optFilter(args: Record<string, unknown>, argName: string, param: string): string[] {
  const v = String(args[argName] ?? '').trim();
  return v ? [`${param}=${encodeURIComponent(v)}`] : [];
}

/**
 * Render rows the caller's way: always id + a name-ish label, then whichever of `fields` are populated.
 * Testmo's per-resource shapes vary by instance configuration (custom fields, statuses), so unknown
 * extras are shown as compact key=value rather than silently dropped or guessed at.
 */
function fmtRows(list: any[], fields: string[]): string {
  return list
    .slice(0, MAX_RENDERED)
    .map((r) => {
      const label = r?.name ?? r?.title ?? r?.subject ?? '(unnamed)';
      const extras = fields
        .filter((f) => r?.[f] !== undefined && r?.[f] !== null && r?.[f] !== '')
        .map((f) => `${f}=${clip(String(r[f]), 60)}`);
      return `• ${r?.id ?? '?'}  ${clip(String(label), 80)}${extras.length ? `  [${extras.join(' ')}]` : ''}`;
    })
    .join('\n');
}

function truncNote(total: number): string {
  return total > MAX_RENDERED ? `\n\n(showing ${MAX_RENDERED} of ${total} on this page — narrow with filters or page through)` : '';
}

/** Detail view: Testmo objects carry instance-specific custom fields, so print the object rather than guess. */
function fmtDetail(title: string, obj: any): string {
  return `# ${title}\n\n${clip(JSON.stringify(obj, null, 2), 6000)}`;
}

// ─── Tools ─────────────────────────────────────────────────────────────────────────────────────

const PAGING = {
  page: { type: 'number', description: 'Page number (default 1).' },
  perPage: { type: 'number', description: `Rows per page (default ${DEFAULT_PER_PAGE}, max ${MAX_PER_PAGE}).` },
} as const;

const STATUS_NOTE =
  'Testmo statuses are configurable per instance, so results carry a numeric `status_id` rather than a fixed ' +
  'name — correlate the ids across a run before drawing conclusions about pass/fail counts.';

const READ_TOOLS: McpToolDef[] = [
  {
    name: 'testmo_list_projects',
    description:
      'List the Testmo projects this token can see (id + name). Start here — nearly every other Testmo tool ' +
      'takes a projectId.',
    inputSchema: { type: 'object', properties: { ...PAGING } },
  },
  {
    name: 'testmo_get_project',
    description: 'Get one project by id, with its full configuration as stored in Testmo.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Numeric project id (from testmo_list_projects).' } },
      required: ['projectId'],
    },
  },
  {
    name: 'testmo_list_milestones',
    description:
      'List a project\'s milestones — the releases/sprints test activity is grouped under. Use it to scope runs ' +
      'and sessions to a delivery.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Numeric project id.' }, ...PAGING },
      required: ['projectId'],
    },
  },
  {
    name: 'testmo_list_runs',
    description:
      'List a project\'s manual test runs with their aggregated statistics — the "how did this test cycle go" view. ' +
      'Use testmo_list_run_results for the per-test detail of one run.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Numeric project id.' }, ...PAGING },
      required: ['projectId'],
    },
  },
  {
    name: 'testmo_get_run',
    description: 'Get one test run by id: its configuration, milestone and aggregated result statistics.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Numeric run id.' } },
      required: ['runId'],
    },
  },
  {
    name: 'testmo_list_run_results',
    description:
      'The per-test results logged in one run — who logged what, when, with elapsed time and failure notes. ' +
      'This is the tool for "why did this run fail" and for pulling failure notes into a report. Filter by ' +
      '`statusId` to isolate failures, or by date/user. ' + STATUS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Numeric run id.' },
        statusId: { type: 'string', description: 'Optional status id to filter to (e.g. only failed results).' },
        createdBy: { type: 'string', description: 'Optional user id — only results logged by that person.' },
        createdAfter: { type: 'string', description: 'Optional ISO 8601 timestamp, e.g. 2026-02-17T00:00:00Z.' },
        createdBefore: { type: 'string', description: 'Optional ISO 8601 timestamp.' },
        expands: { type: 'string', description: 'Optional related data to inline, e.g. "issues,users".' },
        ...PAGING,
      },
      required: ['runId'],
    },
  },
  {
    name: 'testmo_list_cases',
    description:
      'List a project\'s test cases — the case repository. Each row carries its folder, template, state/status ids ' +
      'and whether it has automation coverage. Filter by `folderId` to walk one part of the tree ' +
      '(see testmo_list_folders), or by creation date.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Numeric project id.' },
        folderId: { type: 'string', description: 'Optional folder id to list only that folder\'s cases.' },
        templateId: { type: 'string', description: 'Optional template id filter.' },
        createdAfter: { type: 'string', description: 'Optional ISO 8601 timestamp.' },
        createdBefore: { type: 'string', description: 'Optional ISO 8601 timestamp.' },
        ...PAGING,
      },
      required: ['projectId'],
    },
  },
  {
    name: 'testmo_list_folders',
    description: 'List a project\'s case folders — the tree the test case repository is organised into.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Numeric project id.' }, ...PAGING },
      required: ['projectId'],
    },
  },
  {
    name: 'testmo_list_automation_runs',
    description:
      'List a project\'s AUTOMATION runs — the results your CI pipeline submits to Testmo, as opposed to the ' +
      'manual runs in testmo_list_runs. Use it to see whether a pipeline is reporting and how it is trending.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Numeric project id.' }, ...PAGING },
      required: ['projectId'],
    },
  },
  {
    name: 'testmo_get_automation_run',
    description: 'Get one automation run by id: its source, configurations, threads and aggregated statistics.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Numeric automation run id.' } },
      required: ['runId'],
    },
  },
  {
    name: 'testmo_list_automation_sources',
    description:
      'List a project\'s automation sources — the named pipelines/suites (e.g. "e2e", "unit") that submit ' +
      'automation runs. Use it to know which pipelines are wired up at all.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Numeric project id.' }, ...PAGING },
      required: ['projectId'],
    },
  },
  {
    name: 'testmo_list_sessions',
    description:
      'List a project\'s exploratory testing sessions with their result statistics — the unscripted testing ' +
      'alongside runs and automation.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Numeric project id.' }, ...PAGING },
      required: ['projectId'],
    },
  },
  {
    name: 'testmo_list_users',
    description:
      'List Testmo users (id + name), to resolve the user ids that appear on runs and results. Site admins see ' +
      'extended detail; a non-admin token may get a 403 here.',
    inputSchema: { type: 'object', properties: { ...PAGING } },
  },
];

/**
 * Mutating tools — exposed ONLY when `allowWrites` is on. All four Testmo write endpoints are BULK
 * collection routes (one call touches up to 100 rows), which is why update/delete take an `ids` list
 * rather than a single id: the API has no per-row write route.
 */
const LOOKUP_NOTE =
  'Ids like folder_id / template_id / state_id are instance-specific — read them off an existing case or ' +
  'folder (testmo_list_cases / testmo_list_folders) before passing them, rather than assuming a value.';

const WRITE_TOOLS: McpToolDef[] = [
  {
    name: 'testmo_create_cases',
    description:
      'Create one or more repository test cases in a project (up to 100 per call). Only `name` is required per ' +
      'case; everything else is optional. Returns the created ids. ' + LOOKUP_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Numeric project id.' },
        cases: {
          type: 'array',
          description: 'The cases to create (max 100).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Case title (required).' },
              folderId: { type: 'number', description: 'Folder to file the case under.' },
              templateId: { type: 'number', description: 'Case template id.' },
              stateId: { type: 'number', description: 'Workflow state id.' },
              estimate: { type: 'number', description: 'Estimate, in seconds.' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Tag names.' },
              issues: { type: 'array', items: { type: 'number' }, description: 'Linked issue ids.' },
              automationLinks: { type: 'array', items: { type: 'number' }, description: 'Linked automation test ids.' },
            },
            required: ['name'],
          },
        },
      },
      required: ['projectId', 'cases'],
    },
  },
  {
    name: 'testmo_update_cases',
    description:
      'Update repository test cases IN BULK: every field you pass is applied to EVERY id in `ids` (Testmo has no ' +
      'per-case write route). Pass one id to edit a single case. Fields left out are untouched. Common use: move ' +
      'cases to another folder, or set a workflow state across a batch. ' + LOOKUP_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Numeric project id.' },
        ids: { type: 'array', items: { type: 'number' }, description: 'Case ids to update (max 100). ALL of them get the same values.' },
        name: { type: 'string', description: 'New title — careful, this sets the SAME title on every id.' },
        folderId: { type: 'number', description: 'Move the cases into this folder.' },
        stateId: { type: 'number', description: 'New workflow state id.' },
        statusId: { type: 'number', description: 'New status id.' },
        estimate: { type: 'number', description: 'New estimate, in seconds.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replace the tag list.' },
        issues: { type: 'array', items: { type: 'number' }, description: 'Replace the linked issue ids.' },
        automationLinks: { type: 'array', items: { type: 'number' }, description: 'Replace the linked automation test ids.' },
      },
      required: ['projectId', 'ids'],
    },
  },
  {
    name: 'testmo_delete_cases',
    description:
      'Permanently delete repository test cases by id (up to 100 per call). Destructive and not undoable from the ' +
      'API — the deleted cases and their history leave the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Numeric project id.' },
        ids: { type: 'array', items: { type: 'number' }, description: 'Case ids to delete (max 100).' },
      },
      required: ['projectId', 'ids'],
    },
  },
  {
    name: 'testmo_create_folders',
    description:
      'Create one or more case folders in a project (up to 100 per call). Pass `parentId` to nest under an ' +
      'existing folder, or omit it for a root folder. Returns the created ids — use them as `folderId` when ' +
      'creating cases.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Numeric project id.' },
        folders: {
          type: 'array',
          description: 'The folders to create (max 100).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Folder name (required).' },
              parentId: { type: 'number', description: 'Parent folder id; omit for a root-level folder.' },
              docs: { type: 'string', description: 'Optional description / notes.' },
              displayOrder: { type: 'number', description: 'Optional display order.' },
            },
            required: ['name'],
          },
        },
      },
      required: ['projectId', 'folders'],
    },
  },
  {
    name: 'testmo_update_folders',
    description:
      'Update case folders IN BULK — every field you pass is applied to EVERY id in `ids`. Use it to rename a ' +
      'folder (pass a single id) or re-parent a batch of folders.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Numeric project id.' },
        ids: { type: 'array', items: { type: 'number' }, description: 'Folder ids to update (max 100).' },
        name: { type: 'string', description: 'New name — sets the SAME name on every id.' },
        parentId: { type: 'number', description: 'Move the folders under this parent.' },
        docs: { type: 'string', description: 'New description / notes.' },
      },
      required: ['projectId', 'ids'],
    },
  },
  {
    name: 'testmo_delete_folders',
    description:
      'Permanently delete case folders by id (up to 100 per call). Destructive: deleting a folder takes its ' +
      'contents with it — list the folder\'s cases first if you are unsure.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Numeric project id.' },
        ids: { type: 'array', items: { type: 'number' }, description: 'Folder ids to delete (max 100).' },
      },
      required: ['projectId', 'ids'],
    },
  },
];

// ─── Tool implementations ──────────────────────────────────────────────────────────────────────

/** Shared shape for every list tool: fetch → render rows → append paging + truncation notes. */
async function listTool(
  cfg: TestmoConfig,
  path: string,
  args: Record<string, unknown>,
  opts: { label: string; empty: string; fields: string[]; extraQuery?: string[] },
): Promise<McpToolResult> {
  const data = await testmoFetch(cfg, `${path}${query(args, opts.extraQuery ?? [])}`);
  const list = rows(data);
  if (!list.length) return text(opts.empty);
  return text(`${opts.label}${pageInfo(data)}:\n\n${fmtRows(list, opts.fields)}${truncNote(list.length)}`);
}

export async function callTestmo(cfg: TestmoConfig, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  switch (name) {
    case 'testmo_list_projects':
      return listTool(cfg, '/projects', args, {
        label: 'Projects',
        empty: 'No projects visible to this token.',
        fields: ['key', 'is_completed', 'created_at'],
      });

    case 'testmo_get_project': {
      const id = reqId(args.projectId, 'projectId');
      return text(fmtDetail(`Project ${id}`, unwrap(await testmoFetch(cfg, `/projects/${id}`))));
    }

    case 'testmo_list_milestones': {
      const id = reqId(args.projectId, 'projectId');
      return listTool(cfg, `/projects/${id}/milestones`, args, {
        label: `Milestones in project ${id}`,
        empty: `No milestones in project ${id}.`,
        fields: ['is_completed', 'started_at', 'due_at'],
      });
    }

    case 'testmo_list_runs': {
      const id = reqId(args.projectId, 'projectId');
      return listTool(cfg, `/projects/${id}/runs`, args, {
        label: `Test runs in project ${id}`,
        empty: `No test runs in project ${id}.`,
        fields: ['milestone_id', 'is_completed', 'created_at', 'closed_at'],
      });
    }

    case 'testmo_get_run': {
      const id = reqId(args.runId, 'runId');
      return text(fmtDetail(`Run ${id}`, unwrap(await testmoFetch(cfg, `/runs/${id}`))));
    }

    case 'testmo_list_run_results': {
      const id = reqId(args.runId, 'runId');
      const extra = [
        ...optFilter(args, 'statusId', 'status_id'),
        ...optFilter(args, 'createdBy', 'created_by'),
        ...optFilter(args, 'createdAfter', 'created_after'),
        ...optFilter(args, 'createdBefore', 'created_before'),
        ...optFilter(args, 'expands', 'expands'),
      ];
      const data = await testmoFetch(cfg, `/runs/${id}/results${query(args, extra)}`);
      const list = rows(data);
      if (!list.length) return text(`No results in run ${id} matching that filter.`);
      const lines = list
        .slice(0, MAX_RENDERED)
        .map((r: any) => {
          const note = r?.note ? `  “${clip(String(r.note), 120)}”` : '';
          return `• result ${r?.id ?? '?'}  test ${r?.test_id ?? '?'}  status ${r?.status_id ?? '?'}  ${r?.elapsed ?? '—'}  ${r?.created_at ?? '?'}${note}`;
        })
        .join('\n');
      return text(`Results in run ${id}${pageInfo(data)}:\n\n${lines}${truncNote(list.length)}\n\n${STATUS_NOTE}`);
    }

    case 'testmo_list_cases': {
      const id = reqId(args.projectId, 'projectId');
      const extra = [
        ...optFilter(args, 'folderId', 'folder_id'),
        ...optFilter(args, 'templateId', 'template_id'),
        ...optFilter(args, 'createdAfter', 'created_after'),
        ...optFilter(args, 'createdBefore', 'created_before'),
      ];
      return listTool(cfg, `/projects/${id}/cases`, args, {
        label: `Test cases in project ${id}`,
        empty: `No test cases in project ${id} matching that filter.`,
        fields: ['key', 'folder_id', 'state_id', 'status_id', 'template_id', 'has_automation'],
        extraQuery: extra,
      });
    }

    case 'testmo_list_folders': {
      const id = reqId(args.projectId, 'projectId');
      return listTool(cfg, `/projects/${id}/folders`, args, {
        label: `Case folders in project ${id}`,
        empty: `No folders in project ${id}.`,
        fields: ['parent_id'],
      });
    }

    case 'testmo_list_automation_runs': {
      const id = reqId(args.projectId, 'projectId');
      return listTool(cfg, `/projects/${id}/automation/runs`, args, {
        label: `Automation runs in project ${id}`,
        empty: `No automation runs in project ${id}.`,
        fields: ['source_id', 'milestone_id', 'is_completed', 'created_at'],
      });
    }

    case 'testmo_get_automation_run': {
      const id = reqId(args.runId, 'runId');
      return text(
        fmtDetail(`Automation run ${id}`, unwrap(await testmoFetch(cfg, `/automation/runs/${id}?expands=automation_sources,configs,users`))),
      );
    }

    case 'testmo_list_automation_sources': {
      const id = reqId(args.projectId, 'projectId');
      return listTool(cfg, `/projects/${id}/automation/sources`, args, {
        label: `Automation sources in project ${id}`,
        empty: `No automation sources in project ${id}.`,
        fields: ['created_at'],
      });
    }

    case 'testmo_list_sessions': {
      const id = reqId(args.projectId, 'projectId');
      return listTool(cfg, `/projects/${id}/sessions`, args, {
        label: `Exploratory sessions in project ${id}`,
        empty: `No sessions in project ${id}.`,
        fields: ['milestone_id', 'is_completed', 'created_at'],
      });
    }

    case 'testmo_list_users':
      return listTool(cfg, '/users', args, {
        label: 'Users',
        empty: 'No users visible to this token (this endpoint may need a site admin).',
        fields: ['email', 'is_active', 'is_admin'],
      });

    // ── writes (only reachable when allowWrites is on — see callTool) ──────────────────────────
    case 'testmo_create_cases': {
      const pid = reqId(args.projectId, 'projectId');
      const input = Array.isArray(args.cases) ? args.cases : [];
      if (!input.length) return text('Error: `cases` must be a non-empty array.', true);
      if (input.length > MAX_BULK) return text(`Error: at most ${MAX_BULK} cases per call (got ${input.length}).`, true);
      const cases = input.map((c: any, i: number) => {
        const name = String(c?.name ?? '').trim();
        if (!name) throw new TestmoError(`cases[${i}].name is required.`);
        return {
          name,
          ...pick(c ?? {}, [
            ['folderId', 'folder_id', 'number'],
            ['templateId', 'template_id', 'number'],
            ['stateId', 'state_id', 'number'],
            ['estimate', 'estimate', 'number'],
            ['tags', 'tags', 'strings'],
            ['issues', 'issues', 'numbers'],
            ['automationLinks', 'automation_links', 'numbers'],
          ]),
        };
      });
      const created = rows(await testmoFetch(cfg, `/projects/${pid}/cases`, 'POST', { cases }));
      const ids = created.map((c: any) => c?.id).filter((x: any) => x != null);
      return text(`Created ${cases.length} case(s) in project ${pid}.${ids.length ? ` New ids: ${ids.join(', ')}.` : ''}`);
    }

    case 'testmo_update_cases': {
      const pid = reqId(args.projectId, 'projectId');
      const ids = idList(args.ids, 'ids');
      const patch = pick(args, [
        ['name', 'name', 'string'],
        ['folderId', 'folder_id', 'number'],
        ['stateId', 'state_id', 'number'],
        ['statusId', 'status_id', 'number'],
        ['estimate', 'estimate', 'number'],
        ['tags', 'tags', 'strings'],
        ['issues', 'issues', 'numbers'],
        ['automationLinks', 'automation_links', 'numbers'],
      ]);
      if (!Object.keys(patch).length) return text('Error: pass at least one field to change.', true);
      await testmoFetch(cfg, `/projects/${pid}/cases`, 'PATCH', { ids, ...patch });
      return text(`Updated ${ids.length} case(s) in project ${pid} — set ${Object.keys(patch).join(', ')} on ids ${ids.join(', ')}.`);
    }

    case 'testmo_delete_cases': {
      const pid = reqId(args.projectId, 'projectId');
      const ids = idList(args.ids, 'ids');
      await testmoFetch(cfg, `/projects/${pid}/cases`, 'DELETE', { ids });
      return text(`Deleted ${ids.length} case(s) from project ${pid}: ${ids.join(', ')}.`);
    }

    case 'testmo_create_folders': {
      const pid = reqId(args.projectId, 'projectId');
      const input = Array.isArray(args.folders) ? args.folders : [];
      if (!input.length) return text('Error: `folders` must be a non-empty array.', true);
      if (input.length > MAX_BULK) return text(`Error: at most ${MAX_BULK} folders per call (got ${input.length}).`, true);
      const folders = input.map((f: any, i: number) => {
        const name = String(f?.name ?? '').trim();
        if (!name) throw new TestmoError(`folders[${i}].name is required.`);
        return {
          name,
          ...pick(f ?? {}, [
            ['parentId', 'parent_id', 'number'],
            ['docs', 'docs', 'string'],
            ['displayOrder', 'display_order', 'number'],
          ]),
        };
      });
      const created = rows(await testmoFetch(cfg, `/projects/${pid}/folders`, 'POST', { folders }));
      const ids = created.map((f: any) => f?.id).filter((x: any) => x != null);
      return text(`Created ${folders.length} folder(s) in project ${pid}.${ids.length ? ` New ids: ${ids.join(', ')}.` : ''}`);
    }

    case 'testmo_update_folders': {
      const pid = reqId(args.projectId, 'projectId');
      const ids = idList(args.ids, 'ids');
      const patch = pick(args, [
        ['name', 'name', 'string'],
        ['parentId', 'parent_id', 'number'],
        ['docs', 'docs', 'string'],
      ]);
      if (!Object.keys(patch).length) return text('Error: pass at least one field to change.', true);
      await testmoFetch(cfg, `/projects/${pid}/folders`, 'PATCH', { ids, ...patch });
      return text(`Updated ${ids.length} folder(s) in project ${pid} — set ${Object.keys(patch).join(', ')} on ids ${ids.join(', ')}.`);
    }

    case 'testmo_delete_folders': {
      const pid = reqId(args.projectId, 'projectId');
      const ids = idList(args.ids, 'ids');
      await testmoFetch(cfg, `/projects/${pid}/folders`, 'DELETE', { ids });
      return text(`Deleted ${ids.length} folder(s) from project ${pid}: ${ids.join(', ')}.`);
    }

    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

export function testmoPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: TESTMO_ID,
      name: 'Testmo',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Read your Testmo test-management instance over MCP via the REST API v1: projects, milestones, manual ' +
        'test runs and their per-test results (with failure notes), the test case repository and its folders, ' +
        'CI automation runs and sources, exploratory sessions and users. Ask "why did last night\'s regression ' +
        'run fail" or "which cases have no automation" without leaving the chat. Optionally (off by default) ' +
        'enable writes to create / update / delete repository cases and folders. Requires a Testmo API token: ' +
        'Testmo → your profile → API tokens.',
      author: 'Kravn',
      priority: 100,
      configSchema: {
        type: 'object',
        properties: {
          baseUrl: {
            type: 'string',
            title: 'Site URL',
            description: 'Your Testmo site, e.g. https://your-team.testmo.net (https only — no path, no trailing slash needed).',
          },
          apiToken: {
            type: 'string',
            title: 'API Token',
            description:
              'Testmo API token. Create it under your profile → API tokens, or ask an admin for a dedicated API ' +
              'user. The token\'s own permissions are the ceiling: the users/groups/roles endpoints need a site ' +
              'admin and return 403 otherwise. Stored encrypted, never shown to the model.',
            secret: true,
          },
          allowWrites: {
            type: 'boolean',
            title: 'Allow writes (create / update / delete)',
            description:
              'Off by default: only the read tools are exposed. Turn it on to also expose create/update/delete ' +
              'for repository CASES and FOLDERS — the only things the Testmo API can write (manual runs, ' +
              'milestones and results are read-only in the API). Writes are BULK: one call can change up to 100 ' +
              'rows, and deletes are permanent. Pair this with the maker-checker approval gate, and keep the ' +
              'token\'s Testmo permissions as the real ceiling.',
          },
        },
        required: ['baseUrl', 'apiToken'],
      },
    },
    server: {
      // Mutating tools are hidden entirely unless the instance opts in, so a model composed onto a
      // read-only Testmo endpoint never even sees that writing is possible.
      listTools: (config) => (config?.allowWrites === true ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS),
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const cfg = readConfig(config);
          // Belt and braces: listTools already hides these, but a client can call any name it likes.
          if (!cfg.allowWrites && WRITE_TOOLS.some((t) => t.name === name)) {
            return text(
              `${name} is a write tool and writes are disabled for this Testmo instance. An admin can enable ` +
                '"Allow writes" in the plugin config.',
              true,
            );
          }
          return await callTestmo(cfg, name, args);
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Testmo request failed.', true);
        }
      },
    },
  };
}
