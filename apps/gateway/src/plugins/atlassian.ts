import type { McpToolResult } from '@kravn/plugin-sdk';

/**
 * Shared Atlassian Cloud helpers for the native Jira + Confluence plugins: config validation, the SSRF-hard
 * base-URL guard (one place to harden), HTTP Basic auth, a size/timeout/redirect-safe fetch, and ADF
 * conversion. Both products live on the same site (https://<team>.atlassian.net) with different path
 * prefixes (`/rest/api/...` for Jira, `/wiki/rest/api/...` for Confluence).
 */
export interface AtlassianConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export class AtlassianError extends Error {}

/**
 * Validate + normalize the site URL. HTTPS only; reject IPv6 literals outright (the WHATWG parser
 * normalizes ::ffff:127.0.0.1 to hex, which defeats per-form allowlisting) and localhost/loopback/link-local
 * so a stored API token is never sent there. Private LAN ranges are allowed (self-hosted Server/DC); the
 * base URL is admin-configured, not caller-supplied.
 */
export function normalizeAtlassianBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AtlassianError('Invalid site URL. Use your site URL, e.g. https://your-team.atlassian.net');
  }
  if (u.protocol !== 'https:') throw new AtlassianError('Site URL must use https.');
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes(':')) throw new AtlassianError('Site URL host is not allowed (use a hostname, not an IPv6 literal).');
  const blocked =
    h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || /^127\./.test(h) || /^169\.254\./.test(h);
  if (blocked) throw new AtlassianError('Site URL host is not allowed.');
  return `${u.protocol}//${u.host}`; // drop any path/query/trailing slash
}

export function readAtlassianConfig(config: Record<string, unknown>, service: string): AtlassianConfig {
  const baseUrlRaw = String(config.baseUrl ?? '').trim();
  const email = String(config.email ?? '').trim();
  const apiToken = String(config.apiToken ?? '').trim();
  if (!baseUrlRaw || !email || !apiToken) {
    throw new AtlassianError(
      `${service} is not configured. Set the Site URL (e.g. https://your-team.atlassian.net), your account ` +
        'Email, and an API Token (create one at https://id.atlassian.com/manage-profile/security/api-tokens).',
    );
  }
  return { baseUrl: normalizeAtlassianBaseUrl(baseUrlRaw), email, apiToken };
}

function authHeader(cfg: AtlassianConfig): string {
  return `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')}`;
}

/** Bound error text so a hostile/huge server response can't inflate a returned message. */
export function clip(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const MAX_RESPONSE_BYTES = 10_000_000;

export async function atlassianFetch(
  cfg: AtlassianConfig,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  jsonBody?: unknown,
): Promise<any> {
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
    throw new AtlassianError('Atlassian rejected the credentials (401/403). Check the email + API token and its permissions.');
  }
  if (res.status === 404) throw new AtlassianError('Not found (check the id / key / site URL).');
  if (Number(res.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) {
    throw new AtlassianError('Atlassian response is too large to process.');
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
      `Atlassian HTTP ${res.status}`;
    throw new AtlassianError(clip(String(msg)));
  }
  return data;
}

export function toolText(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}

/** Minimal Atlassian Document Format doc wrapping plain text (paragraphs split on newlines). */
export function toAdf(textValue: string): unknown {
  const paras = textValue.split(/\n/).map((line) => ({
    type: 'paragraph',
    content: line ? [{ type: 'text', text: line }] : [],
  }));
  return { type: 'doc', version: 1, content: paras.length ? paras : [{ type: 'paragraph', content: [] }] };
}

/** Flatten an ADF node (or a plain string, as Server/DC returns) back to readable text. */
export function adfToText(node: unknown): string {
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

/** Strip Confluence "storage" XHTML down to readable plain text. */
export function storageToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Escape plain text for embedding into Confluence storage (XHTML) format. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
