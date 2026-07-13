import type { McpServerPlugin, McpToolDef, McpToolResult } from '@kravn/plugin-sdk';
import type { SsrfGuard } from '../http/ssrf.js';
import { htmlToMarkdown, looksHtml, MAX_HTML_BYTES } from '../lib/html.js';

/**
 * kravn-web — a native mcp-server plugin that gives an agent read-only web access:
 *   • web_fetch(url)      — fetch a page and return clean, readable text (Markdown). No config needed.
 *   • web_search(query)   — search the web via a configured provider (Brave API key or a SearXNG URL).
 *
 * SSRF: web_fetch takes a URL chosen by an agent/end-user, so it is an UNTRUSTED egress surface. Every
 * hop is validated with `guard.assertPublicUrl` (which also covers IP-literal URLs — undici skips the
 * dispatcher lookup for literals) and fetched through `guard.strictAgent`, which blocks private/loopback/
 * link-local/reserved/metadata targets ALWAYS — regardless of the operator's ssrfAllowPrivateNetworks
 * setting (that toggle only ever loosens the gateway's OWN egress to operator-configured upstreams).
 * So web_fetch on an internal URL fails closed even on an in-cluster deployment. web_search hits a fixed
 * public API (Brave) or an operator-configured SearXNG, so those use the normal egress policy.
 *
 * Config is entirely OPTIONAL: with no config the plugin seeds ENABLED and web_fetch works out of the
 * box; web_search returns a helpful "configure a provider" message until a Brave key or SearXNG URL is set.
 */
export const WEB_ID = 'kravn-web';

/** Cap the response we read (bytes) and the text we hand to the model (chars), and bound time + redirects. */
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 12_000;
const MAX_RESULTS = 8;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * undici accepts a per-request `dispatcher`, but the global fetch's RequestInit is typed against a
 * DIFFERENT copy of undici's types (undici vs undici-types), so assigning our Agent there fails to
 * type-check. This builds the init with the dispatcher present at runtime while erasing the
 * cross-package type comparison.
 */
function fetchInit(init: RequestInit, dispatcher?: unknown): RequestInit {
  return { ...init, ...(dispatcher ? { dispatcher } : {}) } as unknown as RequestInit;
}

interface WebConfig {
  braveApiKey: string;
  searxngUrl: string;
}

function readConfig(config: Record<string, unknown>): WebConfig {
  return {
    braveApiKey: String(config.braveApiKey ?? '').trim(),
    searxngUrl: String(config.searxngUrl ?? '').trim().replace(/\/+$/, ''),
  };
}

function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}

function clip(s: string, max = MAX_TEXT_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}\n\n…[truncated ${s.length - max} chars]` : s;
}

/** Read a Response body as UTF-8 text, streaming with a hard byte cap so a huge/slow body can't OOM/hang us. */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

/**
 * Strict fetch for an untrusted, agent-supplied URL: validate every hop (incl. IP literals + the redirect
 * target) and connect through the strict SSRF dispatcher. Redirects are followed manually so each new
 * target is re-validated (undici would otherwise bypass the lookup on a redirect to an IP-literal host).
 */
async function guardedFetch(guard: SsrfGuard, startUrl: string, headers: Record<string, string>): Promise<Response> {
  let current = startUrl;
  // One deadline for the WHOLE call (headers + body across every redirect hop), so a chain of slow
  // servers can't stretch a single web_fetch to MAX_REDIRECTS × the per-request timeout.
  const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await guard.assertPublicUrl(current); // throws on non-http(s), blocked, or private/reserved/metadata
    const res = await fetch(current, fetchInit({ redirect: 'manual', headers, signal: deadline }, guard.strictAgent));
    if (REDIRECT_STATUSES.has(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

async function webFetch(guard: SsrfGuard, args: Record<string, unknown>): Promise<McpToolResult> {
  const url = String(args.url ?? '').trim();
  let host = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return text('Error: only http(s) URLs are supported.', true);
  } catch {
    return text('Error: `url` must be an absolute URL, e.g. https://example.com/page.', true);
  }
  let res: Response;
  try {
    res = await guardedFetch(guard, url, {
      'user-agent': 'KravnBot/1.0 (+https://kravn.io)',
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'request failed';
    return text(`Error: could not fetch ${host || 'the URL'} (${msg}). The host may be unreachable, private/internal, or blocked by egress policy.`, true);
  }
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return text(`Error: ${host} returned ${res.status} ${res.statusText}.`, true);
  }

  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (ct && !/(text\/|html|json|xml|javascript|\+xml)/.test(ct)) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return text(`The URL returned "${ct}", which is not readable text (e.g. an image or binary file). web_fetch only reads web pages, JSON and plain text.`, true);
  }

  const body = await readCappedText(res, MAX_FETCH_BYTES);
  const isHtml = /html/.test(ct) || looksHtml(body);
  // htmlToMarkdown passes very large HTML through untouched, so bound the input first.
  const out = isHtml ? htmlToMarkdown(body.length > MAX_HTML_BYTES ? body.slice(0, MAX_HTML_BYTES) : body) : body;
  const cleaned = out.replace(/\n{3,}/g, '\n\n').trim();
  return text(`Source: ${url}\n\n${clip(cleaned) || '[the page had no extractable text]'}`);
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Fetch + parse JSON with a body-time deadline and a size cap. Explicitly connects through the NORMAL SSRF
 * dispatcher (guard.agent): web_search only ever hits a fixed public API (Brave) or the operator-configured
 * SearXNG, so it follows the operator's egress policy (allowPrivate + blocked-hosts) rather than the strict
 * agent — an internal SearXNG stays reachable — without relying on the process-global dispatcher being set.
 */
async function fetchJson(guard: SsrfGuard, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(
    url,
    fetchInit({ redirect: 'follow', headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }, guard.agent),
  );
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new Error(`search request failed (${res.status} ${res.statusText}).`);
  }
  return JSON.parse(await readCappedText(res, MAX_FETCH_BYTES));
}

async function braveSearch(guard: SsrfGuard, cfg: WebConfig, query: string, count: number): Promise<SearchHit[]> {
  const u = new URL('https://api.search.brave.com/res/v1/web/search');
  u.searchParams.set('q', query);
  u.searchParams.set('count', String(count));
  const data = (await fetchJson(guard, u.toString(), { 'x-subscription-token': cfg.braveApiKey })) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? r.url ?? '(untitled)',
    url: r.url ?? '',
    snippet: (r.description ?? '').replace(/<[^>]+>/g, ''),
  }));
}

async function searxngSearch(guard: SsrfGuard, cfg: WebConfig, query: string, count: number): Promise<SearchHit[]> {
  const u = new URL(`${cfg.searxngUrl}/search`);
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'json');
  const data = (await fetchJson(guard, u.toString(), {})) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? r.url ?? '(untitled)',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
}

async function webSearch(guard: SsrfGuard, cfg: WebConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) return text('Error: `query` is required.', true);
  const count = Math.min(Math.max(Number(args.count) || MAX_RESULTS, 1), 20);

  const provider = cfg.braveApiKey ? 'brave' : cfg.searxngUrl ? 'searxng' : null;
  if (!provider) {
    return text(
      'web_search is not configured. An operator must set a search provider on this plugin: a Brave Search ' +
        'API key (braveApiKey) or a self-hosted SearXNG base URL (searxngUrl). web_fetch works without any config.',
      true,
    );
  }
  try {
    const hits = provider === 'brave' ? await braveSearch(guard, cfg, query, count) : await searxngSearch(guard, cfg, query, count);
    if (!hits.length) return text(`No results for "${query}".`);
    const md = hits
      .map((h, i) => `${i + 1}. [${h.title}](${h.url})${h.snippet ? `\n   ${h.snippet}` : ''}`)
      .join('\n');
    return text(clip(`Search results for "${query}" (via ${provider}):\n\n${md}\n\nUse web_fetch on a result URL to read its full content.`));
  } catch (err) {
    return text(err instanceof Error ? err.message : 'Search request failed.', true);
  }
}

const TOOLS: McpToolDef[] = [
  {
    name: 'web_fetch',
    description:
      'Fetch a web page (or JSON/plain-text URL) and return its readable content as Markdown. Use this to read ' +
      'an article, documentation page or API response the user references. Private/internal hosts are blocked.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL to fetch.' } },
      required: ['url'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the public web and return the top results (title, URL, snippet). Follow up with web_fetch to read a ' +
      "result. Requires a search provider configured by the operator (Brave API key or SearXNG URL).",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        count: { type: 'number', description: `How many results to return (1-20, default ${MAX_RESULTS}).` },
      },
      required: ['query'],
    },
  },
];

const SETUP =
  'web_fetch needs no configuration — it works as soon as the plugin is enabled, and only reaches public ' +
  'hosts (private/internal/metadata addresses are always blocked).\n' +
  '• To enable web_search, provide ONE search provider:\n' +
  '  • Brave Search API key — get one at api-dashboard.search.brave.com (free tier available).\n' +
  '  • SearXNG base URL — a self-hosted SearXNG instance (e.g. https://searxng.internal). Unlike web_fetch,\n' +
  '    the operator-configured search endpoint follows the normal egress policy, so an internal SearXNG is\n' +
  '    reachable when private networks are allowed (allowlist its host in SSRF settings if needed).';

export function webPlugin(guard: SsrfGuard): McpServerPlugin {
  return {
    manifest: {
      id: WEB_ID,
      name: 'Web',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Read-only web access for agents: web_fetch reads any web page as clean Markdown, and web_search returns ' +
        'search results via a configured provider (Brave or SearXNG). web_fetch egress is strictly SSRF-guarded.',
      author: 'Kravn',
      priority: 100,
      setup: SETUP,
      // Every field OPTIONAL → the plugin seeds ENABLED; web_fetch works immediately, web_search until configured.
      configSchema: {
        type: 'object',
        properties: {
          braveApiKey: { type: 'string', title: 'Brave Search API key', description: 'Enables web_search via the Brave Search API.', secret: true },
          searxngUrl: { type: 'string', title: 'SearXNG base URL', description: 'Alternative to Brave: a self-hosted SearXNG instance, e.g. https://searxng.example.com.' },
        },
      },
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const cfg = readConfig(config);
          switch (name) {
            case 'web_fetch':
              return await webFetch(guard, args);
            case 'web_search':
              return await webSearch(guard, cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Web request failed.', true);
        }
      },
    },
  };
}
