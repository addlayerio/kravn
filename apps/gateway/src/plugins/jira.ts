import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';
import {
  type AtlassianConfig,
  readAtlassianConfig,
  atlassianFetch,
  toolText as text,
  toAdf,
  adfToText,
  AtlassianError,
} from './atlassian.js';

/**
 * Native Jira plugin — talk to Jira over MCP via the Jira REST API.
 *
 * In-process (TypeScript) the way Kravn plugins work, rather than shelling out to an external MCP server.
 * Targets Jira Cloud (REST v3) and works with self-hosted Server/Data Center too. Auth is an API token +
 * account email (HTTP Basic) — the token is marked `secret: true` so PluginManager stores it encrypted and
 * masks it write-only. Shared Atlassian config/fetch/SSRF-guard live in ./atlassian.
 *
 * Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens.
 */
export const JIRA_ID = 'kravn-jira';

// ─── Tools ─────────────────────────────────────────────────────────────────────────────────────

const SEARCH_FIELDS = ['summary', 'status', 'assignee', 'issuetype', 'priority', 'updated'];
/** Jira's per-request page size ceiling; larger `maxResults` are assembled by paging. */
const PAGE_SIZE = 100;

const TOOLS: McpToolDef[] = [
  {
    name: 'jira_search',
    description:
      'Search Jira issues with a JQL query (e.g. `project = ABC AND status = "In Progress" ORDER BY updated DESC`). ' +
      'Returns each matching issue key, summary, type, status and assignee. ' +
      'By default only those base fields are shown — CUSTOM FIELDS (Story Points, Sprint, a select like "Módulo", ' +
      'a date like "Target UAT", etc.) are only included if you name them in `fields`. Paginates automatically ' +
      'up to `maxResults` (max 200).',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: 'A JQL query string.' },
        maxResults: { type: 'number', description: 'Max issues to return (default 25, max 200; assembled by paging).' },
        fields: {
          type: 'string',
          description:
            'Optional comma-separated EXTRA fields to include per issue, by display name or id — e.g. ' +
            '"Story Points Global, Sprint, Módulo, Target UAT" (or "customfield_10001"). Needed for any custom field. ' +
            'To see every field name an issue has, call jira_get_issue on one issue first.',
        },
      },
      required: ['jql'],
    },
  },
  {
    name: 'jira_get_issue',
    description:
      'Get the full detail of a single Jira issue by key (e.g. ABC-123): summary, description, status, assignee, ' +
      'reporter, priority, dates, AND every populated custom field (Story Points, Sprint, module, target dates, …), ' +
      'each labelled by its display name. Use this to discover which custom fields exist before naming them in jira_search.',
    inputSchema: {
      type: 'object',
      properties: { issueKey: { type: 'string', description: 'Issue key, e.g. ABC-123.' } },
      required: ['issueKey'],
    },
  },
  {
    name: 'jira_list_projects',
    description: 'List the Jira projects the account can see, with each project key and name.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional filter over project name/key.' } },
    },
  },
  {
    name: 'jira_create_issue',
    description: 'Create a Jira issue. Requires the project key, an issue type name (e.g. Task, Bug, Story) and a summary; description is optional.',
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'Project key, e.g. ABC.' },
        issueType: { type: 'string', description: 'Issue type name, e.g. Task, Bug, Story.' },
        summary: { type: 'string', description: 'Short title of the issue.' },
        description: { type: 'string', description: 'Optional longer description (plain text).' },
      },
      required: ['projectKey', 'issueType', 'summary'],
    },
  },
  {
    name: 'jira_add_comment',
    description: 'Add a comment to an existing Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: { type: 'string', description: 'Issue key, e.g. ABC-123.' },
        body: { type: 'string', description: 'The comment text (plain text).' },
      },
      required: ['issueKey', 'body'],
    },
  },
  {
    name: 'jira_transition_issue',
    description:
      'Move an issue to a new status by naming the target transition (e.g. "In Progress", "Done"). ' +
      'If the name does not match, the available transitions for that issue are listed.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: { type: 'string', description: 'Issue key, e.g. ABC-123.' },
        transition: { type: 'string', description: 'Target transition/status name, e.g. Done.' },
      },
      required: ['issueKey', 'transition'],
    },
  },
];

/** Flatten a Jira field value to a short human string. Custom fields come in many shapes (a number, a string,
 *  a {value} select, a {name} sprint/version, a {displayName} user, an array of any of those, or ADF rich text);
 *  return '' for anything empty so the caller can skip it. */
function fmtField(v: any): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(fmtField).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    if (typeof v.value === 'string') return v.value; // single/multi select (e.g. a "Módulo")
    if (typeof v.name === 'string') return v.name; // sprint, version, component, status
    if (typeof v.displayName === 'string') return v.displayName; // user
    if (typeof v.emailAddress === 'string') return v.emailAddress;
    if (v.type === 'doc' || v.content) { const t = adfToText(v).trim(); if (t) return t; } // ADF rich text
    const j = JSON.stringify(v);
    return j.length > 200 ? j.slice(0, 200) + '…' : j;
  }
  return String(v);
}

/** Resolve a caller-supplied field token (a display name OR an id) to the field id present on the issue. */
function resolveFieldId(token: string, fields: Record<string, any>, names: Record<string, string>): string | undefined {
  if (token in fields) return token; // already an id like customfield_10001 or a base key
  const lower = token.toLowerCase();
  for (const [id, nm] of Object.entries(names)) if (String(nm).toLowerCase() === lower) return id;
  return undefined;
}

/**
 * JQL search, paginated to `maxResults`. Tries the enhanced Cloud endpoint (`/search/jql`, cursor-paged) first
 * and falls back to the classic one (`/search`, offset-paged; Server/DC). Returns the issues plus the
 * fieldId → display-name map (from `expand=names`) so custom fields can be labelled.
 */
async function searchIssues(
  cfg: AtlassianConfig,
  jql: string,
  maxResults: number,
  reqFields: string[],
  withNames: boolean,
): Promise<{ issues: any[]; names: Record<string, string> }> {
  const issues: any[] = [];
  let names: Record<string, string> = {};
  const expand = withNames ? ['names'] : undefined;
  let classic = false;
  let cursor: string | undefined;
  let startAt = 0;

  // First page decides the endpoint: /search/jql, or fall back to classic /search on 400/404 (Server/DC).
  while (issues.length < maxResults) {
    const want = Math.min(PAGE_SIZE, maxResults - issues.length);
    let data: any;
    if (!classic) {
      try {
        const body: Record<string, unknown> = { jql, maxResults: want, fields: reqFields };
        if (expand) body.expand = expand;
        if (cursor) body.nextPageToken = cursor;
        data = await atlassianFetch(cfg, 'POST', '/rest/api/3/search/jql', body);
      } catch (err) {
        if (err instanceof AtlassianError && /HTTP 40[04]|Not found/.test(err.message) && issues.length === 0) {
          classic = true; // switch and retry this page below
        } else {
          throw err;
        }
      }
    }
    if (classic) {
      const body: Record<string, unknown> = { jql, maxResults: want, startAt, fields: reqFields };
      if (expand) body.expand = expand;
      data = await atlassianFetch(cfg, 'POST', '/rest/api/3/search', body);
    }
    const page: any[] = data?.issues ?? [];
    if (data?.names) names = { ...names, ...data.names };
    issues.push(...page);
    if (page.length === 0) break;
    if (!classic) {
      cursor = data?.nextPageToken;
      if (!cursor || data?.isLast) break;
    } else {
      startAt += page.length;
      const total = Number(data?.total ?? 0);
      if (page.length < want || (total && startAt >= total)) break;
    }
  }
  return { issues: issues.slice(0, maxResults), names };
}

async function search(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const jql = String(args.jql ?? '').trim();
  if (!jql) return text('Error: jql is required.', true);
  const maxResults = Math.min(200, Math.max(1, Number(args.maxResults) || 25));
  // Extra fields the caller asked for (by display name or id). Requesting any of them switches to `*all` +
  // `expand=names` so the value AND its label are available; otherwise we keep the lean base-field fetch.
  const extra = String(args.fields ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const { issues, names } = await searchIssues(cfg, jql, maxResults, extra.length ? ['*all'] : SEARCH_FIELDS, extra.length > 0);
  if (!issues.length) return text(`No issues matched: ${jql}`);
  const lines = issues.map((it: any) => {
    const f = it.fields ?? {};
    const status = f.status?.name ?? '—';
    const type = f.issuetype?.name ?? '—';
    const assignee = f.assignee?.displayName ?? 'Unassigned';
    let line = `• ${it.key}  [${type}/${status}]  ${f.summary ?? ''}  —  ${assignee}`;
    if (extra.length) {
      const cols = extra.map((name) => {
        const id = resolveFieldId(name, f, names);
        return `${name}: ${(id && fmtField(f[id])) || '—'}`;
      });
      line += `\n    ${cols.join('  |  ')}`;
    }
    return line;
  });
  return text(`${issues.length} issue(s) for \`${jql}\`:\n\n${lines.join('\n')}`);
}

async function getIssue(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const key = String(args.issueKey ?? '').trim();
  if (!key) return text('Error: issueKey is required.', true);
  // `*all` returns every field incl. custom ones; `expand=names` gives the fieldId → display-name map so a
  // customfield_10xxx can be shown as "Story Points Global".
  const it = await atlassianFetch(cfg, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=*all&expand=names`);
  const f = it.fields ?? {};
  const names: Record<string, string> = it.names ?? {};
  const desc = adfToText(f.description).trim();
  // Base fields we render with a fixed layout — excluded from the generic custom-field dump below.
  const BASE = new Set(['summary', 'description', 'status', 'assignee', 'reporter', 'priority', 'issuetype', 'created', 'updated', 'labels']);
  const custom = Object.keys(f)
    .filter((k) => !BASE.has(k))
    .map((k) => ({ label: names[k] || k, val: fmtField(f[k]) }))
    .filter((x) => x.val)
    .sort((a, b) => a.label.localeCompare(b.label));
  const out = [
    `# ${it.key} — ${f.summary ?? ''}`,
    `${cfg.baseUrl}/browse/${it.key}`,
    '',
    `Type:     ${f.issuetype?.name ?? '—'}`,
    `Status:   ${f.status?.name ?? '—'}`,
    `Priority: ${f.priority?.name ?? '—'}`,
    `Assignee: ${f.assignee?.displayName ?? 'Unassigned'}`,
    `Reporter: ${f.reporter?.displayName ?? '—'}`,
    ...(Array.isArray(f.labels) && f.labels.length ? [`Labels:   ${f.labels.join(', ')}`] : []),
    `Updated:  ${f.updated ?? '—'}`,
    ...(custom.length ? ['', '## Fields', ...custom.map((c) => `${c.label}: ${c.val}`)] : []),
    '',
    desc ? `## Description\n${desc}` : '(no description)',
  ];
  return text(out.join('\n'));
}

async function listProjects(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query ?? '').trim();
  let projects: any[] = [];
  try {
    const data = await atlassianFetch(cfg, 'GET', `/rest/api/3/project/search?maxResults=50${q ? `&query=${encodeURIComponent(q)}` : ''}`);
    projects = data?.values ?? [];
  } catch {
    const data = await atlassianFetch(cfg, 'GET', '/rest/api/3/project'); // Server/DC returns a plain array
    projects = Array.isArray(data) ? data : [];
    if (q) projects = projects.filter((p: any) => `${p.key} ${p.name}`.toLowerCase().includes(q.toLowerCase()));
  }
  if (!projects.length) return text('No projects found.');
  const lines = projects.map((p: any) => `• ${p.key}  —  ${p.name}`);
  return text(`Projects:\n\n${lines.join('\n')}`);
}

async function createIssue(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const projectKey = String(args.projectKey ?? '').trim();
  const issueType = String(args.issueType ?? '').trim();
  const summary = String(args.summary ?? '').trim();
  const description = String(args.description ?? '');
  if (!projectKey || !issueType || !summary) return text('Error: projectKey, issueType and summary are required.', true);
  const fields: Record<string, unknown> = { project: { key: projectKey }, issuetype: { name: issueType }, summary };
  if (description.trim()) fields.description = toAdf(description);
  const created = await atlassianFetch(cfg, 'POST', '/rest/api/3/issue', { fields });
  const k = created?.key ?? '(unknown)';
  return text(`Created ${k}: ${cfg.baseUrl}/browse/${k}`);
}

async function addComment(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const key = String(args.issueKey ?? '').trim();
  const body = String(args.body ?? '');
  if (!key || !body.trim()) return text('Error: issueKey and body are required.', true);
  await atlassianFetch(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: toAdf(body) });
  return text(`Comment added to ${key}: ${cfg.baseUrl}/browse/${key}`);
}

async function transitionIssue(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const key = String(args.issueKey ?? '').trim();
  const wanted = String(args.transition ?? '').trim();
  if (!key || !wanted) return text('Error: issueKey and transition are required.', true);
  const data = await atlassianFetch(cfg, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  const transitions: any[] = data?.transitions ?? [];
  const match = transitions.find(
    (t) => t.name?.toLowerCase() === wanted.toLowerCase() || t.to?.name?.toLowerCase() === wanted.toLowerCase(),
  );
  if (!match) {
    const names = transitions.map((t) => t.name).filter(Boolean).join(', ') || '(none available)';
    return text(`No transition "${wanted}" for ${key}. Available: ${names}`, true);
  }
  await atlassianFetch(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: match.id } });
  return text(`${key} transitioned via "${match.name}".`);
}

export function jiraPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: JIRA_ID,
      name: 'Jira',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Interact with Jira over MCP via the Jira REST API. Search issues with JQL, read issue detail, list ' +
        'projects, and create issues / add comments / transition status. Requires a site URL, account email and API token.',
      author: 'Kravn',
      priority: 100,
      configSchema: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string', title: 'Site URL', description: 'Your Jira site, e.g. https://your-team.atlassian.net' },
          email: { type: 'string', title: 'Account Email', description: 'The Atlassian account email the API token belongs to.' },
          apiToken: {
            type: 'string',
            title: 'API Token',
            description: 'Atlassian API token (id.atlassian.com → Security → API tokens).',
            secret: true,
          },
        },
        required: ['baseUrl', 'email', 'apiToken'],
      },
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const cfg = readAtlassianConfig(config, 'Jira');
          switch (name) {
            case 'jira_search':
              return await search(cfg, args);
            case 'jira_get_issue':
              return await getIssue(cfg, args);
            case 'jira_list_projects':
              return await listProjects(cfg, args);
            case 'jira_create_issue':
              return await createIssue(cfg, args);
            case 'jira_add_comment':
              return await addComment(cfg, args);
            case 'jira_transition_issue':
              return await transitionIssue(cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Jira request failed.', true);
        }
      },
    },
  };
}
