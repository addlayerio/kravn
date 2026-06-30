import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native SharePoint plugin — talk to SharePoint over MCP via the Microsoft Graph API.
 *
 * Reimplemented in-process (TypeScript) on top of Microsoft Graph, the way Kravn plugins work, rather than
 * shelling out to a Python MCP server. Uses the **app-only** (client-credentials) flow: an Entra app
 * registration with Application permissions (Sites.Read.All, Files.Read.All) — config is the tenant id,
 * client id and client secret (the secret is stored encrypted; see PluginManager). Exposes search +
 * browse + read tools; reusable by any model and composable into virtual servers like any other plugin.
 */
export const SHAREPOINT_ID = 'kravn-sharepoint';

interface SpConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

class SpError extends Error {}

function readConfig(config: Record<string, unknown>): SpConfig {
  const tenantId = String(config.tenantId ?? '').trim();
  const clientId = String(config.clientId ?? '').trim();
  const clientSecret = String(config.clientSecret ?? '').trim();
  if (!tenantId || !clientId || !clientSecret) {
    throw new SpError(
      'SharePoint is not configured. Set Tenant ID, Client ID and Client Secret in the plugin config ' +
        '(an Entra app registration with Application permissions Sites.Read.All + Files.Read.All).',
    );
  }
  return { tenantId, clientId, clientSecret };
}

// App-only access tokens (~1h) cached per tenant+client.
const tokenCache = new Map<string, { token: string; exp: number }>();

async function getToken(cfg: SpConfig): Promise<string> {
  const key = `${cfg.tenantId}:${cfg.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new SpError(`Microsoft sign-in failed: ${body.error_description || `HTTP ${res.status}`}`);
  }
  tokenCache.set(key, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

async function graph(cfg: SpConfig, method: 'GET' | 'POST', path: string, jsonBody?: unknown): Promise<any> {
  const token = await getToken(cfg);
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(jsonBody ? { 'content-type': 'application/json' } : {}),
    },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });
  if (res.status === 404) throw new SpError('Not found (check the site/item id).');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message || `Graph HTTP ${res.status}`;
    throw new SpError(msg);
  }
  return data;
}

async function graphBytes(cfg: SpConfig, path: string): Promise<{ buf: Buffer; type: string }> {
  const token = await getToken(cfg);
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new SpError(`Could not download file: HTTP ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
}

const TEXT_RE = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|markdown))/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|json|xml|yaml|yml|log|html?|tsv)$/i;

function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}

// ─── Tools ─────────────────────────────────────────────────────────────────────────────────────

const TOOLS: McpToolDef[] = [
  {
    name: 'sharepoint_search',
    description:
      'Search SharePoint/OneDrive for files matching a query (full-text over the tenant the app can access). ' +
      'Returns the top matches with their name, site, web URL and the driveId+itemId needed to read them.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text.' },
        size: { type: 'number', description: 'Max results (default 10, max 25).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'sharepoint_list_sites',
    description: 'List SharePoint sites, optionally filtered by a search term. Returns each site name, id and web URL.',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Optional site name filter.' } },
    },
  },
  {
    name: 'sharepoint_list_documents',
    description:
      "List files and folders in a site's default document library. Pass a folder path to list inside it. " +
      'Returns names, item ids, sizes and web URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        siteId: { type: 'string', description: 'Site id (from sharepoint_list_sites).' },
        path: { type: 'string', description: 'Optional folder path, e.g. "Reports/2026".' },
      },
      required: ['siteId'],
    },
  },
  {
    name: 'sharepoint_read_document',
    description:
      'Read the text content of a SharePoint document. Identify it either by {driveId,itemId} (from search) ' +
      'or by {siteId,path}. Text files are returned inline; binary Office files return their metadata + web URL.',
    inputSchema: {
      type: 'object',
      properties: {
        driveId: { type: 'string' },
        itemId: { type: 'string' },
        siteId: { type: 'string' },
        path: { type: 'string', description: 'File path within the site document library.' },
      },
    },
  },
];

async function search(cfg: SpConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) return text('Error: query is required.', true);
  const size = Math.min(25, Math.max(1, Number(args.size) || 10));
  const data = await graph(cfg, 'POST', '/search/query', {
    requests: [{ entityTypes: ['driveItem'], query: { queryString: query }, from: 0, size }],
  });
  const hits = data?.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
  if (!hits.length) return text(`No SharePoint files matched "${query}".`);
  const lines = hits.map((h: any) => {
    const r = h.resource ?? {};
    const drive = r.parentReference?.driveId ?? '';
    return `• ${r.name ?? '(unnamed)'}  —  ${r.webUrl ?? ''}\n  driveId=${drive} itemId=${r.id ?? ''}`;
  });
  return text(`Top ${hits.length} matches for "${query}":\n\n${lines.join('\n')}`);
}

async function listSites(cfg: SpConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.search ?? '').trim();
  const data = await graph(cfg, 'GET', q ? `/sites?search=${encodeURIComponent(q)}` : '/sites?$top=25');
  const sites = data?.value ?? [];
  if (!sites.length) return text('No sites found.');
  const lines = sites.map((s: any) => `• ${s.displayName || s.name || '(site)'}  —  ${s.webUrl ?? ''}\n  siteId=${s.id}`);
  return text(`Sites:\n\n${lines.join('\n')}`);
}

async function listDocuments(cfg: SpConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const siteId = String(args.siteId ?? '').trim();
  if (!siteId) return text('Error: siteId is required.', true);
  const path = String(args.path ?? '').trim().replace(/^\/+|\/+$/g, '');
  const url = path
    ? `/sites/${encodeURIComponent(siteId)}/drive/root:/${path.split('/').map(encodeURIComponent).join('/')}:/children`
    : `/sites/${encodeURIComponent(siteId)}/drive/root/children`;
  const data = await graph(cfg, 'GET', url);
  const items = data?.value ?? [];
  if (!items.length) return text('This folder is empty.');
  const lines = items.map((it: any) => {
    const kind = it.folder ? 'DIR ' : 'FILE';
    const size = it.size != null ? ` (${it.size} bytes)` : '';
    return `• [${kind}] ${it.name}${size}  —  ${it.webUrl ?? ''}\n  driveId=${it.parentReference?.driveId ?? ''} itemId=${it.id}`;
  });
  return text(`Contents of ${path || 'document library root'}:\n\n${lines.join('\n')}`);
}

async function readDocument(cfg: SpConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const driveId = String(args.driveId ?? '').trim();
  const itemId = String(args.itemId ?? '').trim();
  const siteId = String(args.siteId ?? '').trim();
  const path = String(args.path ?? '').trim().replace(/^\/+|\/+$/g, '');

  let metaPath = '';
  let contentPath = '';
  if (driveId && itemId) {
    metaPath = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
    contentPath = `${metaPath}/content`;
  } else if (siteId && path) {
    const enc = path.split('/').map(encodeURIComponent).join('/');
    metaPath = `/sites/${encodeURIComponent(siteId)}/drive/root:/${enc}`;
    contentPath = `${metaPath}:/content`;
  } else {
    return text('Error: provide either {driveId,itemId} or {siteId,path}.', true);
  }

  const meta = await graph(cfg, 'GET', metaPath);
  const name: string = meta?.name ?? 'file';
  const size: number = meta?.size ?? 0;
  const mime: string = meta?.file?.mimeType ?? '';
  const webUrl: string = meta?.webUrl ?? '';
  const isText = TEXT_RE.test(mime) || TEXT_EXT.test(name);

  if (!isText) {
    return text(
      `"${name}" is a binary document (${mime || 'unknown type'}, ${size} bytes) — not readable as text inline.\n` +
        `Open it at: ${webUrl}`,
    );
  }
  if (size > 5 * 1024 * 1024) return text(`"${name}" is too large to read inline (${size} bytes).`, true);

  const { buf } = await graphBytes(cfg, contentPath);
  const body = buf.toString('utf8');
  const clipped = body.length > 12_000 ? `${body.slice(0, 12_000)}\n…[truncated, ${body.length} chars total]` : body;
  return text(`# ${name}\n${webUrl}\n\n${clipped}`);
}

export function sharepointPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: SHAREPOINT_ID,
      name: 'SharePoint',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Interact with SharePoint over MCP via Microsoft Graph (app-only). Search, browse document libraries ' +
        'and read documents. Requires an Entra app registration (Sites.Read.All + Files.Read.All).',
      author: 'Kravn',
      priority: 100,
      configSchema: {
        type: 'object',
        properties: {
          tenantId: { type: 'string', title: 'Tenant ID', description: 'Entra tenant (GUID or domain).' },
          clientId: { type: 'string', title: 'Client ID', description: 'App registration (application) ID.' },
          clientSecret: { type: 'string', title: 'Client Secret', description: 'App registration client secret.', secret: true },
        },
        required: ['tenantId', 'clientId', 'clientSecret'],
      },
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const cfg = readConfig(config);
          switch (name) {
            case 'sharepoint_search':
              return await search(cfg, args);
            case 'sharepoint_list_sites':
              return await listSites(cfg, args);
            case 'sharepoint_list_documents':
              return await listDocuments(cfg, args);
            case 'sharepoint_read_document':
              return await readDocument(cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'SharePoint request failed.', true);
        }
      },
    },
  };
}
