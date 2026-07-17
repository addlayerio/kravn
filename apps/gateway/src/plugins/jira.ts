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
      'Pass `fields` to return exactly the columns you need per issue — base OR custom fields — e.g. ' +
      '`["assignee","status","Story Points Global","Sprint","Team","Fecha Target UAT"]`. Without `fields` you get ' +
      'the default key/type/status/summary/assignee line. CUSTOM FIELDS (Story Points, Sprint, a "Módulo" select, ' +
      'a "Target UAT" date, …) appear ONLY when named in `fields`. Paginates automatically up to `maxResults` ' +
      '(max 200) in one call; use `startAt` to window into a larger result set. This is the efficient way to pull ' +
      'many issues for a report — one call, no descriptions, columns only.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: 'A JQL query string.' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Columns to return per issue, by display name or id — base fields ("assignee","status","summary") and ' +
            'custom fields ("Story Points Global","Sprint","Módulo","Fecha Target UAT", or "customfield_10001") alike. ' +
            'To discover a custom field\'s exact name, run jira_get_issue on one issue first.',
        },
        maxResults: { type: 'number', description: 'Issues to return in this call (default 25, max 200; assembled by paging).' },
        startAt: { type: 'number', description: 'Offset into the result set (default 0) — for windowing past `maxResults` in a large set.' },
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
    name: 'jira_get_comments',
    description:
      'Read the comment thread of a Jira issue — each comment with its author, date and text, oldest first. ' +
      'Paginates: use `startAt`/`maxResults` to window into issues with many comments. jira_get_issue returns the ' +
      'issue detail but NOT the discussion; use this to catch up on what was said on a ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: { type: 'string', description: 'Issue key, e.g. ABC-123.' },
        maxResults: { type: 'number', description: 'Comments to return in this call (default 20, max 100).' },
        startAt: { type: 'number', description: 'Offset into the comment list (default 0) — for windowing past `maxResults`.' },
      },
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

/**
 * Fetch the field catalog once and resolve caller-supplied column tokens (display NAMES or ids) to Jira field
 * ids. Resolving up front lets the search request exactly those fields — no `*all`, no `expand` (both of which
 * the enhanced `/search/jql` endpoint rejects with "Invalid request payload"). Returns, per requested token,
 * the id to fetch (or undefined if the name didn't match any field). Case-insensitive name match.
 */
async function resolveColumns(cfg: AtlassianConfig, cols: string[]): Promise<{ label: string; id: string | undefined }[]> {
  const list: any[] = await atlassianFetch(cfg, 'GET', '/rest/api/3/field');
  const byName = new Map<string, string>();
  for (const fld of Array.isArray(list) ? list : []) {
    if (!fld?.id) continue;
    byName.set(String(fld.id).toLowerCase(), fld.id); // allow requesting by id
    if (fld.name) byName.set(String(fld.name).toLowerCase(), fld.id);
  }
  return cols.map((label) => ({ label, id: byName.get(label.toLowerCase()) }));
}

/**
 * JQL search. Tries the enhanced Cloud endpoint (`/search/jql`, cursor-paged) first and falls back to the
 * classic one (`/search`, offset-paged; Server/DC). Pages internally until it has collected `startAt + count`
 * issues, then returns the window `[startAt, startAt+count)` — so a single call assembles up to `count` issues
 * regardless of Jira's 100/page ceiling. Requests exactly `reqFields` (specific ids) — no `*all`, no `expand`.
 */
async function searchIssues(cfg: AtlassianConfig, jql: string, startAt: number, count: number, reqFields: string[]): Promise<any[]> {
  const target = startAt + count; // how many we must collect from the top before slicing the window
  const issues: any[] = [];
  let classic = false;
  let cursor: string | undefined;
  let offset = 0;

  // First page decides the endpoint: /search/jql, or fall back to classic /search on 400/404 (Server/DC).
  while (issues.length < target) {
    const want = Math.min(PAGE_SIZE, target - issues.length);
    let data: any;
    if (!classic) {
      try {
        const body: Record<string, unknown> = { jql, maxResults: want, fields: reqFields };
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
      data = await atlassianFetch(cfg, 'POST', '/rest/api/3/search', { jql, maxResults: want, startAt: offset, fields: reqFields });
    }
    const page: any[] = data?.issues ?? [];
    issues.push(...page);
    if (page.length === 0) break;
    if (!classic) {
      cursor = data?.nextPageToken;
      if (!cursor || data?.isLast) break;
    } else {
      offset += page.length;
      const total = Number(data?.total ?? 0);
      if (page.length < want || (total && offset >= total)) break;
    }
  }
  return issues.slice(startAt, startAt + count);
}

async function search(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const jql = String(args.jql ?? '').trim();
  if (!jql) return text('Error: jql is required.', true);
  const maxResults = Math.min(200, Math.max(1, Number(args.maxResults) || 25));
  const startAt = Math.max(0, Number(args.startAt) || 0);
  // `fields` = the exact columns to return, base or custom, as an array (preferred) or a comma string.
  const raw = args.fields;
  const cols: string[] = Array.isArray(raw)
    ? raw.map((s) => String(s).trim()).filter(Boolean)
    : String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  // Resolve the requested columns to field ids up front, then ask Jira for exactly those (base fields resolve
  // to themselves; a "Story Points Global" resolves to customfield_10xxx). No `*all`/`expand` → valid payload.
  const resolved = cols.length ? await resolveColumns(cfg, cols) : [];
  const reqFields = cols.length ? [...new Set(resolved.map((c) => c.id).filter((x): x is string => !!x))] : SEARCH_FIELDS;
  const missing = resolved.filter((c) => !c.id).map((c) => c.label);

  const issues = await searchIssues(cfg, jql, startAt, maxResults, reqFields.length ? reqFields : SEARCH_FIELDS);
  if (!issues.length) return text(startAt > 0 ? `No more issues past offset ${startAt} for: ${jql}` : `No issues matched: ${jql}`);
  const lines = issues.map((it: any) => {
    const f = it.fields ?? {};
    if (cols.length) {
      // Table row: the key + exactly the requested columns (by their resolved id).
      const vals = resolved.map((c) => `${c.label}: ${(c.id && fmtField(f[c.id])) || '—'}`);
      return `• ${it.key}  ${vals.join('  |  ')}`;
    }
    const status = f.status?.name ?? '—';
    const type = f.issuetype?.name ?? '—';
    const assignee = f.assignee?.displayName ?? 'Unassigned';
    return `• ${it.key}  [${type}/${status}]  ${f.summary ?? ''}  —  ${assignee}`;
  });
  const window = startAt > 0 ? ` (from offset ${startAt})` : '';
  const note = missing.length ? `\n\n(no field matched: ${missing.join(', ')} — run jira_get_issue on one issue to see exact names)` : '';
  return text(`${issues.length} issue(s) for \`${jql}\`${window}:\n\n${lines.join('\n')}${note}`);
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
  const BASE = new Set(['summary', 'description', 'status', 'assignee', 'reporter', 'priority', 'issuetype', 'created', 'updated', 'labels', 'comment']);
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
    ...(f.comment?.total ? [`Comments: ${f.comment.total} — read with jira_get_comments`] : []),
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

async function getComments(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const key = String(args.issueKey ?? '').trim();
  if (!key) return text('Error: issueKey is required.', true);
  const startAt = Math.max(0, Math.trunc(Number(args.startAt ?? 0)) || 0);
  const maxResults = Math.min(100, Math.max(1, Math.trunc(Number(args.maxResults ?? 20)) || 20));
  // `orderBy=created` = oldest first, so the thread reads top-to-bottom chronologically.
  const data = await atlassianFetch(
    cfg,
    'GET',
    `/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=${maxResults}&orderBy=created`,
  );
  const comments: any[] = Array.isArray(data?.comments) ? data.comments : [];
  const total = Number(data?.total ?? comments.length);
  if (!comments.length) return text(`${key} has no comments${startAt ? ` past offset ${startAt}` : ''}.`);
  const blocks = comments.map((c) => {
    const who = c.author?.displayName ?? c.author?.emailAddress ?? 'Unknown';
    const edited = c.updated && c.updated !== c.created ? ' (edited)' : '';
    const bodyText = adfToText(c.body).trim() || '(empty)';
    return `── ${who} · ${c.created ?? ''}${edited}\n${bodyText}`;
  });
  const shownEnd = startAt + comments.length;
  const more = shownEnd < total ? `\n\n…${total - shownEnd} more — call again with startAt=${shownEnd}.` : '';
  const header = `# Comments on ${key} — showing ${startAt + 1}–${shownEnd} of ${total}`;
  return text([header, `${cfg.baseUrl}/browse/${key}`, '', blocks.join('\n\n')].join('\n') + more);
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
        'Interact with Jira over MCP via the Jira REST API. Search issues with JQL, read issue detail and the ' +
        'comment thread, list projects, and create issues / add comments / transition status. Requires a site URL, ' +
        'account email and API token.',
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
            case 'jira_get_comments':
              return await getComments(cfg, args);
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
