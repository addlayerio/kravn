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

// ─── Guarded request (validate + follow redirects manually) ──────────────────────────────────────────
// `strict` (agent-supplied URL): block private/loopback/metadata on every hop via the strict dispatcher.
// Non-strict (admin-configured base URL): the operator's egress policy applies (an internal API is allowed
// if the operator permits private networks), still refusing non-http(s) and blocked-hosts + metadata.
async function guardedRequest(
  guard: SsrfGuard,
  method: string,
  startUrl: string,
  headers: Record<string, string>,
  body: string | undefined,
  strict: boolean,
): Promise<Response> {
  let url = startUrl;
  let curMethod = method;
  let curBody = body;
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (strict) await guard.assertPublicUrl(url); // throws on non-http(s)/blocked/private/reserved/metadata
    else await guard.assertUrlAllowed(url); // http(s) + blocked-hosts only (dispatcher enforces the IP policy)
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
        strict ? guard.strictAgent : guard.agent,
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

/**
 * Per-instance config — the admin defines what a client may call:
 *   • baseUrl        — lock the connector to ONE API; the model can only reach paths under it.
 *   • defaultHeaders — auth etc. applied server-side (encrypted, never shown to the model/chat).
 *   • readOnly       — allow only GET/HEAD (no mutations).
 *   • allowAnyHost   — explicit opt-in to an OPEN tool (model may call any public URL). Off by default.
 * Safe by default: with neither baseUrl nor allowAnyHost, the tool refuses every request.
 */
interface HttpConfig {
  baseUrl: string;
  defaultHeaders: Record<string, string>;
  readOnly: boolean;
  allowAnyHost: boolean;
}
function readConfig(config: Record<string, unknown>): HttpConfig {
  const baseUrl = String(config.baseUrl ?? '').trim().replace(/\/+$/, '');
  let defaultHeaders: Record<string, string> = {};
  const dh = config.defaultHeaders;
  if (typeof dh === 'string' && dh.trim()) {
    try {
      defaultHeaders = normalizeHeaders(JSON.parse(dh));
    } catch {
      /* malformed JSON → no default headers */
    }
  } else if (dh && typeof dh === 'object') {
    defaultHeaders = normalizeHeaders(dh);
  }
  return { baseUrl, defaultHeaders, readOnly: config.readOnly === true, allowAnyHost: config.allowAnyHost === true };
}

/** Extract just the path+query from a model-supplied value, so a locked connector can't be escaped. */
function pathOf(v: string): string {
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      return u.pathname + u.search;
    } catch {
      return '/';
    }
  }
  return v.startsWith('/') ? v : `/${v}`;
}

async function httpRequest(guard: SsrfGuard, cfg: HttpConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const method = String(args.method ?? 'GET').trim().toUpperCase();
  if (!METHODS.has(method)) return text(`Error: method must be one of ${[...METHODS].join(', ')}.`, true);
  if (cfg.readOnly && method !== 'GET' && method !== 'HEAD') {
    return text('Error: this HTTP connector is read-only — only GET and HEAD are allowed.', true);
  }
  const raw = String(args.url ?? '').trim();

  let url: string;
  let strict: boolean;
  if (cfg.baseUrl) {
    // Locked to the admin-configured API: the model can ONLY reach paths under baseUrl (any host it passes is
    // discarded — only the path+query is used). Admin-configured target → the operator's egress policy applies.
    url = cfg.baseUrl + pathOf(raw);
    strict = false;
  } else if (cfg.allowAnyHost) {
    // Open tool (explicit admin opt-in): the model supplies a full URL → treat it as untrusted (strict SSRF).
    if (!/^https?:\/\//i.test(raw)) return text('Error: `url` must be an absolute http(s) URL.', true);
    url = raw;
    strict = true;
  } else {
    return text(
      'This HTTP Request connector is not configured. An admin must set an **API base URL** (so it can only ' +
        'call that API) — or, for an open tool, enable **Allow any host** — in the instance configuration.',
      true,
    );
  }
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return text('Error: only http(s) URLs are supported.', true);
  } catch {
    return text('Error: could not build a valid URL from the given path and Base URL.', true);
  }
  // Instance default headers (auth etc.) first; the model's per-call headers can add/override.
  const headers = { ...cfg.defaultHeaders, ...normalizeHeaders(args.headers) };
  const body = typeof args.body === 'string' ? args.body : args.body !== undefined ? JSON.stringify(args.body) : undefined;
  if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    // A best-effort default so a JSON body is announced; the caller can override via headers.
    headers['content-type'] = 'application/json';
  }
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) headers.accept = 'application/json, text/*;q=0.9, */*;q=0.8';

  let res: Response;
  try {
    res = await guardedRequest(guard, method, url, headers, body, strict);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'request failed';
    return text(`Error: the request to ${url} failed (${msg}). The host may be unreachable, private/internal, or blocked by egress policy.`, true);
  }

  const status = `${res.status} ${res.statusText}`.trim();
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (method === 'HEAD' || res.status === 204) return text(`HTTP ${status} — no body.`);

  const bodyText = await readCappedText(res, MAX_RESPONSE_BYTES);
  let rendered: string;
  let format: string;
  const looksJson = /json|\+json/.test(ct) || (!ct && /^\s*[[{]/.test(bodyText));
  if (looksJson) {
    try {
      rendered = jsonToToml(JSON.parse(bodyText));
      format = 'JSON → TOML';
    } catch {
      rendered = bodyText;
      format = 'raw (JSON parse failed)';
    }
  } else if (/html/.test(ct) || looksHtml(bodyText)) {
    rendered = htmlToMarkdown(bodyText.length > MAX_HTML_BYTES ? bodyText.slice(0, MAX_HTML_BYTES) : bodyText).replace(/\n{3,}/g, '\n\n').trim();
    format = 'HTML → Markdown';
  } else {
    rendered = bodyText.trim();
    format = ct || 'text';
  }
  const head = res.ok ? `HTTP ${status} (${format})` : `HTTP ${status} — request returned an error (${format})`;
  return text(`${head}\n\n${clip(rendered) || '[empty body]'}`, !res.ok);
}

const TOOLS: McpToolDef[] = [
  {
    name: 'http_request',
    description:
      'Call the API this connector is configured for and return the body compactly: JSON as TOML and HTML as ' +
      'Markdown (to save tokens); anything else is plain text. If the connector has a Base URL, pass a PATH ' +
      '(e.g. /repos/owner/name); authentication is applied automatically by the connector. Can mutate ' +
      '(POST/PUT/PATCH/DELETE) unless the connector is read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A PATH (e.g. /users/1) when the connector has a Base URL, or a full http(s) URL for an open connector.' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method (default GET).' },
        headers: { type: 'object', description: 'Extra request headers as a flat key→value object. The connector may already add auth headers.', additionalProperties: { type: 'string' } },
        body: { type: 'string', description: 'Request body for POST/PUT/PATCH (a raw string, e.g. a JSON payload). Ignored for GET/HEAD.' },
      },
      required: ['url'],
    },
  },
];

const SETUP =
  'Define ONE API per connector so clients can only call that API (add the integration again for another API, ' +
  'each with its own credentials):\n' +
  '• **API base URL** — e.g. https://api.github.com. The model can only reach paths under it; it cannot call ' +
  'any other host. Requests use the operator egress policy (an internal API is allowed if private networks are).\n' +
  '• **Default headers (JSON)** — e.g. {"Authorization":"Bearer …"}. Applied to every request, encrypted at ' +
  'rest, and never shown to the model or in the chat.\n' +
  '• **Read-only** — allow only GET/HEAD so clients cannot change anything.\n' +
  '• **Allow any host** — advanced: leave OFF for a locked connector. On (with no base URL) makes it an open ' +
  'tool that can call ANY public URL (private/internal/metadata always blocked). A connector with neither a ' +
  'base URL nor this flag refuses every request. Mutating calls can be put behind the approval gate.';

export function httpPlugin(guard: SsrfGuard): McpServerPlugin {
  return {
    manifest: {
      id: HTTP_ID,
      name: 'HTTP Request',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'A configurable API connector: an admin points it at ONE API (base URL + auth headers) and clients call ' +
        'it read-only or read-write. JSON responses come back as TOML and HTML as Markdown to save tokens. ' +
        'SSRF-guarded. Add it again per API; leave it open only with an explicit opt-in.',
      author: 'Kravn',
      priority: 100,
      setup: SETUP,
      configSchema: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string', title: 'API base URL', description: 'Lock this connector to one API, e.g. https://api.example.com. The model can only call paths under it — it cannot reach any other host. Leave empty only if you enable "Allow any host".' },
          defaultHeaders: { type: 'string', title: 'Default headers (JSON)', description: 'Headers added to every request, e.g. {"Authorization":"Bearer …","X-Api-Key":"…"}. Encrypted at rest; never shown to the model or in the chat.', secret: true },
          readOnly: { type: 'boolean', title: 'Read-only (GET/HEAD only)', description: 'Block POST/PUT/PATCH/DELETE so clients can only read.' },
          allowAnyHost: { type: 'boolean', title: 'Allow any host (advanced)', description: 'Let the model call ANY public URL (no base-URL lock). Powerful — leave off unless you want an open HTTP tool.' },
        },
      },
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          if (name === 'http_request') return await httpRequest(guard, readConfig(config), args);
          return text(`Unknown tool: ${name}`, true);
        } catch (err) {
          return text(err instanceof Error ? err.message : 'HTTP request failed.', true);
        }
      },
    },
  };
}
