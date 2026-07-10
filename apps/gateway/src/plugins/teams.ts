import { createHash } from 'node:crypto';
import type { McpServerPlugin, McpToolResult, McpToolDef, McpContent } from '@kravn/plugin-sdk';
import { htmlToMarkdown } from '../lib/html.js';

/**
 * Native Microsoft Teams plugin — talk to Teams over MCP via the Microsoft Graph API.
 *
 * Teams has no MCP server of its own, so (exactly like the SharePoint plugin) this reimplements the
 * capability in-process on top of Microsoft Graph using the **app-only** (client-credentials) flow: an Entra
 * app registration with Application permissions — config is the tenant id, client id and client secret (the
 * secret is stored encrypted; see PluginManager). Read-only tools: find a person, find/list/read chats
 * (optionally scoped to a date range) and list teams/channels + read channel posts. Message HTML bodies are
 * reduced to Markdown (shared lib/html.ts) so they cost far fewer tokens than raw Teams HTML.
 *
 * Hardening: the Graph host is fixed (no caller-supplied base URL → no SSRF surface like the Jira plugin's
 * baseUrl); every id that goes into a Graph path is encodeURIComponent'd; pagination only follows an
 * `@odata.nextLink` that is itself on graph.microsoft.com, so a crafted response can't exfiltrate the bearer
 * token to another host; each request has a timeout; the token cache key includes a hash of the secret (a
 * different secret never reuses another config's token); and message counts + total output are capped.
 */
export const TEAMS_ID = 'kravn-teams';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_PREFIX = 'https://graph.microsoft.com/';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 60_000;
const MAX_IMAGE_BYTES = 5_000_000; // skip a hosted image larger than this (keeps tool results sane)

const TEAMS_SETUP = [
  'This plugin talks to **Microsoft Graph** with an app-only (client-credentials) **Entra ID** app registration. Set it up in the Azure / Entra admin center:',
  '',
  '1. `Entra ID → App registrations → New registration`. Name it (e.g. "Kravn Teams"), leave the redirect URI empty, and **Register**.',
  '2. On **Overview**, copy the **Application (client) ID** and the **Directory (tenant) ID**.',
  '3. `Certificates & secrets → New client secret`. Copy the secret **value** immediately (shown only once).',
  '4. `API permissions → Add a permission → Microsoft Graph → Application permissions`, and add:',
  '   - `Team.ReadBasic.All` — list teams',
  '   - `Channel.ReadBasic.All` — list channels',
  '   - `ChannelMessage.Read.All` — read channel posts',
  '   - `Chat.Read.All` — list and read chats',
  "   - `User.Read.All` — find people, list a user's teams/chats",
  '   - `Files.Read.All` *(optional)* — to download image **file attachments** shared in a message (inline pasted images work without this)',
  '5. Click **Grant admin consent** for the tenant (a Global Administrator must approve).',
  '',
  'All permissions are **read-only** — no write access is requested. Then enter the **Tenant ID**, **Client ID** and **Client Secret** below (the secret is stored encrypted).',
].join('\n');

interface TeamsConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

class TeamsError extends Error {}

function readConfig(config: Record<string, unknown>): TeamsConfig {
  const tenantId = String(config.tenantId ?? '').trim();
  const clientId = String(config.clientId ?? '').trim();
  const clientSecret = String(config.clientSecret ?? '').trim();
  if (!tenantId || !clientId || !clientSecret) {
    throw new TeamsError(
      'Teams is not configured. Set Tenant ID, Client ID and Client Secret in the plugin config (an Entra app ' +
        'registration with Application permissions Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Read.All, ' +
        'Chat.Read.All, User.Read.All — admin-consented).',
    );
  }
  return { tenantId, clientId, clientSecret };
}

// App-only access tokens (~1h) cached per tenant+client+secret-hash. Including a hash of the secret means a
// config that supplies a different (or blank) secret can never be handed a token minted from another one.
const tokenCache = new Map<string, { token: string; exp: number }>();

async function getToken(cfg: TeamsConfig): Promise<string> {
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
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new TeamsError(`Microsoft sign-in failed: ${body.error_description || `HTTP ${res.status}`}`);
  }
  tokenCache.set(key, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

/**
 * GET from Graph. Accepts a relative path (prefixed with the v1.0 base) or an absolute URL (an
 * `@odata.nextLink`) — but the resolved URL MUST be on graph.microsoft.com, so the bearer token can never be
 * sent to a host injected via a crafted nextLink. `redirect: 'error'` refuses any redirect off Graph.
 */
async function graphGet(cfg: TeamsConfig, pathOrUrl: string, headers?: Record<string, string>): Promise<any> {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  if (!url.startsWith(GRAPH_PREFIX)) throw new TeamsError('Refusing to call a non-Graph URL.');
  const token = await getToken(cfg);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, ...(headers ?? {}) },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404) throw new TeamsError('Not found (check the team / channel / chat / user id).');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message || `Graph HTTP ${res.status}`;
    throw new TeamsError(msg);
  }
  return data;
}

/** Fetch BINARY content from Graph (e.g. a message's hosted image `/$value`). Same host hardening as graphGet:
 *  the resolved URL must be on graph.microsoft.com and no redirect is followed, so the bearer can't leak. */
async function graphBytes(cfg: TeamsConfig, pathOrUrl: string): Promise<{ buf: Buffer; contentType: string }> {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  if (!url.startsWith(GRAPH_PREFIX)) throw new TeamsError('Refusing to call a non-Graph URL.');
  const token = await getToken(cfg);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 404) throw new TeamsError('Hosted content not found.');
  if (!res.ok) throw new TeamsError(`Graph HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType: res.headers.get('content-type') || 'application/octet-stream' };
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i;

/** Encode a sharing URL as a Graph `shares` id, to resolve a shared file (a Teams file attachment's contentUrl)
 *  to its driveItem. Per the shares API: `u!` + base64url(url). */
function encodeShareId(url: string): string {
  return 'u!' + Buffer.from(url, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

/** Fetch a pre-authenticated download URL (a driveItem's `@microsoft.graph.downloadUrl`). No bearer is sent —
 *  the URL is already signed and came from a trusted Graph response — so this can never leak the token; timed. */
async function downloadUrlBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new TeamsError(`Download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Page through a Graph collection, following only same-host nextLinks, up to `maxItems` (and a page cap). */
async function graphPaged(cfg: TeamsConfig, path: string, maxItems: number, headers?: Record<string, string>): Promise<any[]> {
  const items: any[] = [];
  let url: string | null = path;
  let pages = 0;
  while (url && items.length < maxItems && pages < 25) {
    const page = await graphGet(cfg, url, headers);
    if (Array.isArray(page?.value)) items.push(...page.value);
    pages++;
    const next = page?.['@odata.nextLink'];
    url = typeof next === 'string' && next.startsWith(GRAPH_PREFIX) ? next : null;
  }
  return items.slice(0, maxItems);
}

/**
 * Page through a message collection (Graph returns messages newest-first) collecting up to `limit` messages
 * within the optional [since, until] window. Stops early once a page dips below `since` — no older page can
 * be in range — so scoping to "yesterday" doesn't walk the whole history.
 */
async function pagedMessages(cfg: TeamsConfig, path: string, limit: number, since: number | null, until: number | null): Promise<any[]> {
  const out: any[] = [];
  let url: string | null = path;
  let pages = 0;
  while (url && out.length < limit && pages < 25) {
    const page = await graphGet(cfg, url);
    const items: any[] = Array.isArray(page?.value) ? page.value : [];
    let dippedBelowSince = false;
    for (const m of items) {
      const t = new Date(m?.createdDateTime ?? 0).getTime();
      const ts = Number.isNaN(t) ? null : t;
      if (since !== null && ts !== null && ts < since) { dippedBelowSince = true; continue; }
      if (until !== null && ts !== null && ts > until) continue; // newer than the window — skip, keep paging
      out.push(m);
      if (out.length >= limit) break;
    }
    if (dippedBelowSince) break; // reached messages older than `since`; every later page is older still
    pages++;
    const next = page?.['@odata.nextLink'];
    url = typeof next === 'string' && next.startsWith(GRAPH_PREFIX) ? next : null;
  }
  return out.slice(0, limit);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────

function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}

const clamp = (n: unknown, min: number, max: number, def: number): number => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : def;
};

function cap(t: string): string {
  return t.length <= MAX_OUTPUT_CHARS ? t : t.slice(0, MAX_OUTPUT_CHARS) + `\n\n[…truncated — output exceeded ${MAX_OUTPUT_CHARS.toLocaleString()} characters]`;
}

/** Parse an ISO date/datetime bound; null if absent; throws (→ tool error) on an invalid value. */
function parseBound(v: unknown, label: string): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) throw new TeamsError(`Invalid "${label}" date "${s}" — use ISO 8601, e.g. 2026-07-02 or 2026-07-02T00:00:00Z.`);
  return t;
}

function rangeLabel(since: number | null, until: number | null): string {
  const parts: string[] = [];
  if (since !== null) parts.push(`since ${new Date(since).toISOString()}`);
  if (until !== null) parts.push(`until ${new Date(until).toISOString()}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function chatName(chat: any): string {
  if (chat?.topic) return String(chat.topic);
  const members = (chat?.members ?? []).map((m: any) => m?.displayName).filter(Boolean);
  return members.length ? members.join(', ') : String(chat?.chatType ?? 'chat');
}

/** A message body → plain text: HTML bodies reduced to Markdown (fewer tokens), text bodies as-is. */
function renderBody(msg: any): string {
  const content = String(msg?.body?.content ?? '');
  if (!content.trim()) return '';
  return msg?.body?.contentType === 'html' ? htmlToMarkdown(content) : content.trim();
}

/** Distinct hosted-content ids referenced by a message body — Teams inline images (pasted screenshots etc.). */
function hostedImageIds(msg: any): string[] {
  const content = String(msg?.body?.content ?? '');
  const ids = [...content.matchAll(/hostedContents\/([^/'"\\)>\s]+)\/\$value/g)].map((m) => m[1]);
  return [...new Set(ids)];
}

/** Build a readable, chronological transcript from Graph chat/channel messages. */
function transcript(messages: any[]): string {
  const at = (v: unknown): number => {
    const t = new Date((v as string) ?? 0).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  const ordered = [...messages].sort((a, b) => at(a?.createdDateTime) - at(b?.createdDateTime));
  const lines: string[] = [];
  for (const m of ordered) {
    if (m?.messageType && m.messageType !== 'message') {
      lines.push(`— [${m.createdDateTime ?? ''}] (system: ${m.messageType})`);
      continue;
    }
    const author = m?.from?.user?.displayName || m?.from?.application?.displayName || '(unknown)';
    const body = renderBody(m);
    const attachments = (m?.attachments ?? []).map((a: any) => a?.name || a?.contentType).filter(Boolean);
    lines.push(`[${m?.createdDateTime ?? ''}] ${author}:`);
    if (body) lines.push(body);
    if (attachments.length) lines.push(`  📎 ${attachments.join(', ')}`);
    const inlineImgs = hostedImageIds(m);
    const imgAttach = (m?.attachments ?? []).filter((a: any) => IMG_EXT.test(String(a?.name || '')));
    if (inlineImgs.length || imgAttach.length) {
      const parts: string[] = [];
      if (inlineImgs.length) parts.push(`${inlineImgs.length} inline`);
      if (imgAttach.length) parts.push(`${imgAttach.length} attached`);
      lines.push(`  🖼️ ${parts.join(' + ')} image(s) — view with teams_get_message_images (messageId="${m?.id ?? ''}")`);
    }
    if (m?.deletedDateTime) lines.push('  (deleted)');
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Tools ─────────────────────────────────────────────────────────────────────────────────────

const TOOLS: McpToolDef[] = [
  {
    name: 'teams_find_user',
    description:
      'Find people by name, email or UPN (fuzzy). Use this FIRST to resolve a display name into the email/id ' +
      'the other tools need. Returns each match\'s display name, job title, email/UPN and id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A name, email or UPN to search for.' },
        limit: { type: 'number', description: 'Max results (default 10, max 25).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'teams_find_chat',
    description:
      'Find the Teams chat(s) shared by two people — e.g. the 1:1 between them — so you can then read it. ' +
      'Each user is a UPN/email or object id (resolve names first with teams_find_user). Returns matching chatIds.',
    inputSchema: {
      type: 'object',
      properties: {
        userA: { type: 'string', description: 'First user — UPN/email or object id.' },
        userB: { type: 'string', description: 'Second user — UPN/email or object id (matched against chat members).' },
        limit: { type: 'number', description: 'Max chats to return (default 20, max 50).' },
      },
      required: ['userA', 'userB'],
    },
  },
  {
    name: 'teams_list_chats',
    description:
      "List a user's Teams chats (1:1, group and meeting), newest first, with their members. Returns each chat's " +
      'display name, type and the chatId needed to read it. Requires a user (UPN/email or object id).',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'UPN/email or object id of the user whose chats to list.' },
        limit: { type: 'number', description: 'Max chats to return (default 30, max 100).' },
      },
      required: ['user'],
    },
  },
  {
    name: 'teams_read_chat',
    description:
      'Read a Teams chat as a chronological transcript (author, time, text). Pass since/until (ISO dates) to scope ' +
      'to a period, e.g. yesterday. HTML message bodies are reduced to Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'Chat id (from teams_find_chat / teams_list_chats).' },
        since: { type: 'string', description: 'Only messages at/after this ISO date-time (e.g. 2026-07-02 or 2026-07-02T00:00:00Z).' },
        until: { type: 'string', description: 'Only messages at/before this ISO date-time.' },
        limit: { type: 'number', description: 'Max messages (default 40, max 100).' },
      },
      required: ['chatId'],
    },
  },
  {
    name: 'teams_list_teams',
    description:
      'List Microsoft Teams. With no arguments, lists teams across the org; pass a user (UPN/email or object id) ' +
      'to list only the teams that user belongs to. Optional case-insensitive name filter. Returns each team name ' +
      'and the teamId needed to list its channels.',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'Optional UPN/email or object id — lists only this user\'s teams.' },
        search: { type: 'string', description: 'Optional case-insensitive team-name filter.' },
        limit: { type: 'number', description: 'Max teams to return (default 30, max 100).' },
      },
    },
  },
  {
    name: 'teams_list_channels',
    description: 'List the channels of a team. Returns each channel name and the channelId needed to read its messages.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Team id (from teams_list_teams).' },
        search: { type: 'string', description: 'Optional case-insensitive channel-name filter.' },
        limit: { type: 'number', description: 'Max channels to return (default 50, max 100).' },
      },
      required: ['teamId'],
    },
  },
  {
    name: 'teams_read_channel_messages',
    description:
      'Read the most recent top-level posts in a team channel, as a chronological transcript (author, time, text). ' +
      'Pass since/until (ISO dates) to scope to a period. HTML bodies are reduced to Markdown; threaded replies are not included.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Team id.' },
        channelId: { type: 'string', description: 'Channel id (from teams_list_channels).' },
        since: { type: 'string', description: 'Only messages at/after this ISO date-time.' },
        until: { type: 'string', description: 'Only messages at/before this ISO date-time.' },
        limit: { type: 'number', description: 'Max messages (default 30, max 100).' },
      },
      required: ['teamId', 'channelId'],
    },
  },
  {
    name: 'teams_get_message_images',
    description:
      "Fetch a Teams message's images so they can be viewed — both INLINE images (pasted into the message body) " +
      'and image FILE attachments (a screenshot shared as a file). The read tools flag these with a 🖼️ hint; pass ' +
      'its `messageId` and EITHER `chatId` (chat) OR `teamId`+`channelId` (channel). Images over 5 MB are skipped. ' +
      '(Fetching file attachments needs Files.Read.All on the app; inline pasted images do not.)',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'The message id (from the 🖼️ hint in a transcript).' },
        chatId: { type: 'string', description: 'Chat id — for a chat message.' },
        teamId: { type: 'string', description: 'Team id — for a channel message (with channelId).' },
        channelId: { type: 'string', description: 'Channel id — for a channel message (with teamId).' },
        limit: { type: 'number', description: 'Max images to return (default 5, max 10).' },
      },
      required: ['messageId'],
    },
  },
];

async function findUser(cfg: TeamsConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query ?? '').replace(/["\\]/g, ' ').trim();
  if (!q) return text('Error: query (a name, email or UPN) is required.', true);
  const limit = clamp(args.limit, 1, 25, 10);
  const expr = encodeURIComponent(`"displayName:${q}" OR "mail:${q}" OR "userPrincipalName:${q}"`);
  const path = `/users?$search=${expr}&$select=id,displayName,mail,userPrincipalName,jobTitle&$top=${limit}&$count=true`;
  const users = await graphPaged(cfg, path, limit, { ConsistencyLevel: 'eventual' });
  if (!users.length) return text(`No users matched "${q}".`);
  const lines = users.map((u: any) => `• ${u?.displayName || '(user)'}${u?.jobTitle ? ` — ${u.jobTitle}` : ''}\n  ${u?.mail || u?.userPrincipalName || ''}  id=${u?.id ?? ''}`);
  return text(cap(`Users matching "${q}":\n\n${lines.join('\n')}`));
}

async function findChat(cfg: TeamsConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const userA = String(args.userA ?? '').trim();
  const userB = String(args.userB ?? '').trim();
  if (!userA || !userB) return text('Error: userA and userB (UPN/email or object id) are required.', true);
  const limit = clamp(args.limit, 1, 50, 20);
  const chats = await graphPaged(cfg, `/users/${encodeURIComponent(userA)}/chats?$expand=members&$top=50`, 200);
  const needle = userB.toLowerCase();
  const matches = chats.filter((c: any) =>
    (c?.members ?? []).some((m: any) => {
      const email = String(m?.email ?? '').toLowerCase();
      const uid = String(m?.userId ?? '').toLowerCase();
      const name = String(m?.displayName ?? '').toLowerCase();
      return email === needle || uid === needle || (needle.length >= 3 && name.includes(needle));
    }),
  );
  if (!matches.length) return text(`No chat found between "${userA}" and "${userB}".`);
  const shown = matches.slice(0, limit);
  const lines = shown.map((c: any) => `• ${chatName(c)} [${c?.chatType ?? 'chat'}]\n  chatId=${c?.id ?? ''}`);
  return text(cap(`Chats shared by "${userA}" and "${userB}":\n\n${lines.join('\n')}\n\nRead one with teams_read_chat (add since/until to scope by date).`));
}

async function listChats(cfg: TeamsConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const user = String(args.user ?? '').trim();
  if (!user) return text('Error: user (UPN/email or object id) is required.', true);
  const limit = clamp(args.limit, 1, 100, 30);
  const chats = await graphPaged(cfg, `/users/${encodeURIComponent(user)}/chats?$expand=members&$top=50`, limit);
  if (!chats.length) return text('No chats found for this user.');
  const lines = chats.map((c: any) => `• ${chatName(c)} [${c?.chatType ?? 'chat'}]${c?.lastUpdatedDateTime ? ` — updated ${c.lastUpdatedDateTime}` : ''}\n  chatId=${c?.id ?? ''}`);
  return text(cap(`Chats for ${user}:\n\n${lines.join('\n')}`));
}

async function readChat(cfg: TeamsConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const chatId = String(args.chatId ?? '').trim();
  if (!chatId) return text('Error: chatId is required.', true);
  const limit = clamp(args.limit, 1, 100, 40);
  const since = parseBound(args.since, 'since');
  const until = parseBound(args.until, 'until');
  const msgs = await pagedMessages(cfg, `/chats/${encodeURIComponent(chatId)}/messages?$top=50`, limit, since, until);
  if (!msgs.length) return text(`No messages in this chat${rangeLabel(since, until)}.`);
  return text(cap(`# Chat transcript (${msgs.length} messages${rangeLabel(since, until)})\n\n${transcript(msgs)}`));
}

async function listTeams(cfg: TeamsConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const user = String(args.user ?? '').trim();
  const search = String(args.search ?? '').trim().toLowerCase();
  const limit = clamp(args.limit, 1, 100, 30);
  const path = user ? `/users/${encodeURIComponent(user)}/joinedTeams?$top=50` : `/teams?$top=50`;
  let teams = await graphPaged(cfg, path, 300);
  if (search) teams = teams.filter((t: any) => String(t?.displayName ?? '').toLowerCase().includes(search));
  const shown = teams.slice(0, limit);
  if (!shown.length) return text(search ? `No teams matched "${String(args.search)}".` : 'No teams found.');
  const lines = shown.map((t: any) => `• ${t?.displayName || '(team)'}${t?.description ? ` — ${t.description}` : ''}\n  teamId=${t?.id ?? ''}`);
  const more = teams.length > shown.length ? `\n\n(${teams.length - shown.length} more not shown — refine with search or raise limit.)` : '';
  return text(cap(`Teams:\n\n${lines.join('\n')}${more}`));
}

async function listChannels(cfg: TeamsConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const teamId = String(args.teamId ?? '').trim();
  if (!teamId) return text('Error: teamId is required.', true);
  const search = String(args.search ?? '').trim().toLowerCase();
  const limit = clamp(args.limit, 1, 100, 50);
  let channels = await graphPaged(cfg, `/teams/${encodeURIComponent(teamId)}/channels`, 200);
  if (search) channels = channels.filter((c: any) => String(c?.displayName ?? '').toLowerCase().includes(search));
  const shown = channels.slice(0, limit);
  if (!shown.length) return text('No channels found.');
  const lines = shown.map((c: any) => `• ${c?.displayName || '(channel)'}${c?.description ? ` — ${c.description}` : ''}\n  channelId=${c?.id ?? ''}`);
  return text(cap(`Channels:\n\n${lines.join('\n')}`));
}

async function readChannelMessages(cfg: TeamsConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const teamId = String(args.teamId ?? '').trim();
  const channelId = String(args.channelId ?? '').trim();
  if (!teamId || !channelId) return text('Error: teamId and channelId are required.', true);
  const limit = clamp(args.limit, 1, 100, 30);
  const since = parseBound(args.since, 'since');
  const until = parseBound(args.until, 'until');
  const msgs = await pagedMessages(cfg, `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=50`, limit, since, until);
  if (!msgs.length) return text(`No messages in this channel${rangeLabel(since, until)}.`);
  return text(cap(`# Channel messages (${msgs.length}${rangeLabel(since, until)})\n\n${transcript(msgs)}`));
}

async function getMessageImages(cfg: TeamsConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const messageId = String(args.messageId ?? '').trim();
  if (!messageId) return text('Error: messageId is required.', true);
  const chatId = String(args.chatId ?? '').trim();
  const teamId = String(args.teamId ?? '').trim();
  const channelId = String(args.channelId ?? '').trim();
  let base: string;
  if (chatId) base = `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`;
  else if (teamId && channelId) base = `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`;
  else return text('Error: provide chatId (for a chat) OR teamId + channelId (for a channel).', true);
  const limit = clamp(args.limit, 1, 10, 5);

  const msg = await graphGet(cfg, base);
  const content: McpContent[] = [];
  const notes: string[] = [];

  // 1) Inline images pasted into the message body (Graph "hosted contents").
  for (const id of hostedImageIds(msg)) {
    if (content.length >= limit) break;
    try {
      const { buf, contentType } = await graphBytes(cfg, `${base}/hostedContents/${encodeURIComponent(id)}/$value`);
      if (buf.length > MAX_IMAGE_BYTES) {
        notes.push('skipped a large inline image (>5 MB)');
        continue;
      }
      content.push({ type: 'image', data: buf.toString('base64'), mimeType: contentType.startsWith('image/') ? contentType : 'image/png' });
    } catch (e) {
      notes.push(`inline image: ${(e as Error).message}`);
    }
  }

  // 2) Image FILE attachments (a screenshot SHARED as a file → a SharePoint/OneDrive driveItem). Resolve the
  //    attachment's contentUrl via the shares API, then download it. Needs Files.Read.All / Sites.Read.All.
  const atts: any[] = Array.isArray(msg?.attachments) ? msg.attachments : [];
  for (const a of atts) {
    if (content.length >= limit) break;
    const url = String(a?.contentUrl ?? '');
    const name = String(a?.name ?? '');
    if (!url || !IMG_EXT.test(name)) continue; // only image files
    try {
      const item = await graphGet(cfg, `/shares/${encodeShareId(url)}/driveItem`);
      const dl = item?.['@microsoft.graph.downloadUrl'];
      const mime = String(item?.file?.mimeType ?? '');
      if (!dl) {
        notes.push(`no download URL for "${name}"`);
        continue;
      }
      if (Number(item?.size) > MAX_IMAGE_BYTES) {
        notes.push(`skipped large attachment "${name}"`);
        continue;
      }
      const buf = await downloadUrlBytes(String(dl));
      content.push({ type: 'image', data: buf.toString('base64'), mimeType: mime.startsWith('image/') ? mime : 'image/png' });
    } catch (e) {
      notes.push(`attachment "${name}": ${(e as Error).message}`);
    }
  }

  if (!content.length) {
    const hasImgAttach = atts.some((a) => IMG_EXT.test(String(a?.name || '')));
    const hint = hasImgAttach ? ' Image file-attachments need the Files.Read.All (or Sites.Read.All) permission on the Teams app.' : '';
    return text(`No images could be returned${notes.length ? ` — ${notes.join('; ')}.` : '.'}${hint}`, true);
  }
  const header = `${content.length} image(s) from the message${notes.length ? `\n(${notes.join('; ')})` : ''}`;
  return { content: [{ type: 'text', text: header }, ...content], isError: false };
}

export function teamsPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: TEAMS_ID,
      name: 'Microsoft Teams',
      version: '0.4.0',
      type: 'mcp-server',
      description:
        'Interact with Microsoft Teams over MCP via Microsoft Graph (app-only). Find people, find/list/read chats ' +
        '(scopable by a date range), list teams/channels + read channel posts, and fetch a message\'s inline ' +
        'images (pasted screenshots). Requires an Entra app registration with read-only Application permissions (see setup).',
      author: 'Kravn',
      priority: 100,
      setup: TEAMS_SETUP,
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
            case 'teams_find_user':
              return await findUser(cfg, args);
            case 'teams_find_chat':
              return await findChat(cfg, args);
            case 'teams_list_chats':
              return await listChats(cfg, args);
            case 'teams_read_chat':
              return await readChat(cfg, args);
            case 'teams_list_teams':
              return await listTeams(cfg, args);
            case 'teams_list_channels':
              return await listChannels(cfg, args);
            case 'teams_read_channel_messages':
              return await readChannelMessages(cfg, args);
            case 'teams_get_message_images':
              return await getMessageImages(cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof Error ? err.message : 'Teams request failed.', true);
        }
      },
    },
  };
}
