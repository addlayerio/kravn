import crypto from 'node:crypto';
import type { McpServerPlugin, McpToolResult, McpToolDef } from '@kravn/plugin-sdk';

/**
 * Native LinkedIn plugin — the subset of LinkedIn's OFFICIAL API that a standard app can actually use:
 *   • linkedin_me          — the authenticated member's profile (OpenID Connect `userinfo`).
 *   • linkedin_create_post — publish a post/share as the member (optionally attaching a link/article).
 *
 * Auth is LinkedIn OAuth 2.0 (3-legged): a client id + secret and a member **refresh token** the operator
 * generates once (scopes `openid profile email w_member_social`). Secret + refresh token are `secret: true`
 * → encrypted at rest; Kravn refreshes short-lived access tokens itself. Hosts are fixed LinkedIn endpoints
 * (no user-supplied URL → no SSRF); requests refuse redirects, time out and cap the body.
 *
 * NOTE on scope: LinkedIn does NOT expose profile search, others' profiles, messaging, jobs or network stats
 * to standard apps — those need Marketing/Talent/Sales partner programs — so this plugin does not fake them.
 */
export const LINKEDIN_ID = 'kravn-linkedin';

class LinkedInError extends Error {}

interface LinkedInConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  apiVersion: string;
}

const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const API = 'https://api.linkedin.com';
const DEFAULT_API_VERSION = '202505'; // LinkedIn-Version for the Posts API; bump if posting 400s on version.
const MAX_RESPONSE_BYTES = 2_000_000;

function clip(s: string, max = 6000): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}
function readConfig(config: Record<string, unknown>): LinkedInConfig {
  const clientId = String(config.clientId ?? '').trim();
  const clientSecret = String(config.clientSecret ?? '').trim();
  const refreshToken = String(config.refreshToken ?? '').trim();
  const apiVersion = String(config.apiVersion ?? '').trim() || DEFAULT_API_VERSION;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new LinkedInError('LinkedIn is not configured. Set the OAuth Client ID, Client Secret and a member Refresh Token (scopes openid profile email w_member_social).');
  }
  return { clientId, clientSecret, refreshToken, apiVersion };
}

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function getToken(cfg: LinkedInConfig, force = false): Promise<string> {
  const key = crypto.createHash('sha256').update(`${cfg.clientId}|${cfg.clientSecret}|${cfg.refreshToken}`).digest('hex');
  if (!force) {
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
  }
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cfg.refreshToken,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new LinkedInError(`Could not reach LinkedIn's token endpoint: ${(err as Error).message}`);
  }
  const body = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  try {
    data = JSON.parse(body);
  } catch {
    throw new LinkedInError(`LinkedIn token endpoint returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!data.access_token) {
    throw new LinkedInError(`LinkedIn token refresh failed: ${clip(String(data.error_description || data.error || `HTTP ${res.status}`), 400)}`);
  }
  tokenCache.set(key, { accessToken: String(data.access_token), expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  return String(data.access_token);
}

/** Low-level call. Returns the raw Response (callers read JSON or headers). Retries once on a 401. */
async function apiFetch(cfg: LinkedInConfig, method: string, url: string, opts: { body?: unknown; versioned?: boolean } = {}, retried = false): Promise<Response> {
  const token = await getToken(cfg, retried);
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.versioned) {
    headers['LinkedIn-Version'] = cfg.apiVersion;
    headers['X-Restli-Protocol-Version'] = '2.0.0';
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new LinkedInError(`Could not reach LinkedIn: ${(err as Error).message}`);
  }
  if (res.status === 401 && !retried) return apiFetch(cfg, method, url, opts, true);
  return res;
}

async function apiJson(cfg: LinkedInConfig, method: string, url: string, opts: { body?: unknown; versioned?: boolean } = {}): Promise<any> {
  const res = await apiFetch(cfg, method, url, opts);
  const bodyText = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  let data: any = {};
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    if (!res.ok) throw new LinkedInError(`LinkedIn error (HTTP ${res.status}).`);
    return {};
  }
  if (!res.ok) {
    const msg = data?.message || data?.error_description || data?.error || `HTTP ${res.status}`;
    throw new LinkedInError(clip(`LinkedIn error: ${msg}`, 800));
  }
  return data;
}

async function getMe(cfg: LinkedInConfig): Promise<McpToolResult> {
  const me = await apiJson(cfg, 'GET', `${API}/v2/userinfo`);
  const lines = [
    me.name ? `Name: ${me.name}` : null,
    me.email ? `Email: ${me.email}` : null,
    me.locale ? `Locale: ${typeof me.locale === 'object' ? `${me.locale.language}-${me.locale.country}` : me.locale}` : null,
    me.sub ? `Member id: ${me.sub}` : null,
    me.picture ? `Picture: ${me.picture}` : null,
  ].filter(Boolean);
  return text(lines.length ? `LinkedIn profile:\n${lines.join('\n')}` : 'No profile fields were returned.');
}

async function createPost(cfg: LinkedInConfig, args: Record<string, unknown>): Promise<McpToolResult> {
  const commentary = String(args.text ?? '').trim();
  if (!commentary) return text('Error: `text` is required.', true);

  // The Posts API needs the author URN — resolve the member id from userinfo.
  const me = await apiJson(cfg, 'GET', `${API}/v2/userinfo`);
  const sub = me?.sub;
  if (!sub) throw new LinkedInError('Could not resolve the member id (userinfo returned no `sub`).');

  const visibility = args.visibility === 'CONNECTIONS' ? 'CONNECTIONS' : 'PUBLIC';
  const post: Record<string, unknown> = {
    author: `urn:li:person:${sub}`,
    commentary,
    visibility,
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  const linkUrl = String(args.linkUrl ?? '').trim();
  if (linkUrl) {
    const article: Record<string, string> = { source: linkUrl };
    const title = String(args.linkTitle ?? '').trim();
    const description = String(args.linkDescription ?? '').trim();
    if (title) article.title = title;
    if (description) article.description = description;
    post.content = { article };
  }

  const res = await apiFetch(cfg, 'POST', `${API}/rest/posts`, { body: post, versioned: true });
  if (!res.ok) {
    const bodyText = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
    let msg = `HTTP ${res.status}`;
    try {
      const d = JSON.parse(bodyText);
      msg = d?.message || d?.error_description || msg;
    } catch {
      /* keep HTTP status */
    }
    return text(clip(`Error publishing the post: ${msg}`, 800), true);
  }
  const id = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id') || '';
  return text(`Post published as ${visibility.toLowerCase()}${id ? ` (${id})` : ''}.`);
}

const TOOLS: McpToolDef[] = [
  {
    name: 'linkedin_me',
    description:
      "Get the authenticated LinkedIn member's own profile (name, email, locale, member id, picture) via OpenID " +
      'Connect. Note: LinkedIn does not expose other people\'s profiles or profile search to standard apps.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'linkedin_create_post',
    description:
      'Publish a post/share on LinkedIn AS the authenticated member. Optionally attach a link (shared as an ' +
      'article). This is a mutating action — consider putting it behind the approval gate.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The post text / commentary.' },
        visibility: { type: 'string', enum: ['PUBLIC', 'CONNECTIONS'], description: 'Who can see the post (default PUBLIC).' },
        linkUrl: { type: 'string', description: 'Optional URL to share as an article attachment.' },
        linkTitle: { type: 'string', description: 'Optional title for the shared link.' },
        linkDescription: { type: 'string', description: 'Optional description for the shared link.' },
      },
      required: ['text'],
    },
  },
];

const SETUP =
  'LinkedIn only lets a standard app read the authenticated member and post on their behalf — profile search, ' +
  'messaging, jobs and others’ profiles need LinkedIn partner programs and are not available here.\n' +
  '• Create an app at linkedin.com/developers, add the products **Sign In with LinkedIn using OpenID Connect** ' +
  'and **Share on LinkedIn**.\n' +
  '• Do the OAuth consent **once** with scopes `openid profile email w_member_social` and exchange the code ' +
  'for a **refresh token** (LinkedIn returns a refresh token only if your app has the program enabled).\n' +
  '• Set **Client ID**, **Client Secret** and **Refresh Token**. Kravn refreshes access tokens automatically.\n' +
  '• If posting fails with a version error, set **API version (posts)** to a current `YYYYMM` value.';

export function linkedinPlugin(): McpServerPlugin {
  return {
    manifest: {
      id: LINKEDIN_ID,
      name: 'LinkedIn',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        "Read the authenticated member's LinkedIn profile and publish posts/shares on their behalf, over LinkedIn's " +
        'official OAuth 2.0 API (OpenID Connect + Share on LinkedIn). Includes a mutating action (posting).',
      author: 'Kravn',
      priority: 100,
      setup: SETUP,
      configSchema: {
        type: 'object',
        properties: {
          clientId: { type: 'string', title: 'Client ID', description: 'LinkedIn OAuth client ID (from your LinkedIn app).' },
          clientSecret: { type: 'string', title: 'Client Secret', description: 'LinkedIn OAuth client secret.', secret: true },
          refreshToken: { type: 'string', title: 'Refresh Token', description: 'Member OAuth refresh token (scopes openid profile email w_member_social).', secret: true },
          apiVersion: { type: 'string', title: 'API version (posts)', description: 'LinkedIn-Version header for the Posts API, e.g. 202505. Bump it if posting fails with a version error.' },
        },
        required: ['clientId', 'clientSecret', 'refreshToken'],
      },
    },
    server: {
      listTools: () => TOOLS,
      async callTool(name, args, config): Promise<McpToolResult> {
        try {
          const cfg = readConfig(config);
          switch (name) {
            case 'linkedin_me':
              return await getMe(cfg);
            case 'linkedin_create_post':
              return await createPost(cfg, args);
            default:
              return text(`Unknown tool: ${name}`, true);
          }
        } catch (err) {
          return text(err instanceof LinkedInError ? err.message : err instanceof Error ? err.message : 'LinkedIn request failed.', true);
        }
      },
    },
  };
}
