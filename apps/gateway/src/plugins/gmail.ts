import crypto from 'node:crypto';
import type { McpServerPlugin, McpToolResult, McpToolDef, McpCallContext } from '@kravn/plugin-sdk';

/**
 * Native Gmail plugin — read AND send mail over the Gmail REST API (no external runner, no google SDK).
 *
 * Tools: search/read messages, read a full message, and **send** (incl. replying into a thread). Sending is a
 * mutating action — put `gmail_send` behind Kravn's approval gate if you want a human to confirm outbound mail.
 *
 * Auth is Google OAuth 2.0 server-to-server: a client id + secret and a long-lived **refresh token** the
 * operator generates once (scopes `gmail.readonly` + `gmail.send`, or `gmail.modify` + `gmail.send`). The secret
 * and refresh token are `secret: true` → encrypted at rest; Kravn refreshes short-lived access tokens itself.
 * Hosts are fixed Google endpoints (no user-supplied URL → no SSRF); outbound requests refuse redirects, time
 * out and cap the body.
 */
export const GMAIL_ID = 'kravn-gmail';

class GmailError extends Error {}

interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const MAX_RESPONSE_BYTES = 10_000_000;
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function clip(s: string, max = 8000): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}
function readConfig(config: Record<string, unknown>): GmailConfig {
  const clientId = String(config.clientId ?? '').trim();
  const clientSecret = String(config.clientSecret ?? '').trim();
  const refreshToken = String(config.refreshToken ?? '').trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new GmailError('Gmail is not configured. Set the OAuth Client ID, Client Secret and a Refresh Token (scopes gmail.readonly + gmail.send).');
  }
  return { clientId, clientSecret, refreshToken };
}

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function getToken(cfg: GmailConfig, force = false): Promise<string> {
  const key = crypto.createHash('sha256').update(`${cfg.clientId}|${cfg.clientSecret}|${cfg.refreshToken}`).digest('hex');
  if (!force) {
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
  }
  let res: Response;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new GmailError(`Could not reach Google's token endpoint: ${(err as Error).message}`);
  }
  const body = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  try {
    data = JSON.parse(body);
  } catch {
    throw new GmailError(`Google token endpoint returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!data.access_token) throw new GmailError(`Gmail token refresh failed: ${clip(String(data.error_description || data.error || `HTTP ${res.status}`), 400)}`);
  tokenCache.set(key, { accessToken: String(data.access_token), expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  return String(data.access_token);
}

async function gmailApi(cfg: GmailConfig, method: string, path: string, body?: unknown, retried = false): Promise<any> {
  const token = await getToken(cfg);
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new GmailError(`Could not reach Gmail: ${(err as Error).message}`);
  }
  if (res.status === 401 && !retried) {
    await getToken(cfg, true);
    return gmailApi(cfg, method, path, body, true);
  }
  const bodyText = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: any;
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new GmailError(`Gmail returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!res.ok || data?.error) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new GmailError(clip(`Gmail error: ${msg}`, 800));
  }
  return data;
}

// ─── MIME helpers (build an RFC-2822 message; UTF-8 safe for accents) ───────────────────────────────
function encodeHeader(v: string): string {
  // RFC 2047 encode only if it contains non-ASCII (keeps plain ASCII readable).
  return /[^\x20-\x7E]/.test(v) ? `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=` : v;
}
interface Attachment {
  name: string;
  mimeType: string;
  data: string; // base64
}

const MAX_ATTACH_BYTES = 25_000_000; // Gmail caps a whole message at ~25 MB

/** Collect attachments from explicit base64 (`attachments`) and/or files already attached to the conversation
 *  (`attachFiles`, referenced by name — so a big file needn't be echoed as base64 through the model). */
function resolveAttachments(args: Record<string, unknown>, ctx?: McpCallContext): Attachment[] {
  const out: Attachment[] = [];
  if (args.attachments) {
    let arr: unknown;
    try {
      arr = typeof args.attachments === 'string' ? JSON.parse(args.attachments) : args.attachments;
    } catch {
      throw new GmailError('attachments must be a JSON array of {name, mimeType, data(base64)}.');
    }
    if (Array.isArray(arr))
      for (const a of arr as any[]) {
        if (a?.name && a?.data) out.push({ name: String(a.name), mimeType: String(a.mimeType || 'application/octet-stream'), data: String(a.data).replace(/\s+/g, '') });
      }
  }
  if (args.attachFiles) {
    let names: unknown;
    try {
      names = typeof args.attachFiles === 'string' ? JSON.parse(args.attachFiles) : args.attachFiles;
    } catch {
      throw new GmailError('attachFiles must be a JSON array of file names attached to the conversation.');
    }
    const files = ctx?.files ?? [];
    if (Array.isArray(names))
      for (const n of names) {
        const f = files.find((x) => x.name === String(n));
        if (!f) throw new GmailError(`Attachment "${n}" isn't among the files attached to this conversation.`);
        out.push({ name: f.name, mimeType: f.mime || 'application/octet-stream', data: f.b64 });
      }
  }
  if (out.reduce((s, a) => s + a.data.length, 0) > MAX_ATTACH_BYTES * 1.37) throw new GmailError("Attachments exceed Gmail's ~25 MB message limit.");
  return out;
}

function buildMime(opts: { to: string; cc?: string; bcc?: string; subject: string; body: string; html: boolean; attachments?: Attachment[] }): string {
  const h: string[] = [];
  h.push(`To: ${opts.to}`);
  if (opts.cc) h.push(`Cc: ${opts.cc}`);
  if (opts.bcc) h.push(`Bcc: ${opts.bcc}`);
  h.push(`Subject: ${encodeHeader(opts.subject)}`);
  h.push('MIME-Version: 1.0');
  const wrap = (s: string) => s.replace(/(.{76})/g, '$1\r\n');
  const bodyMime = `${opts.html ? 'text/html' : 'text/plain'}; charset="UTF-8"`;
  const bodyB64 = wrap(Buffer.from(opts.body, 'utf8').toString('base64'));
  if (!opts.attachments || !opts.attachments.length) {
    h.push(`Content-Type: ${bodyMime}`, 'Content-Transfer-Encoding: base64');
    return `${h.join('\r\n')}\r\n\r\n${bodyB64}`;
  }
  // multipart/mixed: the text/html body part + one part per attachment.
  const boundary = `kravn_${crypto.randomBytes(12).toString('hex')}`;
  h.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts: string[] = [`Content-Type: ${bodyMime}\r\nContent-Transfer-Encoding: base64\r\n\r\n${bodyB64}`];
  for (const a of opts.attachments) {
    const nm = a.name.replace(/["\r\n]/g, '');
    const mt = a.mimeType.replace(/[\r\n]/g, '');
    parts.push(`Content-Type: ${mt}; name="${nm}"\r\nContent-Disposition: attachment; filename="${nm}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(a.data)}`);
  }
  const bodyBlock = parts.map((p) => `--${boundary}\r\n${p}`).join('\r\n') + `\r\n--${boundary}--`;
  return `${h.join('\r\n')}\r\n\r\n${bodyBlock}`;
}

function headersOf(msg: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) out[String(h.name).toLowerCase()] = h.value;
  return out;
}
function decodePart(part: any): string {
  const data = part?.body?.data;
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}
function extractBody(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' || payload.mimeType === 'text/html') return decodePart(payload);
  for (const p of payload.parts ?? []) {
    if (p.mimeType === 'text/plain') return decodePart(p);
  }
  for (const p of payload.parts ?? []) {
    const nested = extractBody(p);
    if (nested) return nested;
  }
  return '';
}

// ─── Tools ──────────────────────────────────────────────────────────────────────────────────────────

const TOOLS: McpToolDef[] = [
  {
    name: 'gmail_search',
    description:
      'Search the mailbox and return matching messages (from, subject, date, snippet + id). `query` uses Gmail ' +
      'search syntax, e.g. `from:boss@acme.com is:unread newer_than:7d`. Optional `max` (default 20, max 100).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query (empty = recent mail).' },
        max: { type: 'number', description: 'Max messages (default 20, max 100).' },
      },
    },
  },
  {
    name: 'gmail_get_message',
    description: 'Read a full message by id (headers + decoded body). Also returns its threadId for replying.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The message id (from gmail_search).' } },
      required: ['id'],
    },
  },
  {
    name: 'gmail_send',
    description:
      'Send an email (or reply into a thread), optionally with attachments. `to` is a comma-separated recipient ' +
      'list; optional `cc`/`bcc`. `html` = true for an HTML body. Reply within a conversation with `threadId`. ' +
      'Attach files two ways: `attachFiles` (a JSON array of names of files already attached to THIS conversation ' +
      "— preferred, no base64 needed) and/or `attachments` (a JSON array of {name, mimeType, data} where data is " +
      'base64). NOTE: this sends real mail — a mutating action.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Comma-separated recipient addresses.' },
        subject: { type: 'string', description: 'Email subject.' },
        body: { type: 'string', description: 'Email body (plain text, or HTML if html=true).' },
        cc: { type: 'string', description: 'Optional comma-separated CC.' },
        bcc: { type: 'string', description: 'Optional comma-separated BCC.' },
        html: { type: 'boolean', description: 'Send the body as HTML (default false = plain text).' },
        threadId: { type: 'string', description: 'Optional thread id to reply within a conversation.' },
        attachFiles: { type: 'string', description: 'Optional JSON array of file names attached to this conversation to send as attachments, e.g. ["report.pdf"].' },
        attachments: { type: 'string', description: 'Optional JSON array of {name, mimeType, data} attachments where data is base64.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'gmail_list_labels',
    description: 'List the mailbox labels (Inbox, Sent, custom labels…) with ids — useful to build search queries.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function search(cfg: GmailConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const max = Math.min(100, Math.max(1, Number(args.max) || 20));
  const q = new URLSearchParams({ maxResults: String(max) });
  if (args.query) q.set('q', String(args.query));
  const list = await gmailApi(cfg, 'GET', `/messages?${q}`);
  const ids = ((list.messages ?? []) as any[]).map((m) => m.id);
  const rows: any[] = [];
  for (const id of ids) {
    const m = await gmailApi(cfg, 'GET', `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    const h = headersOf(m);
    rows.push({ id, threadId: m.threadId, from: h.from, subject: h.subject, date: h.date, snippet: m.snippet });
  }
  return text(rows.length ? `${rows.length} message(s):\n\n${clip(JSON.stringify(rows, null, 2))}` : 'No messages match.');
}

async function getMessage(cfg: GmailConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id ?? '').trim();
  if (!id) return text('Error: id is required.', true);
  const m = await gmailApi(cfg, 'GET', `/messages/${encodeURIComponent(id)}?format=full`);
  const h = headersOf(m);
  const out = {
    id: m.id,
    threadId: m.threadId,
    from: h.from,
    to: h.to,
    cc: h.cc,
    subject: h.subject,
    date: h.date,
    body: clip(extractBody(m.payload), 12_000),
  };
  return text(clip(JSON.stringify(out, null, 2)));
}

async function send(cfg: GmailConfig, args: Record<string, unknown>, ctx?: McpCallContext): Promise<McpToolResult> {
  const to = String(args.to ?? '').trim();
  const subject = String(args.subject ?? '').trim();
  const body = String(args.body ?? '');
  if (!to) return text('Error: to (recipient) is required.', true);
  if (!subject && !body) return text('Error: provide at least a subject or a body.', true);
  const attachments = resolveAttachments(args, ctx);
  const mime = buildMime({ to, cc: args.cc ? String(args.cc) : undefined, bcc: args.bcc ? String(args.bcc) : undefined, subject, body, html: args.html === true, attachments });
  const payload: Record<string, unknown> = { raw: Buffer.from(mime, 'utf8').toString('base64url') };
  if (args.threadId) payload.threadId = String(args.threadId);
  const res = await gmailApi(cfg, 'POST', '/messages/send', payload);
  const att = attachments.length ? ` with ${attachments.length} attachment(s)` : '';
  return text(`Sent${att}. Message id ${res.id}${res.threadId ? `, thread ${res.threadId}` : ''}.`);
}

async function listLabels(cfg: GmailConfig): Promise<McpToolResult> {
  const data = await gmailApi(cfg, 'GET', '/labels');
  const labels = ((data.labels ?? []) as any[]).map((l) => `• ${l.name}  (${l.id}, ${l.type})`);
  return text(labels.length ? clip(labels.join('\n')) : 'No labels.');
}

const SETUP = [
  "Gmail's API uses OAuth 2.0. Create an OAuth client and generate a long-lived **refresh token** once:",
  '',
  '1. In a **Google Cloud project**, enable the **Gmail API**, then **APIs & Services → Credentials → Create OAuth client ID** (type **Desktop app**). Copy the **Client ID** and **Client Secret**.',
  '2. Do the OAuth consent **once** with the scopes `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.send` (add `gmail.modify` if you want to mark/label). The [OAuth Playground](https://developers.google.com/oauthplayground/) (gear → *Use your own OAuth credentials*) is the easiest way — authorize, then exchange for a **refresh token**.',
  '3. Copy the **refresh token** from the response.',
  '',
  'Then set: **Client ID**, **Client Secret** and **Refresh Token**. Kravn refreshes access tokens automatically. Sending mail is a mutating action — consider putting `gmail_send` behind the approval gate.',
].join('\n');

export function gmailPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: GMAIL_ID,
      name: 'Gmail',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Read and send email over the Gmail API — search/read messages and send mail (incl. replying into a ' +
        'thread), so an assistant can e.g. email a summary when a task finishes. OAuth 2.0 (client id/secret + ' +
        'refresh token). `gmail_send` is a mutating action — gate it if needed.',
      author: 'Kravn',
      priority: 100,
      setup: SETUP,
      configSchema: {
        type: 'object',
        properties: {
          clientId: { type: 'string', title: 'Client ID', description: 'Google OAuth client ID.' },
          clientSecret: { type: 'string', title: 'Client Secret', description: 'Google OAuth client secret.', secret: true },
          refreshToken: { type: 'string', title: 'Refresh Token', description: 'OAuth refresh token (scopes gmail.readonly + gmail.send).', secret: true },
        },
        required: ['clientId', 'clientSecret', 'refreshToken'],
      },
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args, config, ctx): Promise<McpToolResult> {
        try {
          const cfg = readConfig(config);
          switch (name) {
            case 'gmail_search':
              return await search(cfg, args);
            case 'gmail_get_message':
              return await getMessage(cfg, args);
            case 'gmail_send':
              return await send(cfg, args, ctx);
            case 'gmail_list_labels':
              return await listLabels(cfg);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Gmail request failed.', true);
        }
      },
    },
  };
}
