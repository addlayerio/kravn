import { createHash } from 'node:crypto';
import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native Outlook / Exchange Online plugin — read AND send mail over Microsoft Graph (no external runner, no SDK).
 *
 * Tools: search/read messages, read a full message, **send**, and reply/reply-all. Sending is a mutating action —
 * put `outlook_send_mail`/`outlook_reply` behind Kravn's approval gate if you want a human to confirm.
 *
 * Auth is the same **app-only** Microsoft Graph flow as the SharePoint/Teams plugins: an Entra app registration
 * (tenant + client id + client **secret**, `secret: true` → encrypted at rest) with **application** permissions
 * `Mail.Read` + `Mail.Send` (admin-consented). Because app-only tokens have no signed-in user, every call targets
 * a specific mailbox (`mailbox` = the user's email/UPN; configurable default, overridable per call). Scope the
 * app to specific mailboxes with an Exchange **Application Access Policy** if you don't want it to reach all of
 * them. Hosts are fixed Microsoft endpoints (no user-supplied URL → no SSRF).
 */
export const OUTLOOK_ID = 'kravn-outlook';

class OutlookError extends Error {}

interface OutlookConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailbox: string;
}

const MAILBOX_RE = /^[A-Za-z0-9._%+\-@]{1,320}$/; // email/UPN or GUID; encodeURIComponent'd in the path regardless

function clip(s: string, max = 8000): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}
function readConfig(config: Record<string, unknown>): OutlookConfig {
  const tenantId = String(config.tenantId ?? '').trim();
  const clientId = String(config.clientId ?? '').trim();
  const clientSecret = String(config.clientSecret ?? '').trim();
  const mailbox = String(config.mailbox ?? '').trim();
  if (!tenantId || !clientId || !clientSecret) {
    throw new OutlookError('Outlook is not configured. Set the Entra Tenant ID, Client ID and Client Secret of an app with Mail.Read + Mail.Send application permissions.');
  }
  return { tenantId, clientId, clientSecret, mailbox };
}
function reqMailbox(cfg: OutlookConfig, arg?: unknown): string {
  const mb = String(arg || cfg.mailbox || '').trim();
  if (!MAILBOX_RE.test(mb)) throw new OutlookError('A valid mailbox (email/UPN) is required — configure a default or pass one.');
  return encodeURIComponent(mb);
}

// App-only access tokens (~1h) cached per tenant+client (+secret hash so a different secret can't reuse a token).
const tokenCache = new Map<string, { token: string; exp: number }>();

async function getToken(cfg: OutlookConfig): Promise<string> {
  const secretHash = createHash('sha256').update(cfg.clientSecret).digest('hex').slice(0, 16);
  const key = `${cfg.tenantId}:${cfg.clientId}:${secretHash}`;
  const cached = tokenCache.get(key);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  let res: Response;
  try {
    res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new OutlookError(`Could not reach Microsoft Entra: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) throw new OutlookError(`Microsoft sign-in failed: ${body.error_description || `HTTP ${res.status}`}`);
  tokenCache.set(key, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

async function graph(cfg: OutlookConfig, method: 'GET' | 'POST', path: string, jsonBody?: unknown): Promise<any> {
  const token = await getToken(cfg);
  let res: Response;
  try {
    res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(jsonBody ? { 'content-type': 'application/json' } : {}) },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new OutlookError(`Could not reach Microsoft Graph: ${(err as Error).message}`);
  }
  if (res.status === 404) throw new OutlookError('Not found (check the mailbox / message id).');
  const data = (await res.json().catch(() => ({}))) as any; // sendMail returns 202 with no body
  if (!res.ok) throw new OutlookError(clip(data?.error?.message || `Graph HTTP ${res.status}`, 800));
  return data;
}

function recipients(v: unknown): { emailAddress: { address: string } }[] {
  return String(v ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

// ─── Tools ──────────────────────────────────────────────────────────────────────────────────────────

const TOOLS: McpToolDef[] = [
  {
    name: 'outlook_list_messages',
    description:
      'List/search messages in a mailbox (from, subject, received date, preview + id). Optional `query` (free-text ' +
      'search over the mailbox), `folder` (well-known name like inbox, sentitems, drafts — default inbox), ' +
      '`top` (default 20, max 100), and `mailbox` (override the default).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional free-text search.' },
        folder: { type: 'string', description: 'Mail folder (well-known name, default inbox).' },
        top: { type: 'number', description: 'Max messages (default 20, max 100).' },
        mailbox: { type: 'string', description: 'Mailbox email/UPN (defaults to the configured one).' },
      },
    },
  },
  {
    name: 'outlook_get_message',
    description: 'Read a full message by id (headers + body). Returns its conversationId too.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The message id (from outlook_list_messages).' },
        mailbox: { type: 'string', description: 'Mailbox email/UPN (defaults to the configured one).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'outlook_send_mail',
    description:
      'Send an email from the mailbox. `to` is a comma-separated recipient list; optional `cc`/`bcc`. `html` = ' +
      'true for an HTML body. Optional `mailbox` override. NOTE: this sends real mail — a mutating action.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Comma-separated recipient addresses.' },
        subject: { type: 'string', description: 'Email subject.' },
        body: { type: 'string', description: 'Email body (plain text, or HTML if html=true).' },
        cc: { type: 'string', description: 'Optional comma-separated CC.' },
        bcc: { type: 'string', description: 'Optional comma-separated BCC.' },
        html: { type: 'boolean', description: 'Send the body as HTML (default false).' },
        mailbox: { type: 'string', description: 'Sending mailbox email/UPN (defaults to the configured one).' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'outlook_reply',
    description:
      'Reply to a message by id with a comment. Set `replyAll` = true to reply to everyone. NOTE: this sends real mail.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The message id to reply to.' },
        comment: { type: 'string', description: 'Your reply text.' },
        replyAll: { type: 'boolean', description: 'Reply to all recipients (default false).' },
        mailbox: { type: 'string', description: 'Mailbox email/UPN (defaults to the configured one).' },
      },
      required: ['id', 'comment'],
    },
  },
  {
    name: 'outlook_list_folders',
    description: 'List the mailbox mail folders (name + id + unread/total counts) — useful to pick a folder for outlook_list_messages.',
    inputSchema: {
      type: 'object',
      properties: { mailbox: { type: 'string', description: 'Mailbox email/UPN (defaults to the configured one).' } },
    },
  },
];

async function listMessages(cfg: OutlookConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const mb = reqMailbox(cfg, args.mailbox);
  const top = Math.min(100, Math.max(1, Number(args.top) || 20));
  const folder = String(args.folder ?? '').trim();
  const base = folder ? `/users/${mb}/mailFolders/${encodeURIComponent(folder)}/messages` : `/users/${mb}/messages`;
  const p = new URLSearchParams();
  p.set('$select', 'id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead');
  p.set('$top', String(top));
  if (args.query) p.set('$search', `"${String(args.query).replace(/"/g, '')}"`);
  else p.set('$orderby', 'receivedDateTime desc');
  const data = await graph(cfg, 'GET', `${base}?${p}`);
  const rows = ((data.value ?? []) as any[]).map((m) => ({
    id: m.id,
    from: m.from?.emailAddress?.address,
    subject: m.subject,
    received: m.receivedDateTime,
    isRead: m.isRead,
    preview: m.bodyPreview,
  }));
  return text(rows.length ? `${rows.length} message(s):\n\n${clip(JSON.stringify(rows, null, 2))}` : 'No messages match.');
}

async function getMessage(cfg: OutlookConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const mb = reqMailbox(cfg, args.mailbox);
  const id = String(args.id ?? '').trim();
  if (!id) return text('Error: id is required.', true);
  const m = await graph(cfg, 'GET', `/users/${mb}/messages/${encodeURIComponent(id)}?$select=id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,body`);
  const out = {
    id: m.id,
    conversationId: m.conversationId,
    from: m.from?.emailAddress?.address,
    to: (m.toRecipients ?? []).map((r: any) => r.emailAddress?.address),
    cc: (m.ccRecipients ?? []).map((r: any) => r.emailAddress?.address),
    subject: m.subject,
    received: m.receivedDateTime,
    body: clip(String(m.body?.content ?? ''), 12_000),
  };
  return text(clip(JSON.stringify(out, null, 2)));
}

async function sendMail(cfg: OutlookConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const mb = reqMailbox(cfg, args.mailbox);
  const to = recipients(args.to);
  if (!to.length) return text('Error: to (at least one recipient) is required.', true);
  const message: Record<string, unknown> = {
    subject: String(args.subject ?? ''),
    body: { contentType: args.html === true ? 'HTML' : 'Text', content: String(args.body ?? '') },
    toRecipients: to,
  };
  const cc = recipients(args.cc);
  const bcc = recipients(args.bcc);
  if (cc.length) message.ccRecipients = cc;
  if (bcc.length) message.bccRecipients = bcc;
  await graph(cfg, 'POST', `/users/${mb}/sendMail`, { message, saveToSentItems: true });
  return text(`Sent to ${to.map((r) => r.emailAddress.address).join(', ')}.`);
}

async function reply(cfg: OutlookConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const mb = reqMailbox(cfg, args.mailbox);
  const id = String(args.id ?? '').trim();
  const comment = String(args.comment ?? '');
  if (!id) return text('Error: id is required.', true);
  const action = args.replyAll === true ? 'replyAll' : 'reply';
  await graph(cfg, 'POST', `/users/${mb}/messages/${encodeURIComponent(id)}/${action}`, { comment });
  return text(`Replied${args.replyAll === true ? ' to all' : ''}.`);
}

async function listFolders(cfg: OutlookConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const mb = reqMailbox(cfg, args.mailbox);
  const data = await graph(cfg, 'GET', `/users/${mb}/mailFolders?$top=100&$select=id,displayName,unreadItemCount,totalItemCount`);
  const rows = ((data.value ?? []) as any[]).map((f) => `• ${f.displayName}  (${f.unreadItemCount}/${f.totalItemCount} unread)  —  id: ${f.id}`);
  return text(rows.length ? clip(rows.join('\n')) : 'No folders.');
}

const SETUP = [
  'Outlook / Exchange Online uses **app-only Microsoft Graph** (same as the SharePoint/Teams plugins). Once:',
  '',
  '1. **Entra ID → App registrations → New registration** (or reuse one). Copy the **Application (client) ID** and **Directory (tenant) ID**.',
  '2. **Certificates & secrets → New client secret** — copy the value.',
  '3. **API permissions → Add → Microsoft Graph → Application permissions**: add **Mail.Read** and **Mail.Send** (add **Mail.ReadWrite** only if you need it), then **Grant admin consent**.',
  '4. (Recommended) Scope the app to just the mailboxes it should touch with an Exchange **Application Access Policy** (`New-ApplicationAccessPolicy`) — otherwise app-only can reach every mailbox.',
  '',
  'Then set: **Tenant ID**, **Client ID**, **Client Secret** and a default **Mailbox** (the user email/UPN to read & send as; overridable per call). Sending is a mutating action — consider putting `outlook_send_mail`/`outlook_reply` behind the approval gate.',
].join('\n');

export function outlookPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: OUTLOOK_ID,
      name: 'Outlook',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Read and send email over Microsoft 365 / Exchange Online (Microsoft Graph) — search/read messages, ' +
        'send, and reply/reply-all, so an assistant can e.g. email a summary when a task finishes. App-only ' +
        'Graph auth (Mail.Read + Mail.Send). Sending is a mutating action — gate it if needed.',
      author: 'Kravn',
      priority: 100,
      setup: SETUP,
      configSchema: {
        type: 'object',
        properties: {
          tenantId: { type: 'string', title: 'Tenant ID', description: 'Entra tenant (GUID or domain).' },
          clientId: { type: 'string', title: 'Client ID', description: 'App registration (application) ID.' },
          clientSecret: { type: 'string', title: 'Client Secret', description: 'App registration client secret.', secret: true },
          mailbox: { type: 'string', title: 'Mailbox', description: 'Default mailbox to read & send as (user email/UPN). Overridable per call.' },
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
            case 'outlook_list_messages':
              return await listMessages(cfg, args);
            case 'outlook_get_message':
              return await getMessage(cfg, args);
            case 'outlook_send_mail':
              return await sendMail(cfg, args);
            case 'outlook_reply':
              return await reply(cfg, args);
            case 'outlook_list_folders':
              return await listFolders(cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Outlook request failed.', true);
        }
      },
    },
  };
}
