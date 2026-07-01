import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';
import {
  type AtlassianConfig,
  readAtlassianConfig,
  atlassianFetch,
  toolText as text,
  storageToText,
  escapeHtml,
  clip,
} from './atlassian.js';

/**
 * Native Confluence plugin — talk to Confluence over MCP via the Confluence Cloud REST API.
 *
 * Same Atlassian account + API token as the Jira plugin (HTTP Basic; the token is `secret: true` so it's
 * stored encrypted and masked write-only). Shared config/fetch/SSRF-guard live in ./atlassian. Confluence
 * lives under `/wiki/rest/api` on the same site. Page bodies use the "storage" (XHTML) format, which is
 * converted to/from plain text here.
 */
export const CONFLUENCE_ID = 'kravn-confluence';

const API = '/wiki/rest/api';

function pageUrl(cfg: AtlassianConfig, webui?: string, id?: string): string {
  if (webui) return `${cfg.baseUrl}/wiki${webui}`;
  return id ? `${cfg.baseUrl}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(id)}` : cfg.baseUrl;
}

const TOOLS: McpToolDef[] = [
  {
    name: 'confluence_search',
    description:
      'Search Confluence with CQL (Confluence Query Language), e.g. `text ~ "roadmap"` or ' +
      '`space = DEV AND type = page ORDER BY lastmodified DESC`. Returns each hit title, type, space and id.',
    inputSchema: {
      type: 'object',
      properties: {
        cql: { type: 'string', description: 'A CQL query string.' },
        limit: { type: 'number', description: 'Max results (default 25, max 50).' },
      },
      required: ['cql'],
    },
  },
  {
    name: 'confluence_get_page',
    description: 'Read a Confluence page by id: title, space, version and the full body as plain text.',
    inputSchema: {
      type: 'object',
      properties: { pageId: { type: 'string', description: 'Confluence content/page id (from search).' } },
      required: ['pageId'],
    },
  },
  {
    name: 'confluence_list_spaces',
    description: 'List the Confluence spaces the account can see, with each space key and name.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional filter over space name/key.' } },
    },
  },
  {
    name: 'confluence_create_page',
    description:
      'Create a Confluence page in a space. Requires the space key, a title and the body (plain text; it is ' +
      'stored as a paragraph). Optionally nest it under a parent page.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceKey: { type: 'string', description: 'Space key, e.g. DEV.' },
        title: { type: 'string', description: 'Page title.' },
        body: { type: 'string', description: 'Page content (plain text).' },
        parentId: { type: 'string', description: 'Optional parent page id to nest under.' },
      },
      required: ['spaceKey', 'title', 'body'],
    },
  },
  {
    name: 'confluence_add_comment',
    description: 'Add a footer comment to a Confluence page.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Page id to comment on.' },
        body: { type: 'string', description: 'The comment text (plain text).' },
      },
      required: ['pageId', 'body'],
    },
  },
];

/** Wrap plain text (paragraphs split on newlines) as Confluence storage-format XHTML. */
function toStorage(textValue: string): string {
  const paras = textValue
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');
  return paras || '<p></p>';
}

async function search(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const cql = String(args.cql ?? '').trim();
  if (!cql) return text('Error: cql is required.', true);
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 25));
  const data = await atlassianFetch(cfg, 'GET', `${API}/search?cql=${encodeURIComponent(cql)}&limit=${limit}`);
  const results: any[] = data?.results ?? [];
  const cqlShown = clip(cql, 200); // bound the echoed query
  if (!results.length) return text(`No Confluence content matched: ${cqlShown}`);
  const lines = results.map((r: any) => {
    const c = r.content ?? {};
    const space = c.space?.key || r.resultGlobalContainer?.title || '';
    return `• [${c.type || r.entityType || '—'}] ${c.title || r.title || '(untitled)'}${space ? `  (${space})` : ''}  —  id=${c.id ?? ''}\n  ${pageUrl(cfg, r.url || c._links?.webui, c.id)}`;
  });
  return text(`${results.length} result(s) for \`${cqlShown}\`:\n\n${lines.join('\n')}`);
}

async function getPage(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.pageId ?? '').trim();
  if (!id) return text('Error: pageId is required.', true);
  const c = await atlassianFetch(cfg, 'GET', `${API}/content/${encodeURIComponent(id)}?expand=body.storage,space,version`);
  const bodyHtml = c?.body?.storage?.value ?? '';
  const bodyText = storageToText(String(bodyHtml));
  const out = [
    `# ${c.title ?? ''}`,
    pageUrl(cfg, c._links?.webui, c.id),
    '',
    `Space:   ${c.space?.name ?? c.space?.key ?? '—'}`,
    `Type:    ${c.type ?? '—'}`,
    `Version: ${c.version?.number ?? '—'}`,
    '',
    bodyText || '(empty page)',
  ];
  return text(out.join('\n'));
}

async function listSpaces(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query ?? '').trim();
  const data = await atlassianFetch(cfg, 'GET', `${API}/space?limit=50`);
  let spaces: any[] = data?.results ?? [];
  if (q) spaces = spaces.filter((s: any) => `${s.key} ${s.name}`.toLowerCase().includes(q.toLowerCase()));
  if (!spaces.length) return text('No spaces found.');
  const lines = spaces.map((s: any) => `• ${s.key}  —  ${s.name}`);
  return text(`Spaces:\n\n${lines.join('\n')}`);
}

async function createPage(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const spaceKey = String(args.spaceKey ?? '').trim();
  const title = String(args.title ?? '').trim();
  const body = String(args.body ?? '');
  const parentId = String(args.parentId ?? '').trim();
  if (!spaceKey || !title || !body.trim()) return text('Error: spaceKey, title and body are required.', true);
  const payload: Record<string, unknown> = {
    type: 'page',
    title,
    space: { key: spaceKey },
    body: { storage: { value: toStorage(body), representation: 'storage' } },
    ...(parentId ? { ancestors: [{ id: parentId }] } : {}),
  };
  const created = await atlassianFetch(cfg, 'POST', `${API}/content`, payload);
  return text(`Created page "${created?.title ?? title}": ${pageUrl(cfg, created?._links?.webui, created?.id)}`);
}

async function addComment(cfg: AtlassianConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const pageId = String(args.pageId ?? '').trim();
  const body = String(args.body ?? '');
  if (!pageId || !body.trim()) return text('Error: pageId and body are required.', true);
  await atlassianFetch(cfg, 'POST', `${API}/content`, {
    type: 'comment',
    container: { id: pageId, type: 'page' },
    body: { storage: { value: toStorage(body), representation: 'storage' } },
  });
  return text(`Comment added to page ${pageId}: ${pageUrl(cfg, undefined, pageId)}`);
}

export function confluencePlugin(): McpServerPlugin {
  return {
    manifest: {
      id: CONFLUENCE_ID,
      name: 'Confluence',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Interact with Confluence over MCP via the Confluence Cloud REST API. Search with CQL, read pages, ' +
        'list spaces, and create pages / add comments. Requires a site URL, account email and API token.',
      author: 'Kravn',
      priority: 100,
      configSchema: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string', title: 'Site URL', description: 'Your Atlassian site, e.g. https://your-team.atlassian.net' },
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
          const cfg = readAtlassianConfig(config, 'Confluence');
          switch (name) {
            case 'confluence_search':
              return await search(cfg, args);
            case 'confluence_get_page':
              return await getPage(cfg, args);
            case 'confluence_list_spaces':
              return await listSpaces(cfg, args);
            case 'confluence_create_page':
              return await createPage(cfg, args);
            case 'confluence_add_comment':
              return await addComment(cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Confluence request failed.', true);
        }
      },
    },
  };
}
