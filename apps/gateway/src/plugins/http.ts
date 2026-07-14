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

function hostOf(u: string): string {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return '';
  }
}

// ─── Guarded request (validate + follow redirects manually) ──────────────────────────────────────────
// `strict` (agent-supplied URL, open mode): block private/loopback/metadata on every hop via the strict
// dispatcher. Non-strict (admin-configured target): the operator's egress policy applies (an internal API is
// allowed if the operator permits private networks), still refusing non-http(s) and blocked-hosts + metadata.
//
// Redirect handling is host-aware to keep two invariants across hops (browsers do the same):
//   • `lockedHost` (locked modes) — a redirect to a DIFFERENT host is REFUSED, so a locked connector can never
//     be bounced off its configured API (e.g. an open-redirect on the trusted API → attacker host).
//   • `sensitiveKeys` (the connector's auth/default header names) — STRIPPED whenever the host changes, so a
//     server-side credential is never re-sent to a third-party host on a cross-host redirect.
async function guardedRequest(
  guard: SsrfGuard,
  method: string,
  startUrl: string,
  headers: Record<string, string>,
  body: string | undefined,
  strict: boolean,
  lockedHost: string | undefined,
  sensitiveKeys: string[],
): Promise<Response> {
  let url = startUrl;
  let curMethod = method;
  let curBody = body;
  let curHeaders = headers;
  const originHost = hostOf(startUrl);
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (strict) await guard.assertPublicUrl(url); // throws on non-http(s)/blocked/private/reserved/metadata
    else await guard.assertUrlAllowed(url); // http(s) + blocked-hosts only (dispatcher enforces the IP policy)
    const res = await fetch(
      url,
      withDispatcher(
        {
          method: curMethod,
          headers: curHeaders,
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
      const next = new URL(loc, url).toString();
      const nextHost = hostOf(next);
      // Locked connector: never leave the configured host, even via an upstream redirect.
      if (lockedHost && nextHost !== lockedHost) {
        throw new Error(`refused a cross-host redirect to ${nextHost || 'an invalid host'} — this connector is locked to ${lockedHost}`);
      }
      // Cross-host hop (only reachable in open mode): drop the connector's auth headers so they don't leak.
      if (nextHost !== originHost && sensitiveKeys.length) {
        curHeaders = { ...curHeaders };
        for (const k of Object.keys(curHeaders)) if (sensitiveKeys.some((s) => s.toLowerCase() === k.toLowerCase())) delete curHeaders[k];
      }
      url = next;
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
 * Per-instance config — the admin defines what a client may call. Three modes, tightest → loosest:
 *   • pinned  — the connector fires ONE exact request (fixed method + URL, + optional fixed body). The client
 *               cannot change the method, URL or path — it can only trigger it. ("Postman saved request".)
 *   • scoped  — an API base URL. The client chooses paths (and methods, unless read-only) UNDER that one host.
 *   • open    — the client supplies any public URL (strict SSRF). Explicit opt-in; broadest surface.
 * `defaultHeaders` (auth) are applied server-side in every mode — encrypted, never shown to the model/chat, and
 * (in locked modes) never re-sent across a redirect to another host. Safe by default: an unconfigured connector
 * refuses every request.
 */
type HttpMode = 'pinned' | 'scoped' | 'open';
interface HttpConfig {
  mode: HttpMode | 'unconfigured';
  target: string; // pinned: the exact URL; scoped: the base/root URL; open: unused
  method: string; // pinned: the one allowed method
  body?: string; // pinned: an optional fixed request body
  defaultHeaders: Record<string, string>;
  readOnly: boolean;
}
function readConfig(config: Record<string, unknown>): HttpConfig {
  const target = String(config.baseUrl ?? '').trim().replace(/\/+$/, '');
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
  const method = String(config.method ?? 'GET').trim().toUpperCase();
  const rawMode = String(config.mode ?? '').trim().toLowerCase();
  // Explicit mode wins; otherwise infer for backward-compat with pre-mode instances (allowAnyHost / baseUrl).
  let mode: HttpConfig['mode'];
  if (rawMode === 'pinned' || rawMode === 'scoped' || rawMode === 'open') mode = rawMode;
  else if (config.allowAnyHost === true) mode = 'open';
  else if (target) mode = 'scoped';
  else mode = 'unconfigured';
  return {
    mode,
    target,
    method: METHODS.has(method) ? method : 'GET',
    body: typeof config.body === 'string' && config.body.trim() ? config.body : undefined,
    defaultHeaders,
    readOnly: config.readOnly === true,
  };
}

/** Extract just the path+query from a model-supplied value, so a locked connector can't be escaped.
 *  Always returns a single-leading-slash path (collapsing `//…`); '/' means "no specific path". */
function pathOf(v: string): string {
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      return (u.pathname + u.search) || '/';
    } catch {
      return '/';
    }
  }
  if (!v) return '/';
  const [p, ...q] = v.split('?');
  const path = '/' + p.replace(/^\/+/, '');
  return q.length ? `${path}?${q.join('?')}` : path;
}

/** A `..` segment could climb above the base path after URL normalization — refused in locked modes. */
function hasDotDot(pathPart: string): boolean {
  return pathPart.split('/').includes('..');
}

/** Join a model path (path+query) UNDER a base URL using URL semantics — so a base that itself carries a query
 *  (e.g. ?apikey=…) isn't corrupted by string concatenation: the base query is kept and the model's query merged. */
function joinUnderBase(base: string, pathAndQuery: string): string {
  const u = new URL(base);
  const qi = pathAndQuery.indexOf('?');
  const pathPart = qi < 0 ? pathAndQuery : pathAndQuery.slice(0, qi);
  const query = qi < 0 ? '' : pathAndQuery.slice(qi + 1);
  u.pathname = u.pathname.replace(/\/+$/, '') + pathPart; // base path (no trailing /) + single-leading-slash path
  if (query) u.search = u.search ? `${u.search}&${query}` : `?${query}`;
  return u.toString();
}

/** Apply default content-type/accept, fire through the SSRF guard, and render the body token-efficiently. */
async function sendAndRender(
  guard: SsrfGuard,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
  strict: boolean,
  lockedHost: string | undefined,
  sensitiveKeys: string[],
): Promise<McpToolResult> {
  if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json'; // best-effort; caller can override via headers
  }
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) headers.accept = 'application/json, text/*;q=0.9, */*;q=0.8';

  let res: Response;
  try {
    res = await guardedRequest(guard, method, url, headers, body, strict, lockedHost, sensitiveKeys);
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

async function httpRequest(guard: SsrfGuard, cfg: HttpConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const sensitive = Object.keys(cfg.defaultHeaders);

  if (cfg.mode === 'unconfigured') {
    return text(
      'This HTTP Request connector is not configured. An admin must choose a **mode** in the instance ' +
        'configuration: **Pinned** (one exact request), **Scoped** (a base URL the client calls paths under), ' +
        'or **Open** (any public URL).',
      true,
    );
  }

  // ── Pinned: fire exactly the configured method + URL (+ optional fixed body). The model's url/method/headers
  // are IGNORED — it can only trigger this one request. ──────────────────────────────────────────────────────
  if (cfg.mode === 'pinned') {
    if (!cfg.target) return text('Error: this pinned connector has no request URL configured.', true);
    let url: string;
    try {
      const u = new URL(cfg.target);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return text('Error: only http(s) URLs are supported.', true);
      url = u.toString();
    } catch {
      return text('Error: the configured request URL is not a valid http(s) URL.', true);
    }
    const method = cfg.method;
    const headers: Record<string, string> = { ...cfg.defaultHeaders };
    const body = method === 'GET' || method === 'HEAD' ? undefined : cfg.body;
    return sendAndRender(guard, method, url, headers, body, false, hostOf(url), sensitive);
  }

  // ── Scoped / Open: the model chooses, within the mode's constraints. ───────────────────────────────────────
  const method = String(args.method ?? 'GET').trim().toUpperCase();
  if (!METHODS.has(method)) return text(`Error: method must be one of ${[...METHODS].join(', ')}.`, true);
  if (cfg.readOnly && method !== 'GET' && method !== 'HEAD') {
    return text('Error: this HTTP connector is read-only — only GET and HEAD are allowed.', true);
  }
  const raw = String(args.url ?? '').trim();

  let url: string;
  let strict: boolean;
  let lockedHost: string | undefined;
  if (cfg.mode === 'scoped') {
    if (!cfg.target) return text('Error: this connector has no base URL configured.', true);
    // Locked to the admin-configured host: any host the model passes is discarded (only path+query is used), and
    // an empty / "/" path hits the base URL EXACTLY (so a base pinned to one resource works without a stray "/").
    const p = pathOf(raw);
    if (hasDotDot(p.split('?')[0])) return text('Error: the path may not contain ".." segments.', true);
    url = p === '/' ? cfg.target : joinUnderBase(cfg.target, p);
    strict = false;
    lockedHost = hostOf(cfg.target);
  } else {
    // open — the model supplies a full URL → treat it as untrusted (strict SSRF, no host lock).
    if (!/^https?:\/\//i.test(raw)) return text('Error: `url` must be an absolute http(s) URL.', true);
    url = raw;
    strict = true;
    lockedHost = undefined;
  }
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return text('Error: only http(s) URLs are supported.', true);
  } catch {
    return text('Error: could not build a valid URL from the given path and Base URL.', true);
  }
  const headers = { ...cfg.defaultHeaders, ...normalizeHeaders(args.headers) };
  const body = typeof args.body === 'string' ? args.body : args.body !== undefined ? JSON.stringify(args.body) : undefined;
  return sendAndRender(guard, method, url, headers, body, strict, lockedHost, sensitive);
}

const TOOLS: McpToolDef[] = [
  {
    name: 'http_request',
    description:
      'Call the API this connector is configured for and return the body compactly: JSON as TOML and HTML as ' +
      'Markdown (to save tokens); anything else is plain text. Behaviour depends on how the admin configured it: ' +
      'PINNED — fires one fixed request; call with no arguments (url/method are ignored). SCOPED — pass a PATH ' +
      'under the base URL (e.g. /repos/owner/name), or omit url / pass "/" to call the base URL exactly. OPEN — ' +
      'pass a full http(s) URL. Authentication is applied automatically by the connector. Can mutate ' +
      '(POST/PUT/PATCH/DELETE) unless the connector is read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'SCOPED: a PATH under the base URL (e.g. /users/1); omit or pass "/" for the base URL exactly. OPEN: a full http(s) URL. Ignored for a PINNED connector.' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method (default GET). Ignored for a PINNED connector.' },
        headers: { type: 'object', description: 'Extra request headers as a flat key→value object. The connector may already add auth headers.', additionalProperties: { type: 'string' } },
        body: { type: 'string', description: 'Request body for POST/PUT/PATCH (a raw string, e.g. a JSON payload). Ignored for GET/HEAD and for a PINNED connector.' },
      },
    },
  },
];

const SETUP =
  'Add one connector per API (add the integration again for another API, each with its own credentials). Pick a ' +
  '**Mode**:\n' +
  '• **Pinned** — the tightest: the client can only fire ONE exact request. Set **API base URL** to the full ' +
  'request URL, choose the **Method**, and optionally a fixed body. The model cannot change the URL, path or ' +
  'method — ideal for a sensitive or write endpoint (a "Postman saved request").\n' +
  '• **Scoped** — set **API base URL** to the API ROOT (e.g. https://api.github.com); the client calls paths ' +
  'under it (/repos/…, /users/…). Or set it to a single endpoint the client calls with no path. The model can ' +
  'never reach another host (redirects to a different host are refused).\n' +
  '• **Open** — advanced: the client may call ANY public URL (private/internal/metadata always blocked). No ' +
  'base URL; broadest surface — use only when you really want a general HTTP tool.\n' +
  '• **Default headers (JSON)** — e.g. {"Authorization":"Bearer …"}. Applied to every request, encrypted at ' +
  'rest, never shown to the model or chat, and (in Pinned/Scoped) never re-sent across a redirect to another host.\n' +
  '• **Read-only** — (Scoped/Open) allow only GET/HEAD so clients cannot change anything. Mutating calls can be ' +
  'put behind the approval gate.';

export function httpPlugin(guard: SsrfGuard): McpServerPlugin {
  return {
    manifest: {
      id: HTTP_ID,
      name: 'HTTP Request',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'A configurable API connector with three lock levels: PINNED (fire one exact request — a "Postman saved ' +
        'request"), SCOPED (a base URL the client calls paths under), or OPEN (any public URL). Auth headers are ' +
        'applied server-side and never leak to the model or across a cross-host redirect. JSON comes back as TOML ' +
        'and HTML as Markdown to save tokens. SSRF-guarded. Add it again per API.',
      author: 'Kravn',
      priority: 100,
      setup: SETUP,
      // Configure-first: this connector does nothing until an admin points it at an API, so it seeds
      // DISABLED (no empty default instance clutters the installed list). The admin adds one instance per
      // API — each locked to its own base URL + credentials. See PluginManager native seeding.
      seedDisabled: true,
      configSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', title: 'Mode', enum: ['pinned', 'scoped', 'open'], default: 'scoped', description: 'How much the client may vary the request. pinned = fire ONE exact request (set the full URL + Method below); the client cannot change it. scoped = the API base URL below is a lock; the client picks paths under that one host. open = the client may call ANY public URL (no host lock).' },
          baseUrl: { type: 'string', title: 'API base URL / request URL', description: 'PINNED: the full request URL (e.g. https://api.example.com/orders). SCOPED: the API ROOT (e.g. https://api.example.com — the client calls paths like /users/1) or a single endpoint (called with no path). The model can never reach another host. Leave empty for OPEN mode.' },
          method: { type: 'string', title: 'Method (Pinned mode)', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], default: 'GET', description: 'The single HTTP method a PINNED connector is allowed to use. Ignored in Scoped/Open mode (the client chooses the method there, subject to Read-only).' },
          body: { type: 'string', title: 'Fixed body (Pinned mode, optional)', description: 'An optional fixed request body sent with a PINNED POST/PUT/PATCH. Ignored in other modes.' },
          defaultHeaders: { type: 'string', title: 'Default headers (JSON)', description: 'Headers added to every request, e.g. {"Authorization":"Bearer …","X-Api-Key":"…"}. Encrypted at rest; never shown to the model or in the chat.', secret: true },
          readOnly: { type: 'boolean', title: 'Read-only (GET/HEAD only)', description: 'Scoped/Open: block POST/PUT/PATCH/DELETE so clients can only read.' },
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
