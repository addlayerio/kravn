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

const TOOLS: McpToolDef[] = [
  {
    name: 'jira_search',
    description:
      'Search Jira issues with a JQL query (e.g. `project = ABC AND status = "In Progress" ORDER BY updated DESC`). ' +
      'Returns each matching issue key, summary, type, status and assignee.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: 'A JQL query string.' },
        maxResults: { type: 'number', description: 'Max issues to return (default 25, max 50).' },
      },
      required: ['jql'],
    },
  },
  {
    name: 'jira_get_issue',
    description: 'Get the full detail of a single Jira issue by key (e.g. ABC-123): summary, description, status, assignee, reporter, priority, dates.',
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

/** JQL search with a fallback: the enhanced Cloud endpoint first, then the classic one (Server/DC). */
async function searchIssues(cfg: AtlassianConfig, jql: string, maxResults: number): Promise<any[]> {
  try {
    const data = await atlassianFetch(cfg, 'POST', '/rest/api/3/search/jql', { jql, maxResults, fields: SEARCH_FIELDS });
    return data?.issues ?? [];
  } catch (err) {
    if (err instanceof AtlassianError && /HTTP 40[04]|Not found/.test(err.message)) {
      const data = await atlassianFetch(cfg, 'POST', '/rest/api/3/search', { jql, maxResults, fields: SEARCH_FIELDS });
      return data?.issues ?? [];
    }
    throw err;
  }
}

async function search(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const jql = String(args.jql ?? '').trim();
  if (!jql) return text('Error: jql is required.', true);
  const maxResults = Math.min(50, Math.max(1, Number(args.maxResults) || 25));
  const issues = await searchIssues(cfg, jql, maxResults);
  if (!issues.length) return text(`No issues matched: ${jql}`);
  const lines = issues.map((it: any) => {
    const f = it.fields ?? {};
    const status = f.status?.name ?? '—';
    const type = f.issuetype?.name ?? '—';
    const assignee = f.assignee?.displayName ?? 'Unassigned';
    return `• ${it.key}  [${type}/${status}]  ${f.summary ?? ''}  —  ${assignee}`;
  });
  return text(`${issues.length} issue(s) for \`${jql}\`:\n\n${lines.join('\n')}`);
}

async function getIssue(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const key = String(args.issueKey ?? '').trim();
  if (!key) return text('Error: issueKey is required.', true);
  const fields = 'summary,description,status,assignee,reporter,priority,issuetype,created,updated,labels';
  const it = await atlassianFetch(cfg, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`);
  const f = it.fields ?? {};
  const desc = adfToText(f.description).trim();
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
