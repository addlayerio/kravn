import { createHash } from 'node:crypto';
import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';
import { extractText } from '../chat/extract.js';

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
  /** M365 geo region — REQUIRED by the Graph Search API for app-only requests (e.g. NAM, EUR, BRA). */
  region: string;
}

class SpError extends Error {}

function readConfig(config: Record<string, unknown>): SpConfig {
  const tenantId = String(config.tenantId ?? '').trim();
  const clientId = String(config.clientId ?? '').trim();
  const clientSecret = String(config.clientSecret ?? '').trim();
  const region = String(config.region ?? '').trim().toUpperCase();
  if (!tenantId || !clientId || !clientSecret) {
    throw new SpError(
      'SharePoint is not configured. Set Tenant ID, Client ID and Client Secret in the plugin config ' +
        '(an Entra app registration with Application permissions Sites.Read.All or Sites.Selected + Files.Read.All).',
    );
  }
  return { tenantId, clientId, clientSecret, region };
}

// App-only access tokens (~1h) cached per tenant+client.
const tokenCache = new Map<string, { token: string; exp: number }>();

async function getToken(cfg: SpConfig): Promise<string> {
  // Include a hash of the secret in the cache key so a config supplying a different (or blank) secret can
  // never be handed a token minted from another config that shares the same tenant + client id.
  const secretHash = createHash('sha256').update(cfg.clientSecret).digest('hex').slice(0, 16);
  const key = `${cfg.tenantId}:${cfg.clientId}:${secretHash}`;
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
      'Read the text content of a SharePoint document — Word (.docx), PDF, Excel/CSV and plain text are all ' +
      'extracted to text. Identify the file either by {driveId,itemId} (from search) or by {siteId,path}.',
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
  if (!cfg.region) {
    return text(
      'Search needs a Region. The Microsoft Graph Search API requires a "region" for app-only requests — ' +
        "set the Region field in the plugin config to your M365 tenant's geo (e.g. NAM, EUR, BRA, APC, GBR, IND).",
      true,
    );
  }
  const data = await graph(cfg, 'POST', '/search/query', {
    requests: [{ entityTypes: ['driveItem'], query: { queryString: query }, from: 0, size, region: cfg.region }],
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

  if (size > 25 * 1024 * 1024) {
    return text(`"${name}" is too large to read inline (${size} bytes). Open it at: ${webUrl}`, true);
  }

  const { buf } = await graphBytes(cfg, contentPath);
  // Reuse Kravn's document extractor (same one the chat uses): PDF (unpdf), Word .docx (mammoth),
  // Excel/CSV (xlsx) and plain text/code all come back as text.
  let extracted: { text: string };
  try {
    extracted = await extractText(name, mime, buf);
  } catch (e) {
    return text(`Could not read "${name}": ${e instanceof Error ? e.message : 'extraction failed'}. Open it at: ${webUrl}`, true);
  }
  if (!extracted.text.trim()) {
    return text(
      `"${name}" (${mime || 'unknown type'}, ${size} bytes) has no extractable text — it may be an image or a ` +
        `scanned PDF (no text layer). Open it at: ${webUrl}`,
    );
  }
  return text(`# ${name}\n${webUrl}\n\n${extracted.text}`);
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
      setup:
        'Create an Entra (Azure AD) app registration and grant it these Application permissions, then "Grant admin consent":\n\n' +
        '• Sites.Read.All (or Sites.Selected) — read SharePoint sites\n' +
        '• Files.Read.All — read files / documents\n\n' +
        'All read-only. Then set Tenant ID, Client ID and Client Secret below. For sharepoint_search, also set Region ' +
        'to your M365 geo (NAM, EUR, BRA, APC, GBR, IND, …) — the Graph Search API requires it for app-only requests.',
      configSchema: {
        type: 'object',
        properties: {
          tenantId: { type: 'string', title: 'Tenant ID', description: 'Entra tenant (GUID or domain).' },
          clientId: { type: 'string', title: 'Client ID', description: 'App registration (application) ID.' },
          clientSecret: { type: 'string', title: 'Client Secret', description: 'App registration client secret.', secret: true },
          region: {
            type: 'string',
            title: 'Region',
            description:
              "M365 geo region (REQUIRED for search with app-only): NAM, EUR, APC, AUS, BRA, CAN, GBR, IND, JPN, etc.",
          },
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
