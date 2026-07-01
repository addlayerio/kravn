import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native Jira plugin — talk to Jira over MCP via the Jira REST API.
 *
 * In-process (TypeScript) the way Kravn plugins work, rather than shelling out to an external MCP server.
 * Targets Jira Cloud (REST v3) and works with self-hosted Server/Data Center too. Auth is an API token +
 * account email (HTTP Basic) — the token is marked `secret: true` so PluginManager stores it encrypted and
 * masks it write-only. Config: the site base URL, the account email and the API token. Exposes search
 * (JQL) + read + create/comment/transition tools; composable into virtual servers like any other plugin.
 *
 * Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens.
 */
export const JIRA_ID = 'kravn-jira';

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

class JiraError extends Error {}

/**
 * Validate + normalize the site URL. HTTPS only, and block loopback / link-local / cloud-metadata hosts so
 * a stored API token can never be sent to those (SSRF hardening). Private LAN ranges are allowed because a
 * self-hosted Jira legitimately lives there; the base URL is admin-configured, not caller-supplied.
 */
function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new JiraError('Invalid Jira base URL. Use your site URL, e.g. https://your-team.atlassian.net');
  }
  if (u.protocol !== 'https:') throw new JiraError('Jira base URL must use https.');
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // Reject IPv6 literals outright: the WHATWG parser normalizes them to hex (so ::ffff:127.0.0.1 becomes
  // ::ffff:7f00:1), which makes per-form allowlisting brittle. Real Jira sites use a hostname; a single
  // "contains a colon" check closes ::1, IPv4-mapped loopback/metadata and every other IPv6 form.
  if (h.includes(':')) throw new JiraError('Jira base URL host is not allowed (use a hostname, not an IPv6 literal).');
  const blocked =
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '0.0.0.0' ||
    /^127\./.test(h) ||
    /^169\.254\./.test(h);
  if (blocked) throw new JiraError('Jira base URL host is not allowed.');
  return `${u.protocol}//${u.host}`; // drop any path/query/trailing slash
}

/** Bound error text so a hostile/huge server response can't inflate a returned message. */
function clip(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function readConfig(config: Record<string, unknown>): JiraConfig {
  const baseUrlRaw = String(config.baseUrl ?? '').trim();
  const email = String(config.email ?? '').trim();
  const apiToken = String(config.apiToken ?? '').trim();
  if (!baseUrlRaw || !email || !apiToken) {
    throw new JiraError(
      'Jira is not configured. Set the Site URL (e.g. https://your-team.atlassian.net), your account Email, ' +
        'and an API Token (create one at https://id.atlassian.com/manage-profile/security/api-tokens).',
    );
  }
  return { baseUrl: normalizeBaseUrl(baseUrlRaw), email, apiToken };
}

function authHeader(cfg: JiraConfig): string {
  return `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')}`;
}

const MAX_RESPONSE_BYTES = 10_000_000;

async function jira(cfg: JiraConfig, method: 'GET' | 'POST', path: string, jsonBody?: unknown): Promise<any> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      authorization: authHeader(cfg),
      accept: 'application/json',
      ...(jsonBody ? { 'content-type': 'application/json' } : {}),
    },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    redirect: 'error', // never follow a redirect with the token attached (anti-SSRF / anti-exfil)
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new JiraError('Jira rejected the credentials (401/403). Check the email + API token and the token’s permissions.');
  }
  if (res.status === 404) throw new JiraError('Not found (check the issue key, project or site URL).');
  if (Number(res.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) {
    throw new JiraError('Jira response is too large to process.');
  }
  const textBody = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: any = {};
  try {
    data = textBody ? JSON.parse(textBody) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const msg =
      data?.errorMessages?.join('; ') ||
      (data?.errors && Object.values(data.errors).join('; ')) ||
      data?.message ||
      `Jira HTTP ${res.status}`;
    throw new JiraError(clip(String(msg)));
  }
  return data;
}

/** Minimal Atlassian Document Format doc wrapping plain text (paragraphs split on blank lines / newlines). */
function toAdf(textValue: string): unknown {
  const paras = textValue.split(/\n/).map((line) => ({
    type: 'paragraph',
    content: line ? [{ type: 'text', text: line }] : [],
  }));
  return { type: 'doc', version: 1, content: paras.length ? paras : [{ type: 'paragraph', content: [] }] };
}

/** Flatten an ADF node (or a plain string, as Server/DC returns) back to readable text. */
function adfToText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text' && typeof n.text === 'string') return n.text;
  if (n.type === 'hardBreak') return '\n';
  const inner = Array.isArray(n.content) ? n.content.map(adfToText).join('') : '';
  if (n.type === 'paragraph' || n.type === 'heading') return `${inner}\n`;
  if (n.type === 'listItem') return `• ${inner}`;
  return inner;
}

function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}

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
async function searchIssues(cfg: JiraConfig, jql: string, maxResults: number): Promise<any[]> {
  try {
    const data = await jira(cfg, 'POST', '/rest/api/3/search/jql', { jql, maxResults, fields: SEARCH_FIELDS });
    return data?.issues ?? [];
  } catch (err) {
    // Older Jira (Server/Data Center) has no /search/jql — fall back to the classic search endpoint.
    if (err instanceof JiraError && /HTTP 40[04]|Not found/.test(err.message)) {
      const data = await jira(cfg, 'POST', '/rest/api/3/search', { jql, maxResults, fields: SEARCH_FIELDS });
      return data?.issues ?? [];
    }
    throw err;
  }
}

async function search(cfg: JiraConfig, args: Record<string, unknown>): Promise<McpToolResult> {
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

async function getIssue(cfg: JiraConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const key = String(args.issueKey ?? '').trim();
  if (!key) return text('Error: issueKey is required.', true);
  const fields = 'summary,description,status,assignee,reporter,priority,issuetype,created,updated,labels';
  const it = await jira(cfg, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`);
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

async function listProjects(cfg: JiraConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query ?? '').trim();
  let projects: any[] = [];
  try {
    const data = await jira(cfg, 'GET', `/rest/api/3/project/search?maxResults=50${q ? `&query=${encodeURIComponent(q)}` : ''}`);
    projects = data?.values ?? [];
  } catch {
    const data = await jira(cfg, 'GET', '/rest/api/3/project'); // Server/DC returns a plain array
    projects = Array.isArray(data) ? data : [];
    if (q) projects = projects.filter((p: any) => `${p.key} ${p.name}`.toLowerCase().includes(q.toLowerCase()));
  }
  if (!projects.length) return text('No projects found.');
  const lines = projects.map((p: any) => `• ${p.key}  —  ${p.name}`);
  return text(`Projects:\n\n${lines.join('\n')}`);
}

async function createIssue(cfg: JiraConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const projectKey = String(args.projectKey ?? '').trim();
  const issueType = String(args.issueType ?? '').trim();
  const summary = String(args.summary ?? '').trim();
  const description = String(args.description ?? '');
  if (!projectKey || !issueType || !summary) return text('Error: projectKey, issueType and summary are required.', true);
  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    issuetype: { name: issueType },
    summary,
  };
  if (description.trim()) fields.description = toAdf(description);
  const created = await jira(cfg, 'POST', '/rest/api/3/issue', { fields });
  const k = created?.key ?? '(unknown)';
  return text(`Created ${k}: ${cfg.baseUrl}/browse/${k}`);
}

async function addComment(cfg: JiraConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const key = String(args.issueKey ?? '').trim();
  const body = String(args.body ?? '');
  if (!key || !body.trim()) return text('Error: issueKey and body are required.', true);
  await jira(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: toAdf(body) });
  return text(`Comment added to ${key}: ${cfg.baseUrl}/browse/${key}`);
}

async function transitionIssue(cfg: JiraConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const key = String(args.issueKey ?? '').trim();
  const wanted = String(args.transition ?? '').trim();
  if (!key || !wanted) return text('Error: issueKey and transition are required.', true);
  const data = await jira(cfg, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  const transitions: any[] = data?.transitions ?? [];
  const match = transitions.find(
    (t) => t.name?.toLowerCase() === wanted.toLowerCase() || t.to?.name?.toLowerCase() === wanted.toLowerCase(),
  );
  if (!match) {
    const names = transitions.map((t) => t.name).filter(Boolean).join(', ') || '(none available)';
    return text(`No transition "${wanted}" for ${key}. Available: ${names}`, true);
  }
  await jira(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: match.id } });
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
          const cfg = readConfig(config);
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
