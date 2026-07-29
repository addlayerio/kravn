import type { McpToolResult, McpToolDef } from '@kravn/plugin-sdk';
import { type AtlassianConfig, atlassianFetch, toolText as text, toAdf, AtlassianError } from './atlassian.js';

/**
 * Jira Service Management (JSM) tools for the native Jira plugin.
 *
 * The base Jira plugin only speaks the platform REST API (`/rest/api/3`), which surfaces Jira Software/Core
 * issues and projects but NOT the Service Management layer. JSM has its own API under `/rest/servicedeskapi`:
 * service desks, request types, queues, customer *requests*, SLAs and organizations. These tools live here and
 * are merged into the same `kravn-jira` plugin, so they reuse the SAME config (site URL + email + API token) —
 * nothing extra to configure.
 *
 * PERMISSIONS: `servicedeskapi` requires the API-token account to be a licensed **agent** (or admin) on the
 * service desk. A Jira-Software-only account gets 403 — callJsm annotates that so the cause is obvious.
 *
 * Docs: https://developer.atlassian.com/cloud/jira/service-desk/rest/
 */

const JSM = '/rest/servicedeskapi';
// The queue endpoints are marked experimental and require this opt-in header; harmless on the stable ones.
const EXPERIMENTAL = { 'X-ExperimentalApi': 'opt-in' };

async function jsmGet(cfg: AtlassianConfig, path: string): Promise<any> {
  return atlassianFetch(cfg, 'GET', `${JSM}${path}`, undefined, EXPERIMENTAL);
}
async function jsmPost(cfg: AtlassianConfig, path: string, body: unknown): Promise<any> {
  return atlassianFetch(cfg, 'POST', `${JSM}${path}`, body, EXPERIMENTAL);
}

/** Page a JSM `{ values, isLastPage, size }` collection with `start`/`limit` up to `want` rows. */
async function jsmPage(cfg: AtlassianConfig, path: string, want: number): Promise<any[]> {
  const out: any[] = [];
  let start = 0;
  while (out.length < want) {
    const sep = path.includes('?') ? '&' : '?';
    const limit = Math.min(50, want - out.length);
    const data = await jsmGet(cfg, `${path}${sep}start=${start}&limit=${limit}`);
    const vals: any[] = Array.isArray(data?.values) ? data.values : [];
    out.push(...vals);
    if (data?.isLastPage || vals.length === 0) break;
    start += vals.length;
  }
  return out.slice(0, want);
}

/** Pull the summary out of a request's `requestFieldValues` array (JSM doesn't return a top-level summary). */
function reqSummary(r: any): string {
  const rfv: any[] = Array.isArray(r?.requestFieldValues) ? r.requestFieldValues : [];
  const s = rfv.find((f) => f?.fieldId === 'summary');
  return s?.value ? String(s.value) : '';
}
function num(v: unknown, def: number, max: number): number {
  return Math.min(max, Math.max(1, Math.trunc(Number(v)) || def));
}

// ─── Tools ─────────────────────────────────────────────────────────────────────────────────────

export const JSM_TOOLS: McpToolDef[] = [
  {
    name: 'jsm_list_service_desks',
    description:
      'List the Jira Service Management service desks the account can see, each with its numeric service-desk id ' +
      'and the underlying project key/name. Start here: most other JSM tools need the serviceDeskId from this list.',
    inputSchema: {
      type: 'object',
      properties: { maxResults: { type: 'number', description: 'Service desks to return (default 50, max 100).' } },
    },
  },
  {
    name: 'jsm_list_request_types',
    description:
      'List the request types (the "what can I ask for" catalog — e.g. "Get IT help", "New access") of a service ' +
      'desk, with each request type id and name. Needed to create a request with jsm_create_request.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: { type: 'string', description: 'Numeric service-desk id (from jsm_list_service_desks).' },
        maxResults: { type: 'number', description: 'Request types to return (default 50, max 100).' },
      },
      required: ['serviceDeskId'],
    },
  },
  {
    name: 'jsm_list_requests',
    description:
      'List Service Management customer requests (tickets), the main way to see JSM work. Filter by service desk, ' +
      'status and ownership. To see ALL requests across a desk as an agent, pass requestOwnership="ALL_REQUESTS" ' +
      '(requires agent access). Each row: key, status, summary, reporter and created date.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: { type: 'string', description: 'Optional: limit to one service desk (numeric id).' },
        requestTypeId: { type: 'string', description: 'Optional: limit to one request type id.' },
        requestStatus: {
          type: 'string',
          enum: ['OPEN_REQUESTS', 'CLOSED_REQUESTS', 'ALL_REQUESTS'],
          description: 'Open, closed or all (default ALL_REQUESTS).',
        },
        requestOwnership: {
          type: 'string',
          enum: ['OWNED_REQUESTS', 'PARTICIPATED_REQUESTS', 'ORGANIZATION', 'ALL_REQUESTS'],
          description: 'Whose requests. ALL_REQUESTS = every request on the desk (agent-only). Default ALL_REQUESTS.',
        },
        searchTerm: { type: 'string', description: 'Optional free-text search over summary.' },
        maxResults: { type: 'number', description: 'Requests to return (default 25, max 100).' },
      },
    },
  },
  {
    name: 'jsm_get_request',
    description:
      'Get the full detail of one Service Management request by key (e.g. SUP-123): summary, current status, ' +
      'request type, service desk, reporter, created date and all populated request field values.',
    inputSchema: {
      type: 'object',
      properties: { issueKey: { type: 'string', description: 'Request/issue key, e.g. SUP-123.' } },
      required: ['issueKey'],
    },
  },
  {
    name: 'jsm_get_request_sla',
    description:
      'Get the SLA status of a request (e.g. Time to first response, Time to resolution): for each SLA whether it ' +
      'is breached, the remaining/elapsed time, and the goal. Use this for support KPI/SLA reporting.',
    inputSchema: {
      type: 'object',
      properties: { issueKey: { type: 'string', description: 'Request/issue key, e.g. SUP-123.' } },
      required: ['issueKey'],
    },
  },
  {
    name: 'jsm_list_queues',
    description:
      'List the agent queues of a service desk with each queue id, name and current issue count. Queues are the ' +
      'agent work views (e.g. "Unassigned", "Waiting for support"). Use jsm_get_queue_issues to see what is in one.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: { type: 'string', description: 'Numeric service-desk id (from jsm_list_service_desks).' },
        maxResults: { type: 'number', description: 'Queues to return (default 50, max 100).' },
      },
      required: ['serviceDeskId'],
    },
  },
  {
    name: 'jsm_get_queue_issues',
    description: 'List the issues currently in a specific agent queue of a service desk (key, summary, status).',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: { type: 'string', description: 'Numeric service-desk id.' },
        queueId: { type: 'string', description: 'Numeric queue id (from jsm_list_queues).' },
        maxResults: { type: 'number', description: 'Issues to return (default 50, max 100).' },
      },
      required: ['serviceDeskId', 'queueId'],
    },
  },
  {
    name: 'jsm_list_organizations',
    description:
      'List the Service Management organizations (groups of customers), each with its id and name. Optionally ' +
      'scope to one service desk. Useful to see which customer organizations exist for routing/reporting.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: { type: 'string', description: 'Optional: only organizations linked to this service desk (numeric id).' },
        maxResults: { type: 'number', description: 'Organizations to return (default 50, max 100).' },
      },
    },
  },
  {
    name: 'jsm_create_request',
    description:
      'Raise a Service Management customer request. Needs the numeric serviceDeskId and requestTypeId (from ' +
      'jsm_list_service_desks / jsm_list_request_types), a summary, and optionally a description. ' +
      'Optionally raise it on behalf of another customer by email with raiseOnBehalfOf.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: { type: 'string', description: 'Numeric service-desk id.' },
        requestTypeId: { type: 'string', description: 'Numeric request-type id.' },
        summary: { type: 'string', description: 'Short title of the request.' },
        description: { type: 'string', description: 'Optional longer description (plain text).' },
        raiseOnBehalfOf: { type: 'string', description: 'Optional customer email to raise the request on behalf of.' },
      },
      required: ['serviceDeskId', 'requestTypeId', 'summary'],
    },
  },
  {
    name: 'jsm_add_request_comment',
    description:
      'Add a comment to a Service Management request. Set public=false for an internal (agent-only) note; ' +
      'public=true (default) is visible to the customer.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: { type: 'string', description: 'Request/issue key, e.g. SUP-123.' },
        body: { type: 'string', description: 'The comment text (plain text).' },
        public: { type: 'boolean', description: 'true = customer-visible (default), false = internal note.' },
      },
      required: ['issueKey', 'body'],
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────────────────────────────────

async function listServiceDesks(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const want = num(args.maxResults, 50, 100);
  const rows = await jsmPage(cfg, '/servicedesk', want);
  if (!rows.length) return text('No service desks visible to this account (is it a JSM agent?).');
  const lines = rows.map((sd: any) => `• [${sd.id}] ${sd.projectKey ?? '?'} — ${sd.projectName ?? ''}`);
  return text(`Service desks:\n\n${lines.join('\n')}`);
}

async function listRequestTypes(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const sd = String(args.serviceDeskId ?? '').trim();
  if (!sd) return text('Error: serviceDeskId is required.', true);
  const want = num(args.maxResults, 50, 100);
  const rows = await jsmPage(cfg, `/servicedesk/${encodeURIComponent(sd)}/requesttype`, want);
  if (!rows.length) return text(`No request types for service desk ${sd}.`);
  const lines = rows.map((rt: any) => `• [${rt.id}] ${rt.name ?? ''}${rt.description ? ` — ${rt.description}` : ''}`);
  return text(`Request types for service desk ${sd}:\n\n${lines.join('\n')}`);
}

async function listRequests(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const want = num(args.maxResults, 25, 100);
  const qs = new URLSearchParams();
  if (args.serviceDeskId) qs.set('serviceDeskId', String(args.serviceDeskId));
  if (args.requestTypeId) qs.set('requestTypeId', String(args.requestTypeId));
  qs.set('requestStatus', String(args.requestStatus ?? 'ALL_REQUESTS'));
  qs.set('requestOwnership', String(args.requestOwnership ?? 'ALL_REQUESTS'));
  if (args.searchTerm) qs.set('searchTerm', String(args.searchTerm));
  qs.set('expand', 'status'); // otherwise currentStatus is omitted from the list rows
  const rows = await jsmPage(cfg, `/request?${qs.toString()}`, want);
  if (!rows.length) return text('No requests matched.');
  const lines = rows.map((r: any) => {
    const status = r?.currentStatus?.status ?? '—';
    const who = r?.reporter?.displayName ?? r?.reporter?.emailAddress ?? '—';
    const when = r?.createdDate?.friendly ?? r?.createdDate?.jira ?? '';
    return `• ${r.issueKey}  [${status}]  ${reqSummary(r) || ''}  —  ${who}${when ? `  (${when})` : ''}`;
  });
  return text(`${rows.length} request(s):\n\n${lines.join('\n')}`);
}

async function getRequest(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const key = String(args.issueKey ?? '').trim();
  if (!key) return text('Error: issueKey is required.', true);
  const r = await jsmGet(cfg, `/request/${encodeURIComponent(key)}?expand=requestType,serviceDesk,status`);
  const status = r?.currentStatus?.status ?? '—';
  const rfv: any[] = Array.isArray(r?.requestFieldValues) ? r.requestFieldValues : [];
  const fields = rfv
    .filter((f) => f?.fieldId !== 'summary' && f?.value)
    .map((f) => `${f.label ?? f.fieldId}: ${typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}`);
  const web = r?._links?.web ?? `${cfg.baseUrl}/browse/${r?.issueKey ?? key}`;
  const out = [
    `# ${r?.issueKey ?? key} — ${reqSummary(r) || ''}`,
    web,
    '',
    `Status:       ${status}`,
    `Request type: ${r?.requestType?.name ?? '—'}`,
    `Service desk: ${r?.serviceDesk?.projectName ?? r?.serviceDesk?.projectKey ?? '—'}`,
    `Reporter:     ${r?.reporter?.displayName ?? r?.reporter?.emailAddress ?? '—'}`,
    `Created:      ${r?.createdDate?.friendly ?? r?.createdDate?.jira ?? '—'}`,
    ...(fields.length ? ['', '## Fields', ...fields] : []),
  ];
  return text(out.join('\n'));
}

async function getRequestSla(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const key = String(args.issueKey ?? '').trim();
  if (!key) return text('Error: issueKey is required.', true);
  const data = await jsmGet(cfg, `/request/${encodeURIComponent(key)}/sla`);
  const rows: any[] = Array.isArray(data?.values) ? data.values : [];
  if (!rows.length) return text(`${key} has no SLAs.`);
  const lines = rows.map((s: any) => {
    const cyc = s?.ongoingCycle ?? (Array.isArray(s?.completedCycles) ? s.completedCycles[s.completedCycles.length - 1] : undefined);
    const breached = cyc?.breached ? 'BREACHED' : 'on track';
    const remaining = cyc?.remainingTime?.friendly ? `, ${cyc.remainingTime.friendly} remaining` : '';
    const goal = cyc?.goalDuration?.friendly ? `, goal ${cyc.goalDuration.friendly}` : '';
    const state = s?.ongoingCycle ? 'ongoing' : 'completed';
    return `• ${s?.name ?? 'SLA'} — ${breached} (${state}${remaining}${goal})`;
  });
  return text(`SLAs for ${key}:\n\n${lines.join('\n')}`);
}

async function listQueues(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const sd = String(args.serviceDeskId ?? '').trim();
  if (!sd) return text('Error: serviceDeskId is required.', true);
  const want = num(args.maxResults, 50, 100);
  const rows = await jsmPage(cfg, `/servicedesk/${encodeURIComponent(sd)}/queue?includeCount=true`, want);
  if (!rows.length) return text(`No queues for service desk ${sd}.`);
  const lines = rows.map((q: any) => `• [${q.id}] ${q.name ?? ''} — ${q.issueCount ?? 0} issue(s)`);
  return text(`Queues for service desk ${sd}:\n\n${lines.join('\n')}`);
}

async function getQueueIssues(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const sd = String(args.serviceDeskId ?? '').trim();
  const q = String(args.queueId ?? '').trim();
  if (!sd || !q) return text('Error: serviceDeskId and queueId are required.', true);
  const want = num(args.maxResults, 50, 100);
  const rows = await jsmPage(cfg, `/servicedesk/${encodeURIComponent(sd)}/queue/${encodeURIComponent(q)}/issue`, want);
  if (!rows.length) return text(`Queue ${q} is empty.`);
  const lines = rows.map((it: any) => {
    const f = it?.fields ?? {};
    return `• ${it.key}  ${f.summary ?? ''}  [${f.status?.name ?? '—'}]`;
  });
  return text(`${rows.length} issue(s) in queue ${q}:\n\n${lines.join('\n')}`);
}

async function listOrganizations(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const sd = String(args.serviceDeskId ?? '').trim();
  const want = num(args.maxResults, 50, 100);
  const path = sd ? `/servicedesk/${encodeURIComponent(sd)}/organization` : '/organization';
  const rows = await jsmPage(cfg, path, want);
  if (!rows.length) return text('No organizations found.');
  const lines = rows.map((o: any) => `• [${o.id}] ${o.name ?? ''}`);
  return text(`Organizations${sd ? ` for service desk ${sd}` : ''}:\n\n${lines.join('\n')}`);
}

async function createRequest(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const serviceDeskId = String(args.serviceDeskId ?? '').trim();
  const requestTypeId = String(args.requestTypeId ?? '').trim();
  const summary = String(args.summary ?? '').trim();
  const description = String(args.description ?? '');
  const onBehalf = String(args.raiseOnBehalfOf ?? '').trim();
  if (!serviceDeskId || !requestTypeId || !summary) {
    return text('Error: serviceDeskId, requestTypeId and summary are required.', true);
  }
  const requestFieldValues: Record<string, unknown> = { summary };
  if (description.trim()) requestFieldValues.description = description; // JSM accepts plain text here
  const body: Record<string, unknown> = { serviceDeskId, requestTypeId, requestFieldValues };
  if (onBehalf) body.raiseOnBehalfOf = onBehalf;
  const created = await jsmPost(cfg, '/request', body);
  const key = created?.issueKey ?? '(unknown)';
  const web = created?._links?.web ?? `${cfg.baseUrl}/browse/${key}`;
  return text(`Created request ${key}: ${web}`);
}

async function addRequestComment(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const key = String(args.issueKey ?? '').trim();
  const body = String(args.body ?? '');
  if (!key || !body.trim()) return text('Error: issueKey and body are required.', true);
  const isPublic = args.public === undefined ? true : Boolean(args.public);
  await jsmPost(cfg, `/request/${encodeURIComponent(key)}/comment`, { body, public: isPublic });
  return text(`${isPublic ? 'Public' : 'Internal'} comment added to ${key}.`);
}

/**
 * Dispatch a `jsm_*` tool. Returns null when `name` is not a JSM tool (so the caller falls through to the base
 * Jira switch). A 401/403 from servicedeskapi almost always means "not a JSM agent" — annotate it so the cause
 * is obvious instead of a bare credentials error.
 */
export async function callJsm(cfg: AtlassianConfig, name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
  try {
    switch (name) {
      case 'jsm_list_service_desks':
        return await listServiceDesks(cfg, args);
      case 'jsm_list_request_types':
        return await listRequestTypes(cfg, args);
      case 'jsm_list_requests':
        return await listRequests(cfg, args);
      case 'jsm_get_request':
        return await getRequest(cfg, args);
      case 'jsm_get_request_sla':
        return await getRequestSla(cfg, args);
      case 'jsm_list_queues':
        return await listQueues(cfg, args);
      case 'jsm_get_queue_issues':
        return await getQueueIssues(cfg, args);
      case 'jsm_list_organizations':
        return await listOrganizations(cfg, args);
      case 'jsm_create_request':
        return await createRequest(cfg, args);
      case 'jsm_add_request_comment':
        return await addRequestComment(cfg, args);
      default:
        return null;
    }
  } catch (err) {
    if (err instanceof AtlassianError && /401\/403|rejected the credentials/.test(err.message)) {
      return text(
        `${err.message}\n\nFor Jira Service Management, the API-token account must be a licensed AGENT (or admin) ` +
          'on the service desk — a Jira-Software-only account is rejected here. Add it as an Agent under the JSM ' +
          "project's People/Agents settings and retry.",
        true,
      );
    }
    return text(err instanceof Error ? err.message : 'JSM request failed.', true);
  }
}
