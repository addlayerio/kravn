import type { McpServerPlugin, McpToolDef, McpToolResult } from '@kravn/plugin-sdk';
import type { SsrfGuard } from '../http/ssrf.js';
import { htmlToMarkdown, looksHtml, MAX_HTML_BYTES } from '../lib/html.js';

/**
 * kravn-http — fire an HTTP request (GET/POST/…) with custom headers and return the body in a
 * TOKEN-EFFICIENT form: a JSON response is rendered as TOML and an HTML response as Markdown (both drop a
 * lot of structural noise vs the raw payload); anything else comes back as capped plain text.
 *
 * The URL is agent-supplied, so this is an UNTRUSTED egress surface: every request (and every redirect hop)
 * goes through `guard.assertPublicUrl` + the strict SSRF dispatcher, which blocks private/loopback/
 * link-local/reserved/metadata targets ALWAYS — so it can't be turned into an internal-network probe.
 * It can call any PUBLIC endpoint and can mutate (POST/PUT/PATCH/DELETE) — consider the approval gate.
 */
export const HTTP_ID = 'kravn-http';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 14_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20_000;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type FetchLike = RequestInit & { dispatcher?: unknown };
function withDispatcher(init: RequestInit, dispatcher: unknown): RequestInit {
  return { ...init, dispatcher } as unknown as RequestInit;
}

function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}
function clip(s: string, max = MAX_OUTPUT_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}\n\n…[truncated ${s.length - max} chars]` : s;
}

/** Stream a Response body to text with a hard byte cap (a huge/slow body can't OOM or hang the worker). */
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

// ─── JSON → TOML (lenient: readable + compact for the model, not a strict spec encoder) ───────────────
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}
function tomlScalar(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v); // JSON string escaping is valid for TOML basic strings
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : JSON.stringify(String(v));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(String(v));
}
function tomlInline(v: unknown): string {
  if (Array.isArray(v)) return `[ ${v.map(tomlInline).join(', ')} ]`;
  if (isPlainObject(v)) {
    const parts = Object.entries(v).map(([k, val]) => `${tomlKey(k)} = ${tomlInline(val)}`);
    return `{ ${parts.join(', ')} }`;
  }
  if (v === null || v === undefined) return '""';
  return tomlScalar(v);
}
function emitTable(obj: Record<string, unknown>, path: string[]): string {
  let out = '';
  const entries = Object.entries(obj);
  // Scalar + inline (array-of-scalars / inline object) keys first — TOML requires them before sub-tables.
  for (const [k, v] of entries) {
    if (isPlainObject(v)) continue;
    if (Array.isArray(v) && v.length > 0 && v.every(isPlainObject)) continue; // array-of-tables → below
    if (v === null || v === undefined) out += `${tomlKey(k)} = ""\n`;
    else if (Array.isArray(v)) out += `${tomlKey(k)} = ${tomlInline(v)}\n`;
    else out += `${tomlKey(k)} = ${tomlScalar(v)}\n`;
  }
  // Sub-tables and arrays-of-tables.
  for (const [k, v] of entries) {
    const child = [...path, k];
    const header = child.map(tomlKey).join('.');
    if (isPlainObject(v)) {
      out += `\n[${header}]\n${emitTable(v, child)}`;
    } else if (Array.isArray(v) && v.length > 0 && v.every(isPlainObject)) {
      for (const item of v) out += `\n[[${header}]]\n${emitTable(item as Record<string, unknown>, child)}`;
    }
  }
  return out;
}
function jsonToToml(value: unknown): string {
  const root = isPlainObject(value) ? value : { result: value };
  return emitTable(root, []).trim();
}

// ─── Guarded request (SSRF-strict; validate + follow redirects manually) ──────────────────────────────
async function guardedRequest(
  guard: SsrfGuard,
  method: string,
  startUrl: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<Response> {
  let url = startUrl;
  let curMethod = method;
  let curBody = body;
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await guard.assertPublicUrl(url); // throws on non-http(s)/blocked/private/reserved/metadata — every hop
    const res = await fetch(
      url,
      withDispatcher(
        {
          method: curMethod,
          headers,
          body: curMethod === 'GET' || curMethod === 'HEAD' ? undefined : curBody,
          redirect: 'manual',
          signal: deadline,
        },
        guard.strictAgent,
      ),
    );
    if (REDIRECT_STATUSES.has(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      url = new URL(loc, url).toString();
      // 303 (and, by common practice, 301/302) → GET without a body; 307/308 preserve method + body.
      if (res.status === 303 || res.status === 301 || res.status === 302) {
        curMethod = 'GET';
        curBody = undefined;
      }
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof k === 'string' && (typeof v === 'string' || typeof v === 'number')) out[k] = String(v);
    }
  }
  return out;
}

async function httpRequest(guard: SsrfGuard, args: Record<string, unknown>): Promise<McpToolResult> {
  const method = String(args.method ?? 'GET').trim().toUpperCase();
  if (!METHODS.has(method)) return text(`Error: method must be one of ${[...METHODS].join(', ')}.`, true);
  const url = String(args.url ?? '').trim();
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return text('Error: only http(s) URLs are supported.', true);
  } catch {
    return text('Error: `url` must be an absolute http(s) URL.', true);
  }
  const headers = normalizeHeaders(args.headers);
  const body = typeof args.body === 'string' ? args.body : args.body !== undefined ? JSON.stringify(args.body) : undefined;
  if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    // A best-effort default so a JSON body is announced; the caller can override via headers.
    headers['content-type'] = 'application/json';
  }
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) headers.accept = 'application/json, text/*;q=0.9, */*;q=0.8';

  let res: Response;
  try {
    res = await guardedRequest(guard, method, url, headers, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'request failed';
    return text(`Error: the request to ${url} failed (${msg}). The host may be unreachable, private/internal, or blocked by egress policy.`, true);
  }

  const status = `${res.status} ${res.statusText}`.trim();
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (method === 'HEAD' || res.status === 204) return text(`HTTP ${status} — no body.`);

  const raw = await readCappedText(res, MAX_RESPONSE_BYTES);
  let rendered: string;
  let format: string;
  const looksJson = /json|\+json/.test(ct) || (!ct && /^\s*[[{]/.test(raw));
  if (looksJson) {
    try {
      rendered = jsonToToml(JSON.parse(raw));
      format = 'JSON → TOML';
    } catch {
      rendered = raw;
      format = 'raw (JSON parse failed)';
    }
  } else if (/html/.test(ct) || looksHtml(raw)) {
    rendered = htmlToMarkdown(raw.length > MAX_HTML_BYTES ? raw.slice(0, MAX_HTML_BYTES) : raw).replace(/\n{3,}/g, '\n\n').trim();
    format = 'HTML → Markdown';
  } else {
    rendered = raw.trim();
    format = ct || 'text';
  }
  const head = res.ok ? `HTTP ${status} (${format})` : `HTTP ${status} — request returned an error (${format})`;
  return text(`${head}\n\n${clip(rendered) || '[empty body]'}`, !res.ok);
}

const TOOLS: McpToolDef[] = [
  {
    name: 'http_request',
    description:
      'Make an HTTP request to a public URL and return the body compactly: a JSON response is rendered as ' +
      'TOML and an HTML response as Markdown (to save tokens); anything else is plain text. Supports custom ' +
      'headers and a request body. Can call any public endpoint and can mutate (POST/PUT/PATCH/DELETE) — ' +
      'internal/private hosts are blocked.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to call.' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method (default GET).' },
        headers: { type: 'object', description: 'Request headers as a flat key→value object (e.g. Authorization, Content-Type).', additionalProperties: { type: 'string' } },
        body: { type: 'string', description: 'Request body for POST/PUT/PATCH (a raw string, e.g. a JSON payload). Ignored for GET/HEAD.' },
      },
      required: ['url'],
    },
  },
];

const SETUP =
  'No configuration needed — the plugin is ready to use. It calls PUBLIC endpoints only (private/internal/' +
  'metadata hosts are always blocked) and can send POST/PUT/PATCH/DELETE, so it can change external state — ' +
  'put it behind the approval gate if you want a human to confirm mutating calls.';

export function httpPlugin(guard: SsrfGuard): McpServerPlugin {
  return {
    manifest: {
      id: HTTP_ID,
      name: 'HTTP Request',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Fire an HTTP request (GET/POST/…) with custom headers to retrieve information from any public API or ' +
        'page. JSON responses come back as TOML and HTML as Markdown to save tokens. SSRF-guarded; can mutate.',
      author: 'Kravn',
      priority: 100,
      setup: SETUP,
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args): Promise<McpToolResult> {
        try {
          if (name === 'http_request') return await httpRequest(guard, args);
          return text(`Unknown tool: ${name}`, true);
        } catch (err) {
          return text(err instanceof Error ? err.message : 'HTTP request failed.', true);
        }
      },
    },
  };
}
