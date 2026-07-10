import type { Store } from './store.js';
import type {
  UpstreamServer,
  Tool,
  Resource,
  Prompt,
  McpEndpoint,
  VsAccess,
  User,
  Role,
  LocalPrompt,
  LocalPromptArgument,
  PromptRole,
  LlmProvider,
  LlmProviderType,
  Team,
  TeamMember,
  TeamRole,
  ChatProject,
  ChatConversation,
  ChatMessage,
  ChatRole,
  ChatAttachment,
  ChatAttachmentKind,
} from '@kravn/contracts';
import { PLATFORM_ADMIN_TEAM_ID, PLATFORM_ADMIN_TEAM_SLUG, PLATFORM_ADMIN_TEAM_NAME } from '@kravn/contracts';

const now = (): string => new Date().toISOString();
const bool = (v: unknown): boolean => v === 1 || v === true || v === '1';
const intify = (v: boolean): number => (v ? 1 : 0);

// ─── Users (internal record includes password hash) ──────────────────────────────────────────────

export interface UserRecord extends User {
  passwordHash: string;
}

function mapUser(r: any): UserRecord {
  return {
    id: r.id,
    email: r.email,
    name: r.name ?? '',
    role: r.role as Role,
    disabled: r.disabled === 1 || r.disabled === true,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class UsersRepo {
  constructor(private store: Store) {}

  async count(): Promise<number> {
    const r = await this.store.get<{ c: number }>('SELECT COUNT(*) AS c FROM users');
    return Number(r?.c ?? 0);
  }
  async create(u: { id: string; email: string; name: string; role: Role; passwordHash: string }): Promise<UserRecord> {
    const ts = now();
    await this.store.run(
      `INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [u.id, u.email.toLowerCase(), u.name, u.role, u.passwordHash, ts, ts],
    );
    return (await this.getById(u.id))!;
  }
  async getById(id: string): Promise<UserRecord | undefined> {
    const r = await this.store.get('SELECT * FROM users WHERE id = ?', [id]);
    return r ? mapUser(r) : undefined;
  }
  async getByEmail(email: string): Promise<UserRecord | undefined> {
    const r = await this.store.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    return r ? mapUser(r) : undefined;
  }
  async list(): Promise<User[]> {
    const rows = await this.store.all('SELECT * FROM users ORDER BY created_at ASC');
    return rows.map(mapUser).map(({ passwordHash, ...u }) => u);
  }
  async setRole(id: string, role: Role): Promise<void> {
    await this.store.run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', [role, now(), id]);
  }
  /** Patch editable user fields (name/email/role/disabled). Email is lower-cased; disabled coerced to 0/1. */
  async update(id: string, patch: { name?: string; email?: string; role?: Role; disabled?: boolean }): Promise<void> {
    const cols: Record<string, string> = { name: 'name', email: 'email', role: 'role', disabled: 'disabled' };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(k === 'email' ? String(v).toLowerCase() : k === 'disabled' ? (v ? 1 : 0) : v);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    vals.push(now(), id);
    await this.store.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
  }
  async setPasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.store.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [passwordHash, now(), id]);
  }
  async countByRole(role: Role): Promise<number> {
    const r = await this.store.get<{ c: number }>('SELECT COUNT(*) AS c FROM users WHERE role = ?', [role]);
    return Number(r?.c ?? 0);
  }
  async delete(id: string): Promise<void> {
    await this.store.run('DELETE FROM users WHERE id = ?', [id]);
  }
}

// ─── Settings (single row) ────────────────────────────────────────────────────────────────────────

export class SettingsRepo {
  constructor(private store: Store) {}
  async getRaw(): Promise<string | undefined> {
    const r = await this.store.get<{ data: string }>('SELECT data FROM settings WHERE id = ?', ['app']);
    return r?.data;
  }
  async setRaw(data: string): Promise<void> {
    const existing = await this.getRaw();
    if (existing === undefined) {
      await this.store.run('INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)', ['app', data, now()]);
    } else {
      await this.store.run('UPDATE settings SET data = ?, updated_at = ? WHERE id = ?', [data, now(), 'app']);
    }
  }
}

// ─── Auth/SSO config (separate row so secrets never leak via /api/settings) ─────────────────────────

export class AuthConfigRepo {
  constructor(private store: Store) {}
  async getRaw(): Promise<string | undefined> {
    const r = await this.store.get<{ data: string }>('SELECT data FROM settings WHERE id = ?', ['auth']);
    return r?.data;
  }
  async setRaw(data: string): Promise<void> {
    const existing = await this.getRaw();
    if (existing === undefined) {
      await this.store.run('INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)', ['auth', data, now()]);
    } else {
      await this.store.run('UPDATE settings SET data = ?, updated_at = ? WHERE id = ?', [data, now(), 'auth']);
    }
  }
}

// ─── Servers ─────────────────────────────────────────────────────────────────────────────────────

function mapServer(r: any): UpstreamServer {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description ?? '',
    transport: r.transport,
    url: r.url ?? '',
    command: r.command ?? '',
    args: JSON.parse(r.args || '[]'),
    env: JSON.parse(r.env || '{}'),
    headers: JSON.parse(r.headers || '{}'),
    authType: r.auth_type ?? 'none',
    authValueSet: typeof r.auth_value === 'string' && r.auth_value.length > 0,
    tlsCa: r.tls_ca ?? '',
    tlsClientCert: r.tls_client_cert ?? '',
    tlsClientKeySet: typeof r.tls_client_key === 'string' && r.tls_client_key.length > 0,
    enabled: bool(r.enabled),
    status: r.status ?? 'unknown',
    lastError: r.last_error ?? '',
    lastSeenAt: r.last_seen_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface ServerInsert {
  id: string;
  name: string;
  slug: string;
  description: string;
  transport: UpstreamServer['transport'];
  url: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  authType: UpstreamServer['authType'];
  /** Already-encrypted credential (or '' for none). */
  authValueEncrypted: string;
  tlsCa?: string;
  tlsClientCert?: string;
  /** Already-encrypted client key (or '' for none). */
  tlsClientKeyEncrypted?: string;
  enabled: boolean;
  /** For native-plugin instances: the per-instance plugin config as a JSON string with secret fields already
   *  encrypted (or '{}'). Remote servers leave this empty. */
  pluginConfig?: string;
}

export class ServersRepo {
  constructor(private store: Store) {}

  async create(s: ServerInsert): Promise<UpstreamServer> {
    const ts = now();
    await this.store.run(
      `INSERT INTO servers (id, name, slug, description, transport, url, command, args, env, headers,
        auth_type, auth_value, tls_ca, tls_client_cert, tls_client_key, plugin_config, enabled, status, last_error, last_seen_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        s.id, s.name, s.slug, s.description, s.transport, s.url, s.command,
        JSON.stringify(s.args), JSON.stringify(s.env), JSON.stringify(s.headers),
        s.authType, s.authValueEncrypted, s.tlsCa ?? '', s.tlsClientCert ?? '', s.tlsClientKeyEncrypted ?? '',
        s.pluginConfig ?? '{}', intify(s.enabled), 'unknown', '', null, ts, ts,
      ],
    );
    return (await this.getById(s.id))!;
  }

  async getById(id: string): Promise<UpstreamServer | undefined> {
    const r = await this.store.get('SELECT * FROM servers WHERE id = ?', [id]);
    return r ? mapServer(r) : undefined;
  }
  async getBySlug(slug: string): Promise<UpstreamServer | undefined> {
    const r = await this.store.get('SELECT * FROM servers WHERE slug = ?', [slug]);
    return r ? mapServer(r) : undefined;
  }
  /** Returns the encrypted auth value for connection-time decryption. */
  async getAuthValueEncrypted(id: string): Promise<string> {
    const r = await this.store.get<{ auth_value: string }>('SELECT auth_value FROM servers WHERE id = ?', [id]);
    return r?.auth_value ?? '';
  }
  /** Raw TLS material for connection-time use (CA/cert in PEM; the client key is still encrypted). */
  async getTls(id: string): Promise<{ ca: string; cert: string; keyEncrypted: string }> {
    const r = await this.store.get<{ tls_ca: string; tls_client_cert: string; tls_client_key: string }>(
      'SELECT tls_ca, tls_client_cert, tls_client_key FROM servers WHERE id = ?',
      [id],
    );
    return { ca: r?.tls_ca ?? '', cert: r?.tls_client_cert ?? '', keyEncrypted: r?.tls_client_key ?? '' };
  }
  /** For native-plugin instances: the per-instance plugin config JSON (secret fields still encrypted), or ''. */
  async getPluginConfig(id: string): Promise<string> {
    const r = await this.store.get<{ plugin_config: string }>('SELECT plugin_config FROM servers WHERE id = ?', [id]);
    return r?.plugin_config ?? '';
  }
  /** Write a native-plugin instance's config (JSON string; secret fields must already be encrypted). */
  async setPluginConfig(id: string, json: string): Promise<void> {
    await this.store.run('UPDATE servers SET plugin_config = ?, updated_at = ? WHERE id = ?', [json, now(), id]);
  }
  async list(): Promise<UpstreamServer[]> {
    const rows = await this.store.all('SELECT * FROM servers ORDER BY created_at ASC');
    return rows.map(mapServer);
  }
  async update(id: string, patch: Partial<Record<string, unknown>>): Promise<void> {
    const cols: Record<string, string> = {
      name: 'name', slug: 'slug', description: 'description', url: 'url', command: 'command',
      args: 'args', env: 'env', headers: 'headers', authType: 'auth_type',
      authValueEncrypted: 'auth_value', tlsCa: 'tls_ca', tlsClientCert: 'tls_client_cert',
      tlsClientKeyEncrypted: 'tls_client_key', enabled: 'enabled', status: 'status',
      lastError: 'last_error', lastSeenAt: 'last_seen_at',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (k === 'args' || k === 'env' || k === 'headers') v = JSON.stringify(v);
      if (k === 'enabled') v = intify(Boolean(v));
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    await this.store.run(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, vals);
  }
  async setStatus(id: string, status: string, lastError = ''): Promise<void> {
    await this.store.run('UPDATE servers SET status = ?, last_error = ?, last_seen_at = ?, updated_at = ? WHERE id = ?', [
      status,
      lastError,
      status === 'online' ? now() : null,
      now(),
      id,
    ]);
  }
  async delete(id: string): Promise<void> {
    await this.store.run('DELETE FROM tools WHERE server_id = ?', [id]);
    await this.store.run('DELETE FROM resources WHERE server_id = ?', [id]);
    await this.store.run('DELETE FROM prompts WHERE server_id = ?', [id]);
    await this.store.run('DELETE FROM servers WHERE id = ?', [id]);
  }
}

// ─── Tools / Resources / Prompts ────────────────────────────────────────────────────────────────────

function mapTool(r: any): Tool {
  return {
    id: r.id, serverId: r.server_id, name: r.name, description: r.description ?? '',
    inputSchema: JSON.parse(r.input_schema || '{}'), enabled: bool(r.enabled),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapResource(r: any): Resource {
  return {
    id: r.id, serverId: r.server_id, uri: r.uri, name: r.name ?? '', description: r.description ?? '',
    mimeType: r.mime_type ?? '', enabled: bool(r.enabled), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapPrompt(r: any): Prompt {
  return {
    id: r.id, serverId: r.server_id, name: r.name, description: r.description ?? '',
    arguments: JSON.parse(r.arguments || '[]'), enabled: bool(r.enabled), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class RegistryRepo {
  constructor(private store: Store) {}

  // tools
  async listTools(): Promise<Tool[]> {
    return (await this.store.all('SELECT * FROM tools ORDER BY name ASC')).map(mapTool);
  }
  async listToolsByServer(serverId: string): Promise<Tool[]> {
    return (await this.store.all('SELECT * FROM tools WHERE server_id = ? ORDER BY name ASC', [serverId])).map(mapTool);
  }
  async getTool(id: string): Promise<Tool | undefined> {
    const r = await this.store.get('SELECT * FROM tools WHERE id = ?', [id]);
    return r ? mapTool(r) : undefined;
  }
  async upsertTool(t: { id: string; serverId: string; name: string; description: string; inputSchema: unknown }): Promise<void> {
    const ts = now();
    await this.store.run(
      `INSERT INTO tools (id, server_id, name, description, input_schema, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [t.id, t.serverId, t.name, t.description, JSON.stringify(t.inputSchema ?? {}), 1, ts, ts],
    );
  }
  async setToolEnabled(id: string, enabled: boolean): Promise<void> {
    await this.store.run('UPDATE tools SET enabled = ?, updated_at = ? WHERE id = ?', [intify(enabled), now(), id]);
  }
  async deleteToolsByServer(serverId: string): Promise<void> {
    await this.store.run('DELETE FROM tools WHERE server_id = ?', [serverId]);
  }

  // resources
  async listResources(): Promise<Resource[]> {
    return (await this.store.all('SELECT * FROM resources ORDER BY uri ASC')).map(mapResource);
  }
  async upsertResource(r: { id: string; serverId: string; uri: string; name: string; description: string; mimeType: string }): Promise<void> {
    const ts = now();
    await this.store.run(
      `INSERT INTO resources (id, server_id, uri, name, description, mime_type, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [r.id, r.serverId, r.uri, r.name, r.description, r.mimeType, 1, ts, ts],
    );
  }
  async deleteResourcesByServer(serverId: string): Promise<void> {
    await this.store.run('DELETE FROM resources WHERE server_id = ?', [serverId]);
  }

  // prompts
  async listPrompts(): Promise<Prompt[]> {
    return (await this.store.all('SELECT * FROM prompts ORDER BY name ASC')).map(mapPrompt);
  }
  async upsertPrompt(p: { id: string; serverId: string; name: string; description: string; arguments: unknown }): Promise<void> {
    const ts = now();
    await this.store.run(
      `INSERT INTO prompts (id, server_id, name, description, arguments, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [p.id, p.serverId, p.name, p.description, JSON.stringify(p.arguments ?? []), 1, ts, ts],
    );
  }
  async deletePromptsByServer(serverId: string): Promise<void> {
    await this.store.run('DELETE FROM prompts WHERE server_id = ?', [serverId]);
  }
}

// ─── Virtual servers ─────────────────────────────────────────────────────────────────────────────────

function mapVServer(r: any): McpEndpoint {
  return {
    id: r.id, name: r.name, slug: r.slug, description: r.description ?? '',
    toolIds: JSON.parse(r.tool_ids || '[]'),
    resourceIds: JSON.parse(r.resource_ids || '[]'),
    promptIds: JSON.parse(r.prompt_ids || '[]'),
    access: (r.access ?? 'authenticated') as VsAccess,
    allowedRoles: JSON.parse(r.allowed_roles || '[]'),
    allowedTeams: JSON.parse(r.allowed_teams || '[]'),
    enabled: bool(r.enabled), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class McpEndpointsRepo {
  constructor(private store: Store) {}
  async list(): Promise<McpEndpoint[]> {
    return (await this.store.all('SELECT * FROM virtual_servers ORDER BY created_at ASC')).map(mapVServer);
  }
  async getById(id: string): Promise<McpEndpoint | undefined> {
    const r = await this.store.get('SELECT * FROM virtual_servers WHERE id = ?', [id]);
    return r ? mapVServer(r) : undefined;
  }
  async getBySlug(slug: string): Promise<McpEndpoint | undefined> {
    const r = await this.store.get('SELECT * FROM virtual_servers WHERE slug = ?', [slug]);
    return r ? mapVServer(r) : undefined;
  }
  async create(v: {
    id: string; name: string; slug: string; description: string;
    toolIds: string[]; resourceIds: string[]; promptIds: string[];
    access: VsAccess; allowedRoles: string[]; allowedTeams: string[]; enabled: boolean;
  }): Promise<McpEndpoint> {
    const ts = now();
    await this.store.run(
      `INSERT INTO virtual_servers (id, name, slug, description, tool_ids, resource_ids, prompt_ids, access, allowed_roles, allowed_teams, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [v.id, v.name, v.slug, v.description, JSON.stringify(v.toolIds), JSON.stringify(v.resourceIds), JSON.stringify(v.promptIds), v.access, JSON.stringify(v.allowedRoles), JSON.stringify(v.allowedTeams), intify(v.enabled), ts, ts],
    );
    return (await this.getById(v.id))!;
  }
  async update(id: string, patch: Partial<Record<string, unknown>>): Promise<void> {
    const cols: Record<string, string> = {
      name: 'name', slug: 'slug', description: 'description', toolIds: 'tool_ids',
      resourceIds: 'resource_ids', promptIds: 'prompt_ids', access: 'access',
      allowedRoles: 'allowed_roles', allowedTeams: 'allowed_teams', enabled: 'enabled',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (k === 'toolIds' || k === 'resourceIds' || k === 'promptIds' || k === 'allowedRoles' || k === 'allowedTeams') v = JSON.stringify(v);
      if (k === 'enabled') v = intify(Boolean(v));
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    await this.store.run(`UPDATE virtual_servers SET ${sets.join(', ')} WHERE id = ?`, vals);
  }
  async delete(id: string): Promise<void> {
    await this.store.run('DELETE FROM virtual_servers WHERE id = ?', [id]);
  }
}

// ─── Local prompts ────────────────────────────────────────────────────────────────────────────────

function mapLocalPrompt(r: any): LocalPrompt {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description ?? '',
    template: r.template ?? '',
    arguments: JSON.parse(r.arguments || '[]') as LocalPromptArgument[],
    role: (r.role ?? 'user') as PromptRole,
    enabled: bool(r.enabled),
    version: Number(r.version ?? 1),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface LocalPromptInsert {
  id: string;
  name: string;
  slug: string;
  description: string;
  template: string;
  arguments: LocalPromptArgument[];
  role: PromptRole;
  enabled: boolean;
}

export class LocalPromptsRepo {
  constructor(private store: Store) {}

  async list(): Promise<LocalPrompt[]> {
    return (await this.store.all('SELECT * FROM local_prompts ORDER BY name ASC')).map(mapLocalPrompt);
  }
  async listEnabled(): Promise<LocalPrompt[]> {
    return (await this.store.all('SELECT * FROM local_prompts WHERE enabled = 1 ORDER BY name ASC')).map(mapLocalPrompt);
  }
  async getById(id: string): Promise<LocalPrompt | undefined> {
    const r = await this.store.get('SELECT * FROM local_prompts WHERE id = ?', [id]);
    return r ? mapLocalPrompt(r) : undefined;
  }
  async getByName(name: string): Promise<LocalPrompt | undefined> {
    const r = await this.store.get('SELECT * FROM local_prompts WHERE name = ?', [name]);
    return r ? mapLocalPrompt(r) : undefined;
  }
  async getBySlug(slug: string): Promise<LocalPrompt | undefined> {
    const r = await this.store.get('SELECT * FROM local_prompts WHERE slug = ?', [slug]);
    return r ? mapLocalPrompt(r) : undefined;
  }
  async create(p: LocalPromptInsert): Promise<LocalPrompt> {
    const ts = now();
    await this.store.run(
      `INSERT INTO local_prompts (id, name, slug, description, template, arguments, role, enabled, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [p.id, p.name, p.slug, p.description, p.template, JSON.stringify(p.arguments), p.role, intify(p.enabled), 1, ts, ts],
    );
    return (await this.getById(p.id))!;
  }
  async update(id: string, patch: Partial<Record<string, unknown>>): Promise<void> {
    const cols: Record<string, string> = {
      name: 'name',
      slug: 'slug',
      description: 'description',
      template: 'template',
      arguments: 'arguments',
      role: 'role',
      enabled: 'enabled',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (k === 'arguments') v = JSON.stringify(v);
      if (k === 'enabled') v = intify(Boolean(v));
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    // Bump the version counter on every update (ContextForge-style cheap versioning).
    sets.push('version = version + 1');
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    await this.store.run(`UPDATE local_prompts SET ${sets.join(', ')} WHERE id = ?`, vals);
  }
  async delete(id: string): Promise<void> {
    await this.store.run('DELETE FROM local_prompts WHERE id = ?', [id]);
  }
}

// ─── LLM providers ──────────────────────────────────────────────────────────────────────────────────

function mapLlm(r: any): LlmProvider {
  return {
    id: r.id,
    name: r.name,
    type: r.type as LlmProviderType,
    baseUrl: r.base_url ?? '',
    apiKeySet: typeof r.api_key === 'string' && r.api_key.length > 0,
    defaultModel: r.default_model ?? '',
    models: JSON.parse(r.models || '[]'),
    enabled: bool(r.enabled),
    status: (r.status ?? 'unknown') as LlmProvider['status'],
    lastError: r.last_error ?? '',
    lastTestedAt: r.last_tested_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface LlmProviderInsert {
  id: string;
  name: string;
  type: LlmProviderType;
  baseUrl: string;
  apiKeyEncrypted: string;
  defaultModel: string;
  models: string[];
  enabled: boolean;
}

export class LlmProvidersRepo {
  constructor(private store: Store) {}

  async list(): Promise<LlmProvider[]> {
    return (await this.store.all('SELECT * FROM llm_providers ORDER BY created_at ASC')).map(mapLlm);
  }
  async getById(id: string): Promise<LlmProvider | undefined> {
    const r = await this.store.get('SELECT * FROM llm_providers WHERE id = ?', [id]);
    return r ? mapLlm(r) : undefined;
  }
  async getApiKeyEncrypted(id: string): Promise<string> {
    const r = await this.store.get<{ api_key: string }>('SELECT api_key FROM llm_providers WHERE id = ?', [id]);
    return r?.api_key ?? '';
  }
  async create(p: LlmProviderInsert): Promise<LlmProvider> {
    const ts = now();
    await this.store.run(
      `INSERT INTO llm_providers (id, name, type, base_url, api_key, default_model, models, enabled, status, last_error, last_tested_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [p.id, p.name, p.type, p.baseUrl, p.apiKeyEncrypted, p.defaultModel, JSON.stringify(p.models), intify(p.enabled), 'unknown', '', null, ts, ts],
    );
    return (await this.getById(p.id))!;
  }
  async update(id: string, patch: Partial<Record<string, unknown>>): Promise<void> {
    const cols: Record<string, string> = {
      name: 'name', baseUrl: 'base_url', apiKeyEncrypted: 'api_key', defaultModel: 'default_model',
      models: 'models', enabled: 'enabled', status: 'status', lastError: 'last_error', lastTestedAt: 'last_tested_at',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (k === 'models') v = JSON.stringify(v);
      if (k === 'enabled') v = intify(Boolean(v));
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    await this.store.run(`UPDATE llm_providers SET ${sets.join(', ')} WHERE id = ?`, vals);
  }
  async delete(id: string): Promise<void> {
    await this.store.run('DELETE FROM llm_providers WHERE id = ?', [id]);
  }
}

// ─── Plugins ──────────────────────────────────────────────────────────────────────────────────────

export interface PluginRecord {
  id: string;
  type: 'hook' | 'mcp-server';
  name: string;
  version: string;
  description: string;
  author: string;
  priority: number;
  source: string;
  /** The plugin module source — the single source of truth (survives pod restarts / shared across replicas). */
  code: string;
  manifest: Record<string, unknown>;
  config: Record<string, unknown>;
  enabled: boolean;
  error: string;
  installedAt: string;
  updatedAt: string;
}

function mapPlugin(r: any): PluginRecord {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    version: r.version,
    description: r.description ?? '',
    author: r.author ?? '',
    priority: Number(r.priority ?? 100),
    source: r.source ?? '',
    code: r.code ?? '',
    manifest: JSON.parse(r.manifest || '{}'),
    config: JSON.parse(r.config || '{}'),
    enabled: bool(r.enabled),
    error: r.error ?? '',
    installedAt: r.installed_at,
    updatedAt: r.updated_at,
  };
}

export interface PluginDiscovery {
  id: string;
  type: 'hook' | 'mcp-server';
  name: string;
  version: string;
  description: string;
  author: string;
  priority: number;
  source: string;
  code: string;
  manifest: Record<string, unknown>;
}

export class PluginsRepo {
  constructor(private store: Store) {}

  async list(): Promise<PluginRecord[]> {
    return (await this.store.all('SELECT * FROM plugins ORDER BY name ASC')).map(mapPlugin);
  }
  async get(id: string): Promise<PluginRecord | undefined> {
    const r = await this.store.get('SELECT * FROM plugins WHERE id = ?', [id]);
    return r ? mapPlugin(r) : undefined;
  }
  /** Insert a newly-discovered plugin, or refresh its metadata while preserving enabled/config. */
  async upsertDiscovered(d: PluginDiscovery): Promise<void> {
    const existing = await this.get(d.id);
    const ts = now();
    if (!existing) {
      await this.store.run(
        `INSERT INTO plugins (id, type, name, version, description, author, priority, source, code, manifest, config, enabled, error, installed_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [d.id, d.type, d.name, d.version, d.description, d.author, d.priority, d.source, d.code, JSON.stringify(d.manifest), '{}', 0, '', ts, ts],
      );
    } else {
      await this.store.run(
        `UPDATE plugins SET type=?, name=?, version=?, description=?, author=?, priority=?, source=?, code=?, manifest=?, error='', updated_at=? WHERE id=?`,
        [d.type, d.name, d.version, d.description, d.author, d.priority, d.source, d.code, JSON.stringify(d.manifest), ts, d.id],
      );
    }
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.store.run('UPDATE plugins SET enabled=?, updated_at=? WHERE id=?', [enabled ? 1 : 0, now(), id]);
  }
  async setConfig(id: string, config: Record<string, unknown>): Promise<void> {
    await this.store.run('UPDATE plugins SET config=?, updated_at=? WHERE id=?', [JSON.stringify(config), now(), id]);
  }
  async setError(id: string, error: string): Promise<void> {
    await this.store.run('UPDATE plugins SET error=?, updated_at=? WHERE id=?', [error, now(), id]);
  }
  async delete(id: string): Promise<void> {
    await this.store.run('DELETE FROM plugins WHERE id = ?', [id]);
  }
}

// ─── Hook pipelines ─────────────────────────────────────────────────────────────────────────────────

export interface PipelineStep {
  /** 'global' (the base chain) or a mcpEndpointId (an overlay that runs only for that virtual server). */
  scope: string;
  hookPoint: string;
  pluginId: string;
  position: number;
  enabled: boolean;
}

function mapPipelineStep(r: any): PipelineStep {
  return {
    scope: r.scope ?? 'global',
    hookPoint: r.hook_point,
    pluginId: r.plugin_id,
    position: Number(r.position ?? 0),
    enabled: bool(r.enabled),
  };
}

export class PipelineRepo {
  constructor(private store: Store) {}

  /** Every step across all scopes + hook points, ordered so callers can group by (scope, hook_point). */
  async list(): Promise<PipelineStep[]> {
    return (await this.store.all('SELECT * FROM pipeline_steps ORDER BY scope ASC, hook_point ASC, position ASC')).map(mapPipelineStep);
  }

  /** Replace the ordered chain for one (scope, hook point). `steps` is in the desired order (index → position). */
  async replaceHook(scope: string, hookPoint: string, steps: Array<{ pluginId: string; enabled: boolean }>): Promise<void> {
    await this.store.run('DELETE FROM pipeline_steps WHERE scope = ? AND hook_point = ?', [scope, hookPoint]);
    for (let i = 0; i < steps.length; i++) {
      await this.store.run(
        'INSERT INTO pipeline_steps (scope, hook_point, plugin_id, position, enabled) VALUES (?,?,?,?,?)',
        [scope, hookPoint, steps[i].pluginId, i, steps[i].enabled ? 1 : 0],
      );
    }
  }

  /** Append a (scope, hook_point, plugin) step at the end if it doesn't exist yet (auto-seed the global base). */
  async ensureStep(scope: string, hookPoint: string, pluginId: string, enabled = true): Promise<void> {
    const existing = await this.store.get('SELECT 1 FROM pipeline_steps WHERE scope = ? AND hook_point = ? AND plugin_id = ?', [scope, hookPoint, pluginId]);
    if (existing) return;
    const max = await this.store.get('SELECT MAX(position) AS m FROM pipeline_steps WHERE scope = ? AND hook_point = ?', [scope, hookPoint]);
    const next = (max && max.m != null ? Number(max.m) : -1) + 1;
    await this.store.run(
      'INSERT INTO pipeline_steps (scope, hook_point, plugin_id, position, enabled) VALUES (?,?,?,?,?)',
      [scope, hookPoint, pluginId, next, enabled ? 1 : 0],
    );
  }

  /** Drop every step for a plugin (on plugin removal), across all scopes + hook points. */
  async deleteByPlugin(pluginId: string): Promise<void> {
    await this.store.run('DELETE FROM pipeline_steps WHERE plugin_id = ?', [pluginId]);
  }

  /** Drop every overlay step for a virtual server (on VS removal). */
  async deleteByScope(scope: string): Promise<void> {
    await this.store.run('DELETE FROM pipeline_steps WHERE scope = ?', [scope]);
  }
}

// ─── Teams ────────────────────────────────────────────────────────────────────────────────────────

export class TeamsRepo {
  constructor(private store: Store) {}

  async list(): Promise<Team[]> {
    const rows = await this.store.all<any>(
      `SELECT t.*, (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count
       FROM teams t ORDER BY t.created_at ASC`,
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, slug: r.slug, description: r.description ?? '',
      memberCount: Number(r.member_count ?? 0), createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }
  async getById(id: string): Promise<Team | undefined> {
    const r = await this.store.get<any>('SELECT * FROM teams WHERE id = ?', [id]);
    if (!r) return undefined;
    return { id: r.id, name: r.name, slug: r.slug, description: r.description ?? '', memberCount: 0, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  async getBySlug(slug: string): Promise<Team | undefined> {
    const r = await this.store.get<any>('SELECT * FROM teams WHERE slug = ?', [slug]);
    if (!r) return undefined;
    return { id: r.id, name: r.name, slug: r.slug, description: r.description ?? '', memberCount: 0, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  async create(t: { id: string; name: string; slug: string; description: string }): Promise<Team> {
    const ts = now();
    await this.store.run('INSERT INTO teams (id, name, slug, description, created_at, updated_at) VALUES (?,?,?,?,?,?)', [t.id, t.name, t.slug, t.description, ts, ts]);
    return (await this.getById(t.id))!;
  }
  async update(id: string, patch: { name?: string; slug?: string; description?: string }): Promise<void> {
    const cols: Record<string, string> = { name: 'name', slug: 'slug', description: 'description' };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      if ((patch as any)[k] === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push((patch as any)[k]);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now(), id);
    await this.store.run(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`, vals);
  }
  async delete(id: string): Promise<void> {
    await this.store.run('DELETE FROM team_members WHERE team_id = ?', [id]);
    await this.store.run('DELETE FROM team_server_tools WHERE team_id = ?', [id]);
    await this.store.run('DELETE FROM teams WHERE id = ?', [id]);
  }

  // membership
  async members(teamId: string): Promise<TeamMember[]> {
    const rows = await this.store.all<any>(
      `SELECT m.team_id, m.user_id, m.role, m.joined_at, u.email, u.name
       FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? ORDER BY m.joined_at ASC`,
      [teamId],
    );
    return rows.map((r) => ({
      teamId: r.team_id, userId: r.user_id, email: r.email, name: r.name ?? '',
      role: (r.role ?? 'member') as TeamRole, joinedAt: r.joined_at,
    }));
  }
  async addMember(teamId: string, userId: string, role: TeamRole): Promise<void> {
    const ts = now();
    // upsert: remove then insert to update role idempotently
    await this.store.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, userId]);
    await this.store.run('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?,?,?,?)', [teamId, userId, role, ts]);
  }
  async removeMember(teamId: string, userId: string): Promise<void> {
    await this.store.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, userId]);
  }
  async teamIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.store.all<{ team_id: string }>('SELECT team_id FROM team_members WHERE user_id = ?', [userId]);
    return rows.map((r) => r.team_id);
  }

  // ─── Per-team mcp-endpoint tool grants (level 2) ───────────────────────────────────────────────
  // Level 1 (which teams can use a VS) lives in virtual_servers.allowed_teams. These methods manage the
  // optional per-(team, VS) tool subset: rows present ⇒ team is restricted to those tools; no rows ⇒ ALL.

  /** Tool ids a team is restricted to on a virtual server. Empty array ⇒ no subset stored ⇒ ALL tools. */
  async serverToolSubset(teamId: string, vsId: string): Promise<string[]> {
    const rows = await this.store.all<{ tool_id: string }>(
      'SELECT tool_id FROM team_server_tools WHERE team_id = ? AND virtual_server_id = ?',
      [teamId, vsId],
    );
    return rows.map((r) => r.tool_id);
  }

  /** Replace a team's tool subset for a virtual server. null/empty ⇒ clear (team gets ALL tools). */
  async setServerToolSubset(teamId: string, vsId: string, toolIds: string[] | null): Promise<void> {
    await this.store.run('DELETE FROM team_server_tools WHERE team_id = ? AND virtual_server_id = ?', [teamId, vsId]);
    if (!toolIds || toolIds.length === 0) return;
    for (const toolId of new Set(toolIds)) {
      await this.store.run(
        'INSERT INTO team_server_tools (team_id, virtual_server_id, tool_id) VALUES (?,?,?)',
        [teamId, vsId, toolId],
      );
    }
  }

  async clearTeamGrants(teamId: string): Promise<void> {
    await this.store.run('DELETE FROM team_server_tools WHERE team_id = ?', [teamId]);
  }
  async clearServerGrants(vsId: string): Promise<void> {
    await this.store.run('DELETE FROM team_server_tools WHERE virtual_server_id = ?', [vsId]);
  }

  /**
   * The set of tool ids a user may use on a virtual server, or `null` = ALL tools allowed. `null` when:
   * the user is admin, qualifies by role (allowedRoles = full server), or no granting team narrows the
   * tools (a granting team with no subset = the whole server). Otherwise a Set = the UNION of the tool
   * subsets of the teams through which this user is granted the server.
   */
  async allowedToolIdsForUser(
    actor: { role: string; teams: readonly string[] },
    vs: { id: string; allowedRoles: readonly string[]; allowedTeams: readonly string[] },
  ): Promise<Set<string> | null> {
    if (actor.role === 'admin') return null;
    if (vs.allowedRoles.includes(actor.role)) return null; // role grant = full server
    const grantingTeams = vs.allowedTeams.filter((t) => actor.teams.includes(t));
    if (grantingTeams.length === 0) return null; // not team-based access (public/authenticated) → no narrowing
    const union = new Set<string>();
    for (const teamId of grantingTeams) {
      const subset = await this.serverToolSubset(teamId, vs.id);
      if (subset.length === 0) return null; // this team grants the whole server → all tools
      for (const id of subset) union.add(id);
    }
    return union;
  }

  // ─── Platform Administrator Team (gates access to the admin console) ─────────────────────────────

  /** Create the well-known Platform Administrator Team if it does not exist (fixed id/slug). Idempotent. */
  async ensurePlatformAdminTeam(): Promise<void> {
    if (await this.getById(PLATFORM_ADMIN_TEAM_ID)) return;
    const ts = now();
    await this.store
      .run('INSERT INTO teams (id, name, slug, description, created_at, updated_at) VALUES (?,?,?,?,?,?)', [
        PLATFORM_ADMIN_TEAM_ID,
        PLATFORM_ADMIN_TEAM_NAME,
        PLATFORM_ADMIN_TEAM_SLUG,
        'Members can access the Kravn administration console. Consumers of MCPs are not in this team.',
        ts,
        ts,
      ])
      .catch(() => {}); // ignore a concurrent create
  }

  /** Ensure a user is a member of the Platform Administrator Team (creating the team if needed). */
  async ensurePlatformAdminMembership(userId: string): Promise<void> {
    await this.ensurePlatformAdminTeam();
    await this.addMember(PLATFORM_ADMIN_TEAM_ID, userId, 'owner'); // addMember is idempotent
  }

  /** Startup reconciliation: guarantee the team exists and every admin-role user is a member (anti-lockout,
   *  and backfills installs created before this feature existed). */
  async reconcilePlatformAdmins(): Promise<void> {
    await this.ensurePlatformAdminTeam();
    const admins = await this.store.all<{ id: string }>('SELECT id FROM users WHERE role = ?', ['admin']);
    for (const a of admins) await this.addMember(PLATFORM_ADMIN_TEAM_ID, a.id, 'owner');
  }
}

// ─── Token revocations ────────────────────────────────────────────────────────────────────────────

export class TokensRepo {
  constructor(private store: Store) {}
  async revoke(jti: string): Promise<void> {
    await this.store.run('INSERT INTO token_revocations (jti, revoked_at) VALUES (?, ?)', [jti, now()]).catch(() => {});
  }
  /**
   * Atomically claim a single-use token by its jti. Returns true for exactly ONE caller — the first to
   * insert the row — because the `jti` PRIMARY KEY rejects every concurrent/subsequent duplicate insert.
   * This is the atomic replacement for the check-then-act `isRevoked()` + `revoke()` pattern, which had a
   * TOCTOU race (two concurrent requests both passed the read before either wrote). Fails CLOSED: any
   * insert error — the duplicate-key violation OR a transient DB error — yields false (deny), never a
   * silent success. Use this for handoff codes and stream tickets; use `revoke()` for fire-and-forget
   * session invalidation (logout), where idempotency, not first-wins, is what's wanted.
   */
  async consume(jti: string): Promise<boolean> {
    try {
      await this.store.run('INSERT INTO token_revocations (jti, revoked_at) VALUES (?, ?)', [jti, now()]);
      return true;
    } catch {
      return false; // duplicate jti (already consumed) or a DB error → deny
    }
  }
  async isRevoked(jti: string): Promise<boolean> {
    const r = await this.store.get('SELECT jti FROM token_revocations WHERE jti = ?', [jti]);
    return !!r;
  }
}

export interface SessionRow {
  jti: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revoked: boolean;
  ip: string;
  userAgent: string;
}

/** Server-side tracking of console sessions (one row per issued session token), for idle-timeout and
 *  listing/revocation. Revocation also relies on TokensRepo.revoke(jti) so the auth check rejects instantly. */
export class SessionsRepo {
  constructor(private store: Store) {}

  async create(s: { jti: string; userId: string; expiresAt: string; ip: string; userAgent: string }): Promise<void> {
    const ts = now();
    await this.store
      .run(
        `INSERT INTO sessions (jti, user_id, created_at, last_seen_at, expires_at, revoked, ip, user_agent)
         VALUES (?,?,?,?,?,0,?,?)`,
        [s.jti, s.userId, ts, ts, s.expiresAt, s.ip.slice(0, 64), s.userAgent.slice(0, 512)],
      )
      .catch(() => {});
  }

  async get(jti: string): Promise<SessionRow | undefined> {
    const r = await this.store.get<any>('SELECT * FROM sessions WHERE jti = ?', [jti]);
    return r ? mapSession(r) : undefined;
  }

  async touch(jti: string, at: string): Promise<void> {
    await this.store.run('UPDATE sessions SET last_seen_at = ? WHERE jti = ?', [at, jti]).catch(() => {});
  }

  /** Active (non-revoked, unexpired) sessions for a user, most-recently-seen first. */
  async listForUser(userId: string): Promise<SessionRow[]> {
    const rows = await this.store.all<any>(
      'SELECT * FROM sessions WHERE user_id = ? AND revoked = 0 AND expires_at > ? ORDER BY last_seen_at DESC',
      [userId, now()],
    );
    return rows.map(mapSession);
  }

  async revoke(jti: string): Promise<void> {
    await this.store.run('UPDATE sessions SET revoked = 1 WHERE jti = ?', [jti]).catch(() => {});
  }

  /** Revoke every session for a user (optionally keeping one — e.g. the current one on "log out others"). */
  async revokeAllForUser(userId: string, exceptJti?: string): Promise<string[]> {
    const rows = await this.store.all<{ jti: string }>(
      'SELECT jti FROM sessions WHERE user_id = ? AND revoked = 0',
      [userId],
    );
    const toRevoke = rows.map((r) => r.jti).filter((j) => j !== exceptJti);
    for (const jti of toRevoke) await this.revoke(jti);
    return toRevoke;
  }
}

function mapSession(r: any): SessionRow {
  return {
    jti: r.jti,
    userId: r.user_id,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    revoked: bool(r.revoked),
    ip: r.ip ?? '',
    userAgent: r.user_agent ?? '',
  };
}

// ─── Chat (end-user client) ───────────────────────────────────────────────────────────────────────

export class ChatRepo {
  constructor(private store: Store) {}

  async listProjects(userId: string): Promise<ChatProject[]> {
    const rows = await this.store.all<any>('SELECT * FROM chat_projects WHERE user_id = ? ORDER BY created_at ASC, id ASC', [userId]);
    return rows.map(mapProject);
  }
  async getProject(userId: string, id: string): Promise<ChatProject | undefined> {
    const r = await this.store.get<any>('SELECT * FROM chat_projects WHERE id = ? AND user_id = ?', [id, userId]);
    return r ? mapProject(r) : undefined;
  }
  async createProject(userId: string, id: string, name: string, instructions = ''): Promise<ChatProject> {
    const ts = now();
    await this.store.run(
      'INSERT INTO chat_projects (id, user_id, name, instructions, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      [id, userId, name, instructions, ts, ts],
    );
    return { id, name, instructions, createdAt: ts, updatedAt: ts };
  }
  async updateProject(userId: string, id: string, patch: { name?: string; instructions?: string }): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
    if (patch.instructions !== undefined) { sets.push('instructions = ?'); vals.push(patch.instructions); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now(), id, userId);
    await this.store.run(`UPDATE chat_projects SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, vals);
  }
  async deleteProject(userId: string, id: string): Promise<void> {
    await this.store.run('UPDATE chat_conversations SET project_id = NULL WHERE project_id = ? AND user_id = ?', [id, userId]);
    await this.store.run('DELETE FROM chat_project_documents WHERE project_id = ? AND user_id = ?', [id, userId]);
    await this.store.run('DELETE FROM chat_projects WHERE id = ? AND user_id = ?', [id, userId]);
  }

  // Project documents (injected into the model context at chat time).
  async listDocuments(projectId: string): Promise<ProjectDocumentRecord[]> {
    const rows = await this.store.all<any>('SELECT * FROM chat_project_documents WHERE project_id = ? ORDER BY created_at ASC, id ASC', [projectId]);
    return rows.map((r) => ({ id: r.id, projectId: r.project_id, name: r.name, content: r.content ?? '', createdAt: r.created_at }));
  }
  async addDocument(id: string, projectId: string, userId: string, name: string, content: string): Promise<ProjectDocumentRecord> {
    const ts = now();
    await this.store.run(
      'INSERT INTO chat_project_documents (id, project_id, user_id, name, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [id, projectId, userId, name, content, ts, ts],
    );
    return { id, projectId, name, content, createdAt: ts };
  }
  async deleteDocument(userId: string, projectId: string, docId: string): Promise<void> {
    await this.store.run('DELETE FROM chat_project_documents WHERE id = ? AND project_id = ? AND user_id = ?', [docId, projectId, userId]);
  }

  async listConversations(userId: string): Promise<ChatConversation[]> {
    const rows = await this.store.all<any>('SELECT * FROM chat_conversations WHERE user_id = ? ORDER BY updated_at DESC, id DESC', [userId]);
    return rows.map(mapConversation);
  }
  async getConversation(userId: string, id: string): Promise<ChatConversation | undefined> {
    const r = await this.store.get<any>('SELECT * FROM chat_conversations WHERE id = ? AND user_id = ?', [id, userId]);
    return r ? mapConversation(r) : undefined;
  }
  async createConversation(userId: string, c: {
    id: string; projectId: string | null; title: string; providerId: string; model: string; vserverSlug: string;
  }): Promise<ChatConversation> {
    const ts = now();
    await this.store.run(
      `INSERT INTO chat_conversations (id, user_id, project_id, title, provider_id, model, vserver_slug, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [c.id, userId, c.projectId, c.title, c.providerId, c.model, c.vserverSlug, ts, ts],
    );
    return (await this.getConversation(userId, c.id))!;
  }
  async touchConversation(id: string, title?: string): Promise<void> {
    if (title !== undefined) await this.store.run('UPDATE chat_conversations SET title = ?, updated_at = ? WHERE id = ?', [title, now(), id]);
    else await this.store.run('UPDATE chat_conversations SET updated_at = ? WHERE id = ?', [now(), id]);
  }
  async deleteConversation(userId: string, id: string): Promise<void> {
    // Only delete messages that belong to a conversation owned by this user (the subquery scopes
    // by user_id) — a flat conversation_id delete would let any user wipe another's messages.
    await this.store.run(
      'DELETE FROM chat_messages WHERE conversation_id IN (SELECT id FROM chat_conversations WHERE id = ? AND user_id = ?)',
      [id, userId],
    );
    await this.store.run('DELETE FROM chat_attachments WHERE conversation_id = ? AND user_id = ?', [id, userId]);
    await this.store.run('DELETE FROM chat_conversations WHERE id = ? AND user_id = ?', [id, userId]);
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.store.all<any>('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC', [conversationId]);
    return rows.map((r) => ({ id: r.id, conversationId: r.conversation_id, role: r.role as ChatRole, content: r.content ?? '', createdAt: r.created_at }));
  }
  async addMessage(id: string, conversationId: string, role: ChatRole, content: string): Promise<ChatMessage> {
    const ts = now();
    await this.store.run('INSERT INTO chat_messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)', [id, conversationId, role, content, ts]);
    return { id, conversationId, role, content, createdAt: ts };
  }

  // ── Attachments (files uploaded into a conversation) ──────────────────────────────────────────
  async addAttachment(a: AttachmentInsert): Promise<ChatAttachment> {
    const ts = now();
    await this.store.run(
      `INSERT INTO chat_attachments (id, conversation_id, message_id, user_id, name, mime, size, kind, extracted_text, data_b64, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [a.id, a.conversationId, null, a.userId, a.name, a.mime, a.size, a.kind, a.extractedText, a.dataB64, ts],
    );
    return {
      id: a.id, conversationId: a.conversationId, messageId: null, name: a.name, mime: a.mime,
      size: a.size, kind: a.kind, textChars: a.extractedText.length, createdAt: ts,
    };
  }

  /** Attachments to inject into a turn — scoped to the owner + conversation. Includes the extracted text. */
  async getAttachmentsForContext(userId: string, conversationId: string, ids: string[]): Promise<AttachmentContext[]> {
    if (ids.length === 0) return [];
    const ph = ids.map(() => '?').join(',');
    const rows = await this.store.all<any>(
      `SELECT id, name, kind, extracted_text FROM chat_attachments
       WHERE user_id = ? AND conversation_id = ? AND id IN (${ph}) ORDER BY created_at ASC, id ASC`,
      [userId, conversationId, ...ids],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind as ChatAttachmentKind, text: r.extracted_text ?? '' }));
  }

  /** All sent (message-linked) attachments of a conversation, owner-scoped, with text — for context injection. */
  async getConversationAttachmentsForContext(userId: string, conversationId: string): Promise<AttachmentContext[]> {
    const rows = await this.store.all<any>(
      `SELECT id, name, kind, extracted_text FROM chat_attachments
       WHERE user_id = ? AND conversation_id = ? AND message_id IS NOT NULL ORDER BY created_at ASC, id ASC`,
      [userId, conversationId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind as ChatAttachmentKind, text: r.extracted_text ?? '' }));
  }

  /** Original bytes of all sent attachments in a conversation, owner-scoped — input files for the interpreter. */
  async getAttachmentFiles(userId: string, conversationId: string): Promise<{ name: string; b64: string }[]> {
    const rows = await this.store.all<any>(
      `SELECT name, data_b64 FROM chat_attachments
       WHERE user_id = ? AND conversation_id = ? AND message_id IS NOT NULL ORDER BY created_at ASC, id ASC`,
      [userId, conversationId],
    );
    return rows.map((r) => ({ name: r.name, b64: r.data_b64 ?? '' }));
  }

  /** Bytes of a single attachment for download, owner-scoped. */
  async getAttachmentBytes(userId: string, id: string): Promise<{ name: string; mime: string; b64: string } | undefined> {
    const r = await this.store.get<any>('SELECT name, mime, data_b64 FROM chat_attachments WHERE id = ? AND user_id = ?', [id, userId]);
    return r ? { name: r.name, mime: r.mime, b64: r.data_b64 ?? '' } : undefined;
  }

  async linkAttachmentsToMessage(userId: string, conversationId: string, messageId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const ph = ids.map(() => '?').join(',');
    await this.store.run(
      `UPDATE chat_attachments SET message_id = ? WHERE user_id = ? AND conversation_id = ? AND message_id IS NULL AND id IN (${ph})`,
      [messageId, userId, conversationId, ...ids],
    );
  }

  async listAttachmentsByMessage(conversationId: string): Promise<ChatAttachment[]> {
    const rows = await this.store.all<any>(
      `SELECT id, conversation_id, message_id, name, mime, size, kind, extracted_text, created_at
       FROM chat_attachments WHERE conversation_id = ? AND message_id IS NOT NULL ORDER BY created_at ASC, id ASC`,
      [conversationId],
    );
    return rows.map(mapAttachment);
  }
}

export interface ProjectDocumentRecord {
  id: string;
  projectId: string;
  name: string;
  content: string;
  createdAt: string;
}

export interface AttachmentInsert {
  id: string;
  conversationId: string;
  userId: string;
  name: string;
  mime: string;
  size: number;
  kind: ChatAttachmentKind;
  extractedText: string;
  dataB64: string;
}

export interface AttachmentContext {
  id: string;
  name: string;
  kind: ChatAttachmentKind;
  text: string;
}

function mapAttachment(r: any): ChatAttachment {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id ?? null,
    name: r.name,
    mime: r.mime,
    size: Number(r.size ?? 0),
    kind: (r.kind ?? 'other') as ChatAttachmentKind,
    textChars: typeof r.extracted_text === 'string' ? r.extracted_text.length : 0,
    createdAt: r.created_at,
  };
}

function mapProject(r: any): ChatProject {
  return { id: r.id, name: r.name, instructions: r.instructions ?? '', createdAt: r.created_at, updatedAt: r.updated_at };
}

function mapConversation(r: any): ChatConversation {
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    title: r.title,
    providerId: r.provider_id ?? '',
    model: r.model ?? '',
    vserverSlug: r.vserver_slug ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── Aggregate ──────────────────────────────────────────────────────────────────────────────────────

export interface ToolFingerprint {
  id: string;
  serverId: string;
  toolName: string;
  approvedHash: string;
  approvedDesc: string;
  approvedAt: string;
  approvedBy: string;
  pendingHash: string | null;
  pendingDesc: string | null;
  status: 'approved' | 'changed';
  firstSeenAt: string;
  updatedAt: string;
}

function mapFingerprint(r: any): ToolFingerprint {
  return {
    id: r.id,
    serverId: r.server_id,
    toolName: r.tool_name,
    approvedHash: r.approved_hash,
    approvedDesc: r.approved_desc ?? '',
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    pendingHash: r.pending_hash ?? null,
    pendingDesc: r.pending_desc ?? null,
    status: (r.status as 'approved' | 'changed') ?? 'approved',
    firstSeenAt: r.first_seen_at,
    updatedAt: r.updated_at,
  };
}

/** Pinned tool-definition fingerprints for rug-pull / tool-poisoning detection (migration 016). */
export class ToolFingerprintsRepo {
  constructor(private store: Store) {}

  async getByServer(serverId: string): Promise<ToolFingerprint[]> {
    return (await this.store.all<any>('SELECT * FROM tool_fingerprints WHERE server_id = ?', [serverId])).map(mapFingerprint);
  }
  async get(id: string): Promise<ToolFingerprint | undefined> {
    const r = await this.store.get<any>('SELECT * FROM tool_fingerprints WHERE id = ?', [id]);
    return r ? mapFingerprint(r) : undefined;
  }
  async listChanged(): Promise<ToolFingerprint[]> {
    return (await this.store.all<any>("SELECT * FROM tool_fingerprints WHERE status = 'changed' ORDER BY updated_at DESC")).map(mapFingerprint);
  }
  async create(f: { id: string; serverId: string; toolName: string; approvedHash: string; approvedDesc: string; approvedBy: string; ts: string }): Promise<void> {
    await this.store
      .run(
        `INSERT INTO tool_fingerprints (id, server_id, tool_name, approved_hash, approved_desc, approved_at, approved_by, pending_hash, pending_desc, status, first_seen_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [f.id, f.serverId, f.toolName, f.approvedHash, f.approvedDesc, f.ts, f.approvedBy, null, null, 'approved', f.ts, f.ts],
      )
      .catch(() => {});
  }
  /** Flag a detected definition change — the approved baseline stays until an admin re-approves. */
  async markChanged(id: string, pendingHash: string, pendingDesc: string, ts: string): Promise<void> {
    await this.store
      .run("UPDATE tool_fingerprints SET pending_hash = ?, pending_desc = ?, status = 'changed', updated_at = ? WHERE id = ?", [pendingHash, pendingDesc, ts, id])
      .catch(() => {});
  }
  /** The definition reverted to the approved one before review — drop the pending flag. */
  async clearPending(id: string, ts: string): Promise<void> {
    await this.store
      .run("UPDATE tool_fingerprints SET pending_hash = NULL, pending_desc = NULL, status = 'approved', updated_at = ? WHERE id = ?", [ts, id])
      .catch(() => {});
  }
  /** Admin re-approves the changed definition: it becomes the new trusted baseline. */
  async approve(id: string, hash: string, desc: string, by: string, ts: string): Promise<void> {
    await this.store
      .run(
        "UPDATE tool_fingerprints SET approved_hash = ?, approved_desc = ?, approved_at = ?, approved_by = ?, pending_hash = NULL, pending_desc = NULL, status = 'approved', updated_at = ? WHERE id = ?",
        [hash, desc, ts, by, ts, id],
      )
      .catch(() => {});
  }
  async deleteByServer(serverId: string): Promise<void> {
    await this.store.run('DELETE FROM tool_fingerprints WHERE server_id = ?', [serverId]).catch(() => {});
  }
}

export interface ToolApproval {
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  mcpEndpointId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  argsPreview: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  reason: string | null;
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

function mapApproval(r: any): ToolApproval {
  return {
    id: r.id,
    serverId: r.server_id,
    serverName: r.server_name ?? '',
    toolName: r.tool_name,
    mcpEndpointId: r.mcp_endpoint_id ?? null,
    actorId: r.actor_id ?? null,
    actorEmail: r.actor_email ?? null,
    argsPreview: r.args_preview ?? '',
    status: (r.status as ToolApproval['status']) ?? 'pending',
    reason: r.reason ?? null,
    resolvedBy: r.resolved_by ?? null,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? null,
  };
}

/** Held tool-call approvals — human-in-the-loop maker-checker (migration 017). */
export class ToolApprovalsRepo {
  constructor(private store: Store) {}

  async create(a: {
    id: string;
    serverId: string;
    serverName: string;
    toolName: string;
    mcpEndpointId: string | null;
    actorId: string | null;
    actorEmail: string | null;
    argsPreview: string;
    ts: string;
  }): Promise<void> {
    await this.store.run(
      `INSERT INTO tool_approvals (id, server_id, server_name, tool_name, mcp_endpoint_id, actor_id, actor_email, args_preview, status, reason, resolved_by, created_at, resolved_at)
       VALUES (?,?,?,?,?,?,?,?, 'pending', NULL, NULL, ?, NULL)`,
      [a.id, a.serverId, a.serverName, a.toolName, a.mcpEndpointId, a.actorId, a.actorEmail, a.argsPreview, a.ts],
    );
  }
  async get(id: string): Promise<ToolApproval | undefined> {
    const r = await this.store.get<any>('SELECT * FROM tool_approvals WHERE id = ?', [id]);
    return r ? mapApproval(r) : undefined;
  }
  async listPending(): Promise<ToolApproval[]> {
    return (await this.store.all<any>("SELECT * FROM tool_approvals WHERE status = 'pending' ORDER BY created_at ASC")).map(mapApproval);
  }
  /** Resolve a still-pending row (no-op if already resolved by someone/something else). */
  async resolve(id: string, status: 'approved' | 'denied' | 'expired', by: string, reason: string, ts: string): Promise<void> {
    await this.store.run("UPDATE tool_approvals SET status = ?, resolved_by = ?, reason = ?, resolved_at = ? WHERE id = ? AND status = 'pending'", [
      status,
      by,
      reason,
      ts,
      id,
    ]);
  }
}

export type UsageScope = 'global' | 'user' | 'endpoint' | 'model';
export interface UsageRow {
  periodKey: string;
  scopeType: UsageScope;
  scopeId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  updatedAt: string;
}
function mapUsage(r: any): UsageRow {
  return {
    periodKey: r.period_key,
    scopeType: (r.scope_type as UsageScope) ?? 'global',
    scopeId: r.scope_id ?? '',
    calls: Number(r.calls) || 0,
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
    updatedAt: r.updated_at,
  };
}

/** Per-period usage counters for cost/quota governance + chargeback (migration 018). Best-effort metering. */
export class UsageRepo {
  constructor(private store: Store) {}

  private updateSql = `UPDATE usage_counters SET calls = calls + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ?
                       WHERE period_key = ? AND scope_type = ? AND scope_id = ?`;

  /** Increment a scope's counters for a period; creates the row if missing (race-safe via insert-then-retry). */
  async add(periodKey: string, scopeType: UsageScope, scopeId: string, calls: number, inTok: number, outTok: number): Promise<void> {
    const ts = now();
    const args = [calls, inTok, outTok, ts, periodKey, scopeType, scopeId];
    const exists = await this.store.get<any>('SELECT scope_id FROM usage_counters WHERE period_key = ? AND scope_type = ? AND scope_id = ?', [periodKey, scopeType, scopeId]).catch(() => undefined);
    if (exists) {
      await this.store.run(this.updateSql, args).catch(() => {});
      return;
    }
    await this.store
      .run('INSERT INTO usage_counters (period_key, scope_type, scope_id, calls, input_tokens, output_tokens, updated_at) VALUES (?,?,?,?,?,?,?)', [periodKey, scopeType, scopeId, calls, inTok, outTok, ts])
      .catch(async () => {
        await this.store.run(this.updateSql, args).catch(() => {}); // lost the insert race → the row exists now
      });
  }
  async get(periodKey: string, scopeType: UsageScope, scopeId: string): Promise<UsageRow | undefined> {
    const r = await this.store.get<any>('SELECT * FROM usage_counters WHERE period_key = ? AND scope_type = ? AND scope_id = ?', [periodKey, scopeType, scopeId]);
    return r ? mapUsage(r) : undefined;
  }
  async list(periodKey: string): Promise<UsageRow[]> {
    return (await this.store.all<any>('SELECT * FROM usage_counters WHERE period_key = ? ORDER BY scope_type ASC, output_tokens DESC', [periodKey])).map(mapUsage);
  }
}

export interface Repos {
  users: UsersRepo;
  settings: SettingsRepo;
  authConfig: AuthConfigRepo;
  servers: ServersRepo;
  registry: RegistryRepo;
  mcpEndpoints: McpEndpointsRepo;
  localPrompts: LocalPromptsRepo;
  llmProviders: LlmProvidersRepo;
  plugins: PluginsRepo;
  pipeline: PipelineRepo;
  teams: TeamsRepo;
  chat: ChatRepo;
  tokens: TokensRepo;
  sessions: SessionsRepo;
  oauth: OAuthRepo;
  auditLog: AuditLogRepo;
  serverOAuth: ServerOAuthRepo;
  toolFingerprints: ToolFingerprintsRepo;
  toolApprovals: ToolApprovalsRepo;
  usage: UsageRepo;
}

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  scope: string;
  tokenEndpointAuthMethod: string;
  createdAt: string;
}
export interface OAuthCode {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string;
  expiresAt: string;
}
export interface OAuthPending {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string;
  resource: string;
  /** sha256(binding secret). Binds approval to the browser that started /authorize (anti-fixation). */
  bindingHash: string;
  expiresAt: string;
}
export interface OAuthRefresh {
  id: string;
  tokenHash: string;
  clientId: string;
  userId: string;
  scope: string;
  expiresAt: string;
}

export class OAuthRepo {
  constructor(private store: Store) {}

  async createClient(c: OAuthClient): Promise<void> {
    await this.store.run(
      `INSERT INTO oauth_clients (id, name, redirect_uris, grant_types, scope, token_endpoint_auth_method, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.name, JSON.stringify(c.redirectUris), JSON.stringify(c.grantTypes), c.scope, c.tokenEndpointAuthMethod, now()],
    );
  }
  async getClient(id: string): Promise<OAuthClient | undefined> {
    const r = await this.store.get<any>('SELECT * FROM oauth_clients WHERE id = ?', [id]);
    if (!r) return undefined;
    return {
      id: r.id,
      name: r.name ?? '',
      redirectUris: JSON.parse(r.redirect_uris || '[]'),
      grantTypes: JSON.parse(r.grant_types || '[]'),
      scope: r.scope ?? '',
      tokenEndpointAuthMethod: r.token_endpoint_auth_method ?? 'none',
      createdAt: r.created_at,
    };
  }

  async createPending(p: OAuthPending): Promise<void> {
    await this.store.run(
      `INSERT INTO oauth_pending (id, client_id, redirect_uri, code_challenge, code_challenge_method, scope, state, resource, binding_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, p.clientId, p.redirectUri, p.codeChallenge, p.codeChallengeMethod, p.scope, p.state, p.resource, p.bindingHash, p.expiresAt, now()],
    );
  }
  async getPending(id: string): Promise<OAuthPending | undefined> {
    const r = await this.store.get<any>('SELECT * FROM oauth_pending WHERE id = ?', [id]);
    if (!r) return undefined;
    return {
      id: r.id,
      clientId: r.client_id,
      redirectUri: r.redirect_uri,
      codeChallenge: r.code_challenge,
      codeChallengeMethod: r.code_challenge_method,
      scope: r.scope,
      state: r.state,
      resource: r.resource,
      bindingHash: r.binding_hash ?? '',
      expiresAt: r.expires_at,
    };
  }
  async countClients(): Promise<number> {
    const r = await this.store.get<{ c: number }>('SELECT COUNT(*) AS c FROM oauth_clients');
    return Number(r?.c ?? 0);
  }
  async deletePending(id: string): Promise<void> {
    await this.store.run('DELETE FROM oauth_pending WHERE id = ?', [id]);
  }

  async createCode(c: OAuthCode): Promise<void> {
    await this.store.run(
      `INSERT INTO oauth_auth_codes (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, resource, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.code, c.clientId, c.userId, c.redirectUri, c.codeChallenge, c.codeChallengeMethod, c.scope, c.resource, c.expiresAt, now()],
    );
  }
  /** Atomically claim + delete an auth code (single-use). Only the caller whose DELETE removed the row wins. */
  async takeCode(code: string): Promise<OAuthCode | undefined> {
    const r = await this.store.get<any>('SELECT * FROM oauth_auth_codes WHERE code = ?', [code]);
    if (!r) return undefined;
    // The DELETE's affected-row count is the atomic claim: on a concurrent double-redeem only one DELETE
    // removes the row (count 1); the loser sees 0 and gets nothing.
    if ((await this.store.delCount('oauth_auth_codes', { code })) !== 1) return undefined;
    return {
      code: r.code,
      clientId: r.client_id,
      userId: r.user_id,
      redirectUri: r.redirect_uri,
      codeChallenge: r.code_challenge,
      codeChallengeMethod: r.code_challenge_method,
      scope: r.scope,
      resource: r.resource,
      expiresAt: r.expires_at,
    };
  }

  async createRefresh(r: OAuthRefresh): Promise<void> {
    await this.store.run(
      `INSERT INTO oauth_refresh_tokens (id, token_hash, client_id, user_id, scope, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.tokenHash, r.clientId, r.userId, r.scope, r.expiresAt, now()],
    );
  }
  /** Atomically claim + delete a refresh token by its hash (rotation). Only the winning DELETE returns it. */
  async claimRefresh(hash: string): Promise<OAuthRefresh | undefined> {
    const r = await this.store.get<any>('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?', [hash]);
    if (!r) return undefined;
    if ((await this.store.delCount('oauth_refresh_tokens', { id: r.id })) !== 1) return undefined;
    return {
      id: r.id,
      tokenHash: r.token_hash,
      clientId: r.client_id,
      userId: r.user_id,
      scope: r.scope,
      expiresAt: r.expires_at,
    };
  }
  /** Revoke every OAuth grant for a user (e.g. on account deletion). */
  async deleteRefreshForUser(userId: string): Promise<void> {
    await this.store.run('DELETE FROM oauth_refresh_tokens WHERE user_id = ?', [userId]);
  }

  /** Best-effort cleanup of expired codes / pending requests / refresh tokens. */
  async gc(nowIso: string): Promise<void> {
    await this.store.run('DELETE FROM oauth_auth_codes WHERE expires_at < ?', [nowIso]);
    await this.store.run('DELETE FROM oauth_pending WHERE expires_at < ?', [nowIso]);
    await this.store.run('DELETE FROM oauth_refresh_tokens WHERE expires_at < ?', [nowIso]);
  }
}

/** One `server_oauth` row: the upstream-OAuth config + tokens for a server. All *_enc fields are stored as
 * the Encryptor's ciphertext — this repo never encrypts/decrypts; the UpstreamOAuthService does. */
export interface ServerOAuthRow {
  serverId: string;
  authServerUrl: string;
  metadataJson: string;
  clientInfoEnc: string;
  resource: string;
  scope: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  expiresAt: string;
  operatorConfigEnc: string;
}

export interface ServerOAuthPendingRow {
  state: string;
  serverId: string;
  codeVerifierEnc: string;
  redirectUri: string;
  expiresAt: string;
}

/** Storage for the upstream OAuth 2.1 client (Kravn connecting to an OAuth-protected remote MCP server). */
export class ServerOAuthRepo {
  constructor(private store: Store) {}

  /** Insert or update the per-server OAuth config (endpoints + registered client), preserving any tokens. */
  async upsertConfig(c: {
    serverId: string;
    authServerUrl: string;
    metadataJson: string;
    clientInfoEnc: string;
    resource: string;
    scope: string;
  }): Promise<void> {
    const existing = await this.store.get<{ server_id: string }>('SELECT server_id FROM server_oauth WHERE server_id = ?', [
      c.serverId,
    ]);
    if (existing) {
      await this.store.run(
        `UPDATE server_oauth SET auth_server_url = ?, metadata = ?, client_info_enc = ?, resource = ?, scope = ?, updated_at = ?
         WHERE server_id = ?`,
        [c.authServerUrl, c.metadataJson, c.clientInfoEnc, c.resource, c.scope, now(), c.serverId],
      );
    } else {
      await this.store.run(
        `INSERT INTO server_oauth (server_id, auth_server_url, metadata, client_info_enc, resource, scope, access_token_enc, refresh_token_enc, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '', '', '', ?, ?)`,
        [c.serverId, c.authServerUrl, c.metadataJson, c.clientInfoEnc, c.resource, c.scope, now(), now()],
      );
    }
  }

  async getConfig(serverId: string): Promise<ServerOAuthRow | undefined> {
    const r = await this.store.get<Record<string, string>>('SELECT * FROM server_oauth WHERE server_id = ?', [serverId]);
    if (!r) return undefined;
    return {
      serverId: r.server_id,
      authServerUrl: r.auth_server_url,
      metadataJson: r.metadata,
      clientInfoEnc: r.client_info_enc,
      resource: r.resource,
      scope: r.scope ?? '',
      accessTokenEnc: r.access_token_enc ?? '',
      refreshTokenEnc: r.refresh_token_enc ?? '',
      expiresAt: r.expires_at ?? '',
      operatorConfigEnc: r.operator_config_enc ?? '',
    };
  }

  /** Persist the operator's raw OAuth config (encrypted), creating a minimal row if none exists yet. */
  async saveOperatorConfig(serverId: string, enc: string): Promise<void> {
    const existing = await this.store.get<{ server_id: string }>('SELECT server_id FROM server_oauth WHERE server_id = ?', [serverId]);
    if (existing) {
      await this.store.run('UPDATE server_oauth SET operator_config_enc = ?, updated_at = ? WHERE server_id = ?', [enc, now(), serverId]);
    } else {
      await this.store.run(
        `INSERT INTO server_oauth (server_id, auth_server_url, metadata, client_info_enc, resource, scope, access_token_enc, refresh_token_enc, expires_at, operator_config_enc, created_at, updated_at)
         VALUES (?, '', '{}', '', '', '', '', '', '', ?, ?, ?)`,
        [serverId, enc, now(), now()],
      );
    }
  }

  async saveTokens(serverId: string, t: { accessTokenEnc: string; refreshTokenEnc: string; expiresAt: string }): Promise<void> {
    await this.store.run(
      'UPDATE server_oauth SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, updated_at = ? WHERE server_id = ?',
      [t.accessTokenEnc, t.refreshTokenEnc, t.expiresAt, now(), serverId],
    );
  }

  async deleteConfig(serverId: string): Promise<void> {
    await this.store.run('DELETE FROM server_oauth WHERE server_id = ?', [serverId]);
    await this.store.run('DELETE FROM server_oauth_pending WHERE server_id = ?', [serverId]);
  }

  async createPending(p: ServerOAuthPendingRow): Promise<void> {
    await this.store.run(
      `INSERT INTO server_oauth_pending (state, server_id, code_verifier, redirect_uri, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [p.state, p.serverId, p.codeVerifierEnc, p.redirectUri, p.expiresAt, now()],
    );
  }

  /** Atomically claim + delete a pending row by state (single-use — mirrors takeCode). */
  async takePending(state: string): Promise<ServerOAuthPendingRow | undefined> {
    const r = await this.store.get<Record<string, string>>('SELECT * FROM server_oauth_pending WHERE state = ?', [state]);
    if (!r) return undefined;
    if ((await this.store.delCount('server_oauth_pending', { state })) !== 1) return undefined;
    return {
      state: r.state,
      serverId: r.server_id,
      codeVerifierEnc: r.code_verifier,
      redirectUri: r.redirect_uri,
      expiresAt: r.expires_at,
    };
  }

  async gc(nowIso: string): Promise<void> {
    await this.store.run('DELETE FROM server_oauth_pending WHERE expires_at < ?', [nowIso]);
  }
}

export interface AuditRecord {
  seq?: number;
  id: string;
  ts: string;
  category: string;
  action: string;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  ip: string | null;
  details: string; // redacted JSON string
  prevHash: string;
  hash: string;
}

function mapAudit(r: Record<string, unknown>): AuditRecord {
  return {
    seq: r.seq != null ? Number(r.seq) : undefined,
    id: String(r.id),
    ts: String(r.ts),
    category: String(r.category),
    action: String(r.action),
    actorId: (r.actor_id as string) ?? null,
    actorEmail: (r.actor_email as string) ?? null,
    actorRole: (r.actor_role as string) ?? null,
    resourceType: (r.resource_type as string) ?? null,
    resourceId: (r.resource_id as string) ?? null,
    outcome: String(r.outcome),
    ip: (r.ip as string) ?? null,
    details: (r.details as string) ?? '{}',
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
  };
}

/**
 * The immutable audit trail. Exposes ONLY append + read — no update/delete — so the app layer cannot rewrite
 * history. Tamper-evidence comes from the hash chain (AuditService); durable immutability at scale is
 * reinforced by the off-box SIEM export.
 */
export class AuditLogRepo {
  constructor(private store: Store) {}

  async append(r: AuditRecord): Promise<void> {
    await this.store.run(
      `INSERT INTO audit_log (id, ts, category, action, actor_id, actor_email, actor_role, resource_type, resource_id, outcome, ip, details, prev_hash, hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [r.id, r.ts, r.category, r.action, r.actorId, r.actorEmail, r.actorRole, r.resourceType, r.resourceId, r.outcome, r.ip, r.details, r.prevHash, r.hash],
    );
  }

  /** Hash of the most recent row — seeds the chain at startup. */
  async lastHash(): Promise<string | undefined> {
    const r = await this.store.get<{ hash: string }>('SELECT hash FROM audit_log WHERE seq = (SELECT MAX(seq) FROM audit_log)');
    return r?.hash;
  }

  async count(): Promise<number> {
    const r = await this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log');
    return Number(r?.n ?? 0);
  }

  /** Most recent `limit` events, newest first (clamped 1..1000). */
  async recent(limit: number): Promise<AuditRecord[]> {
    const n = Math.min(1000, Math.max(1, Math.trunc(Number(limit)) || 100));
    const sql =
      this.store.kind === 'mssql'
        ? `SELECT TOP (${n}) * FROM audit_log ORDER BY seq DESC`
        : `SELECT * FROM audit_log ORDER BY seq DESC LIMIT ${n}`;
    return (await this.store.all(sql)).map(mapAudit);
  }
}

export function createRepos(store: Store): Repos {
  return {
    users: new UsersRepo(store),
    settings: new SettingsRepo(store),
    authConfig: new AuthConfigRepo(store),
    servers: new ServersRepo(store),
    registry: new RegistryRepo(store),
    mcpEndpoints: new McpEndpointsRepo(store),
    localPrompts: new LocalPromptsRepo(store),
    llmProviders: new LlmProvidersRepo(store),
    plugins: new PluginsRepo(store),
    pipeline: new PipelineRepo(store),
    teams: new TeamsRepo(store),
    chat: new ChatRepo(store),
    tokens: new TokensRepo(store),
    sessions: new SessionsRepo(store),
    oauth: new OAuthRepo(store),
    auditLog: new AuditLogRepo(store),
    serverOAuth: new ServerOAuthRepo(store),
    toolFingerprints: new ToolFingerprintsRepo(store),
    toolApprovals: new ToolApprovalsRepo(store),
    usage: new UsageRepo(store),
  };
}
