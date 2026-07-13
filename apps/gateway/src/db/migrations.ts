import type { Knex } from 'knex';
import type { DbConfig } from '../config/env.js';

/**
 * Versioned, cross-dialect schema migrations.
 *
 * These run on SQLite, PostgreSQL, MySQL/MariaDB and SQL Server via Knex's schema builder
 * (each dialect gets correct DDL). Knex tracks applied migrations in `knex_migrations`, so the
 * platform can build the whole database from zero and evolve it safely over time.
 *
 * Cross-dialect rules baked into these definitions:
 *  - Primary keys / unique / indexed columns are `varchar(n)` (TEXT can't be a key in MySQL/MSSQL).
 *  - Large/JSON columns are `text` with NO database default (MySQL forbids defaults on TEXT);
 *    the application always writes explicit values.
 *  - Booleans are stored as `integer` 0/1 (portable; matches the repos' intify()/bool() helpers).
 *  - Timestamps are ISO-8601 strings in `varchar(40)`.
 *
 * Adding a change later = append a new entry to MIGRATIONS (e.g. `002_...`). Never edit a shipped one.
 */

interface Migration {
  name: string;
  up: (knex: Knex) => Promise<void>;
  down: (knex: Knex) => Promise<void>;
}

type TableBuilder = (t: Knex.CreateTableBuilder) => void;

/**
 * The full v1 schema as ordered (name, builder) pairs. Exported so the DDL can be compiled
 * and validated per dialect offline (see db.dialects test) without a live server.
 */
export const TABLES: Array<[string, TableBuilder]> = [
  ['users', (t) => {
    t.string('id', 64).primary();
    t.string('email', 191).notNullable().unique();
    t.string('name', 255).notNullable().defaultTo('');
    t.string('role', 32).notNullable().defaultTo('viewer');
    t.text('password_hash').notNullable();
    t.string('created_at', 40).notNullable();
    t.string('updated_at', 40).notNullable();
  }],
  ['settings', (t) => {
    t.string('id', 64).primary();
    t.text('data').notNullable();
    t.string('updated_at', 40).notNullable();
  }],
  ['servers', (t) => {
    t.string('id', 64).primary();
    t.string('name', 255).notNullable();
    t.string('slug', 191).notNullable().unique();
    t.text('description').notNullable();
    t.string('transport', 32).notNullable();
    t.text('url').notNullable();
    t.text('command').notNullable();
    t.text('args').notNullable();
    t.text('env').notNullable();
    t.text('headers').notNullable();
    t.string('auth_type', 32).notNullable().defaultTo('none');
    t.text('auth_value').notNullable();
    t.integer('enabled').notNullable().defaultTo(1);
    t.string('status', 32).notNullable().defaultTo('unknown');
    t.text('last_error').notNullable();
    t.string('last_seen_at', 40).nullable();
    t.string('created_at', 40).notNullable();
    t.string('updated_at', 40).notNullable();
  }],
  ['tools', (t) => {
    t.string('id', 64).primary();
    t.string('server_id', 64).notNullable().index();
    t.string('name', 255).notNullable();
    t.text('description').notNullable();
    t.text('input_schema').notNullable();
    t.integer('enabled').notNullable().defaultTo(1);
    t.string('created_at', 40).notNullable();
    t.string('updated_at', 40).notNullable();
  }],
  ['resources', (t) => {
    t.string('id', 64).primary();
    t.string('server_id', 64).notNullable().index();
    t.text('uri').notNullable();
    t.string('name', 255).notNullable().defaultTo('');
    t.text('description').notNullable();
    t.string('mime_type', 191).notNullable().defaultTo('');
    t.integer('enabled').notNullable().defaultTo(1);
    t.string('created_at', 40).notNullable();
    t.string('updated_at', 40).notNullable();
  }],
  ['prompts', (t) => {
    t.string('id', 64).primary();
    t.string('server_id', 64).notNullable().index();
    t.string('name', 255).notNullable();
    t.text('description').notNullable();
    t.text('arguments').notNullable();
    t.integer('enabled').notNullable().defaultTo(1);
    t.string('created_at', 40).notNullable();
    t.string('updated_at', 40).notNullable();
  }],
  ['virtual_servers', (t) => {
    t.string('id', 64).primary();
    t.string('name', 255).notNullable();
    t.string('slug', 191).notNullable().unique();
    t.text('description').notNullable();
    t.text('tool_ids').notNullable();
    t.text('resource_ids').notNullable();
    t.text('prompt_ids').notNullable();
    t.string('access', 32).notNullable().defaultTo('authenticated');
    t.text('allowed_roles').notNullable();
    t.text('allowed_teams').notNullable();
    t.integer('enabled').notNullable().defaultTo(1);
    t.string('created_at', 40).notNullable();
    t.string('updated_at', 40).notNullable();
  }],
  ['token_revocations', (t) => {
    t.string('jti', 191).primary();
    t.string('revoked_at', 40).notNullable();
  }],
  ['teams', (t) => {
    t.string('id', 64).primary();
    t.string('name', 255).notNullable();
    t.string('slug', 191).notNullable().unique();
    t.text('description').notNullable();
    t.string('created_at', 40).notNullable();
    t.string('updated_at', 40).notNullable();
  }],
  ['team_members', (t) => {
    t.string('team_id', 64).notNullable();
    t.string('user_id', 64).notNullable().index();
    t.string('role', 32).notNullable().defaultTo('member');
    t.string('joined_at', 40).notNullable();
    t.primary(['team_id', 'user_id']);
  }],
  ['local_prompts', (t) => {
    t.string('id', 64).primary();
    t.string('name', 191).notNullable().unique();
    t.string('slug', 191).notNullable();
    t.text('description').notNullable();
    t.text('template').notNullable();
    t.text('arguments').notNullable();
    t.string('role', 32).notNullable().defaultTo('user');
    t.integer('enabled').notNullable().defaultTo(1);
    t.integer('version').notNullable().defaultTo(1);
    t.string('created_at', 40).notNullable();
    t.string('updated_at', 40).notNullable();
  }],
  ['chat_projects', (t) => {
    t.string('id', 64).primary();
    t.string('user_id', 64).notNullable().index();
    t.string('name', 255).notNullable();
    t.string('created_at', 40).notNullable();
    t.string('updated_at', 40).notNullable();
  }],
  ['chat_conversations', (t) => {
    t.string('id', 64).primary();
    t.string('user_id', 64).notNullable().index();
    t.string('project_id', 64).nullable();
    t.string('title', 255).notNullable().defaultTo('New chat');
    t.string('provider_id', 64).notNullable().defaultTo('');
    t.string('model', 191).notNullable().defaultTo('');
    t.string('vserver_slug', 191).notNullable().defaultTo('');
    t.string('created_at', 40).notNullable();
    t.string('updated_at', 40).notNullable();
  }],
  ['chat_messages', (t) => {
    t.string('id', 64).primary();
    t.string('conversation_id', 64).notNullable().index();
    t.string('role', 32).notNullable();
    t.text('content').notNullable();
    t.string('created_at', 40).notNullable();
  }],
  ['llm_providers', (t) => {
    t.string('id', 64).primary();
    t.string('name', 255).notNullable();
    t.string('type', 32).notNullable();
    t.text('base_url').notNullable();
    t.text('api_key').notNullable();
    t.string('default_model', 191).notNullable().defaultTo('');
    t.text('models').notNullable();
    t.integer('enabled').notNullable().defaultTo(1);
    t.string('status', 32).notNullable().defaultTo('unknown');
    t.text('last_error').notNullable();
    t.string('last_tested_at', 40).nullable();
    t.string('created_at', 40).notNullable();
    t.string('updated_at', 40).notNullable();
  }],
  ['plugins', (t) => {
    t.string('id', 64).primary();
    t.string('type', 32).notNullable();
    t.string('name', 255).notNullable();
    t.string('version', 32).notNullable().defaultTo('0.1.0');
    t.text('description').notNullable();
    t.string('author', 255).notNullable().defaultTo('');
    t.integer('priority').notNullable().defaultTo(100);
    t.text('source').notNullable();
    t.text('code').notNullable();
    t.text('manifest').notNullable();
    t.text('config').notNullable();
    t.integer('enabled').notNullable().defaultTo(0);
    t.text('error').notNullable();
    t.string('installed_at', 40).notNullable();
    t.string('updated_at', 40).notNullable();
  }],
];

async function createIfMissing(knex: Knex, name: string, build: TableBuilder): Promise<void> {
  if (await knex.schema.hasTable(name)) return;
  await knex.schema.createTable(name, build);
}

async function ensureColumn(
  knex: Knex,
  table: string,
  column: string,
  build: (t: Knex.AlterTableBuilder) => void,
): Promise<void> {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, build);
}

const initial: Migration = {
  name: '001_initial_schema',
  async up(knex) {
    for (const [name, build] of TABLES) {
      await createIfMissing(knex, name, build);
    }

    // Bridge databases created by the pre-migration bootstrap (additive columns it evolved via ALTER).
    // Nullable so they apply cleanly to tables that already hold rows; repos coalesce nulls on read.
    await ensureColumn(knex, 'virtual_servers', 'access', (t) => t.string('access', 32).defaultTo('authenticated'));
    await ensureColumn(knex, 'virtual_servers', 'allowed_roles', (t) => t.text('allowed_roles').nullable());
    await ensureColumn(knex, 'virtual_servers', 'allowed_teams', (t) => t.text('allowed_teams').nullable());
    await ensureColumn(knex, 'plugins', 'code', (t) => t.text('code').nullable());
  },
  async down(knex) {
    for (const t of [
      'plugins',
      'llm_providers',
      'chat_messages',
      'chat_conversations',
      'chat_projects',
      'local_prompts',
      'team_members',
      'teams',
      'token_revocations',
      'virtual_servers',
      'prompts',
      'resources',
      'tools',
      'servers',
      'settings',
      'users',
    ]) {
      await knex.schema.dropTableIfExists(t);
    }
  },
};

/**
 * 002 — Project knowledge: project-level instructions + attached documents (Claude-Projects-style).
 * Demonstrates the evolutionary path: additive column + new table, cross-dialect, idempotent.
 */
const projectDocs: Migration = {
  name: '002_project_documents',
  async up(knex) {
    await ensureColumn(knex, 'chat_projects', 'instructions', (t) => t.text('instructions').nullable());
    await createIfMissing(knex, 'chat_project_documents', (t) => {
      t.string('id', 64).primary();
      t.string('project_id', 64).notNullable().index();
      t.string('user_id', 64).notNullable();
      t.string('name', 200).notNullable();
      t.text('content').notNullable();
      t.string('created_at', 40).notNullable();
      t.string('updated_at', 40).notNullable();
    });
  },
  async down(knex) {
    await knex.schema.dropTableIfExists('chat_project_documents');
    if (await knex.schema.hasColumn('chat_projects', 'instructions')) {
      await knex.schema.alterTable('chat_projects', (t) => t.dropColumn('instructions'));
    }
  },
};

/**
 * 003 — Chat attachments: files uploaded in the client, their extracted text (injected into context)
 * and original bytes (base64, for the future code-interpreter + re-download). 'longtext' so large
 * files fit on MySQL (its default TEXT caps at 64KB).
 */
const attachments: Migration = {
  name: '003_chat_attachments',
  async up(knex) {
    await createIfMissing(knex, 'chat_attachments', (t) => {
      t.string('id', 64).primary();
      t.string('conversation_id', 64).notNullable().index();
      t.string('message_id', 64).nullable().index();
      t.string('user_id', 64).notNullable();
      t.string('name', 255).notNullable();
      t.string('mime', 191).notNullable();
      t.integer('size').notNullable();
      t.string('kind', 32).notNullable();
      t.text('extracted_text', 'longtext').notNullable();
      t.text('data_b64', 'longtext').notNullable();
      t.string('created_at', 40).notNullable();
    });
  },
  async down(knex) {
    await knex.schema.dropTableIfExists('chat_attachments');
  },
};

/**
 * 004 — OAuth 2.1 authorization server (so remote MCP clients like Claude connect via the standard
 * OAuth + Dynamic Client Registration flow). Clients are registered dynamically (public + PKCE, no
 * secret); auth codes and pending /authorize requests are short-lived; refresh tokens are stored hashed.
 * Access tokens are stateless Kravn JWTs, so they need no table here.
 */
const oauth: Migration = {
  name: '004_oauth_server',
  async up(knex) {
    await createIfMissing(knex, 'oauth_clients', (t) => {
      t.string('id', 64).primary(); // client_id
      t.string('name', 255).notNullable().defaultTo('');
      t.text('redirect_uris').notNullable(); // JSON array
      t.text('grant_types').notNullable(); // JSON array
      t.text('scope').notNullable();
      t.string('token_endpoint_auth_method', 32).notNullable().defaultTo('none');
      t.string('created_at', 40).notNullable();
    });
    await createIfMissing(knex, 'oauth_auth_codes', (t) => {
      t.string('code', 191).primary();
      t.string('client_id', 64).notNullable();
      t.string('user_id', 64).notNullable();
      t.text('redirect_uri').notNullable();
      t.string('code_challenge', 191).notNullable();
      t.string('code_challenge_method', 16).notNullable().defaultTo('S256');
      t.text('scope').notNullable();
      t.text('resource').notNullable();
      t.string('expires_at', 40).notNullable();
      t.string('created_at', 40).notNullable();
    });
    await createIfMissing(knex, 'oauth_refresh_tokens', (t) => {
      t.string('id', 64).primary();
      t.string('token_hash', 191).notNullable().unique();
      t.string('client_id', 64).notNullable();
      t.string('user_id', 64).notNullable().index();
      t.text('scope').notNullable();
      t.string('expires_at', 40).notNullable();
      t.string('created_at', 40).notNullable();
    });
    await createIfMissing(knex, 'oauth_pending', (t) => {
      t.string('id', 64).primary(); // opaque request id carried through the login round-trip
      t.string('client_id', 64).notNullable();
      t.text('redirect_uri').notNullable();
      t.string('code_challenge', 191).notNullable();
      t.string('code_challenge_method', 16).notNullable().defaultTo('S256');
      t.text('scope').notNullable();
      t.text('state').notNullable();
      t.text('resource').notNullable();
      t.string('binding_hash', 191).notNullable().defaultTo(''); // sha256(binding cookie) — anti-fixation
      t.string('expires_at', 40).notNullable();
      t.string('created_at', 40).notNullable();
    });
  },
  async down(knex) {
    await knex.schema.dropTableIfExists('oauth_pending');
    await knex.schema.dropTableIfExists('oauth_refresh_tokens');
    await knex.schema.dropTableIfExists('oauth_auth_codes');
    await knex.schema.dropTableIfExists('oauth_clients');
  },
};

/**
 * 005 — Per-team, per-tool entitlements. Level 1 (which teams can use a virtual server) stays on
 * `virtual_servers.allowed_teams`. This table is level 2: when a team has rows here for a virtual server,
 * its members may only use THOSE tools of that server; no rows for a (team, virtual_server) pair means the
 * team gets ALL of that server's tools. Rows are inert unless the team is also in the VS's allowed_teams.
 */
const teamServerTools: Migration = {
  name: '005_team_server_tools',
  async up(knex) {
    await createIfMissing(knex, 'team_server_tools', (t) => {
      t.string('team_id', 64).notNullable();
      t.string('virtual_server_id', 64).notNullable();
      t.string('tool_id', 64).notNullable();
      t.primary(['team_id', 'virtual_server_id', 'tool_id']);
      t.index(['team_id', 'virtual_server_id']);
    });
  },
  async down(knex) {
    await knex.schema.dropTableIfExists('team_server_tools');
  },
};

/**
 * 006 — User deactivation. `disabled` (0/1) lets an account be turned off (blocked from login, existing
 * sessions rejected) without deleting it — used by the user ABM and by SCIM deprovisioning.
 */
const userDisabled: Migration = {
  name: '006_user_disabled',
  async up(knex) {
    await ensureColumn(knex, 'users', 'disabled', (t) => t.integer('disabled').notNullable().defaultTo(0));
  },
  async down(knex) {
    if (await knex.schema.hasColumn('users', 'disabled')) {
      await knex.schema.alterTable('users', (t) => t.dropColumn('disabled'));
    }
  },
};

/**
 * 007 — Hook pipelines. The order (and per-junction on/off) in which hook plugins run at each MCP
 * lifecycle point (onToolCall, onToolResult, …) is composed here instead of by a single global plugin
 * priority. One row per (hook_point, plugin_id): `position` orders the chain at that junction, `enabled`
 * toggles the plugin AT that junction. No rows for a hook point ⇒ fall back to global plugin priority.
 */
const pipelineSteps: Migration = {
  name: '007_pipeline_steps',
  async up(knex) {
    await createIfMissing(knex, 'pipeline_steps', (t) => {
      t.string('hook_point', 48).notNullable(); // raw hook method key, e.g. 'onToolResult'
      t.string('plugin_id', 64).notNullable();
      t.integer('position').notNullable().defaultTo(0);
      t.integer('enabled').notNullable().defaultTo(1);
      t.primary(['hook_point', 'plugin_id']);
      t.index(['hook_point']);
    });
  },
  async down(knex) {
    await knex.schema.dropTableIfExists('pipeline_steps');
  },
};

/**
 * 008 — Per-mcp-endpoint pipeline overlays. Add a `scope` to pipeline_steps ('global' = the base chain,
 * a mcpEndpointId = an overlay that runs only for that VS) and fold it into the primary key. Existing rows
 * (created by 007) are preserved as scope='global'. Rebuilds the table because the PK changes.
 */
const pipelineScope: Migration = {
  name: '008_pipeline_scope',
  async up(knex) {
    const build = (t: Knex.CreateTableBuilder) => {
      t.string('scope', 64).notNullable().defaultTo('global');
      t.string('hook_point', 48).notNullable();
      t.string('plugin_id', 64).notNullable();
      t.integer('position').notNullable().defaultTo(0);
      t.integer('enabled').notNullable().defaultTo(1);
      t.primary(['scope', 'hook_point', 'plugin_id']);
      t.index(['scope', 'hook_point']);
    };
    if (!(await knex.schema.hasTable('pipeline_steps'))) {
      await createIfMissing(knex, 'pipeline_steps', build); // fresh install (defensive; 007 normally precedes)
      return;
    }
    const rows = await knex('pipeline_steps').select('hook_point', 'plugin_id', 'position', 'enabled');
    await knex.schema.dropTableIfExists('pipeline_steps_new');
    await createIfMissing(knex, 'pipeline_steps_new', build);
    if (rows.length) {
      await knex('pipeline_steps_new').insert(
        rows.map((r: any) => ({ scope: 'global', hook_point: r.hook_point, plugin_id: r.plugin_id, position: r.position, enabled: r.enabled })),
      );
    }
    await knex.schema.dropTable('pipeline_steps');
    await knex.schema.renameTable('pipeline_steps_new', 'pipeline_steps');
  },
  async down() {
    /* no-op: keep the scoped table */
  },
};

/**
 * 009 — Opt-in global pipeline. Earlier versions auto-seeded EVERY hook plugin into the global chain (shown
 * greyed/disabled), which doesn't scale. Global is now opt-in like a VS overlay: a plugin runs only where the
 * admin explicitly adds it. Clear the auto-seeded global rows once so the new model starts curated; per-VS
 * overlays (scope != 'global') are preserved.
 */
const pipelineOptIn: Migration = {
  name: '009_pipeline_opt_in',
  async up(knex) {
    if (await knex.schema.hasTable('pipeline_steps')) {
      await knex('pipeline_steps').where('scope', 'global').del();
    }
  },
  async down() {
    /* no-op: opt-in is the model going forward */
  },
};

/**
 * 010 — Immutable audit log. Append-only + hash-chained (each row's `hash` = sha256(prev_hash + canonical
 * content)) so tampering is detectable, and exported off-box to a SIEM by the AuditService. Grows unbounded
 * by design — retention is managed at the DB/SIEM level, not auto-pruned like the in-memory log ring buffer.
 * The repo exposes only append/read (no update/delete) so the app layer can't rewrite history.
 */
const auditLog: Migration = {
  name: '010_audit_log',
  async up(knex) {
    await createIfMissing(knex, 'audit_log', (t) => {
      t.bigIncrements('seq'); // monotonic order (DB-assigned)
      t.string('id', 64).notNullable().unique();
      t.string('ts', 40).notNullable();
      t.string('category', 32).notNullable(); // config | auth | access | tool | system
      t.string('action', 191).notNullable();
      t.string('actor_id', 64);
      t.string('actor_email', 255);
      t.string('actor_role', 32);
      t.string('resource_type', 64);
      t.string('resource_id', 191);
      t.string('outcome', 16).notNullable(); // success | failure
      t.string('ip', 64);
      t.text('details'); // redacted JSON
      t.string('prev_hash', 64).notNullable();
      t.string('hash', 64).notNullable();
      t.index(['ts']);
      t.index(['category']);
      t.index(['actor_id']);
    });
  },
  async down(knex) {
    await knex.schema.dropTableIfExists('audit_log');
  },
};

/**
 * 011 — External key-management (KMS/HSM) keyring. Holds the Data Encryption Key (DEK) in WRAPPED form
 * ONLY — encrypted by the external KEK that never leaves the KMS/HSM. One row (id='default'); the DEK is
 * unwrapped into memory at boot and never persisted in the clear. An absent/empty table means Kravn uses
 * the bootstrap-secret key (the default, unchanged behavior).
 */
const appKeyring: Migration = {
  name: '011_app_keyring',
  async up(knex) {
    await createIfMissing(knex, 'app_keyring', (t) => {
      t.string('id', 32).primary(); // always 'default' (single active DEK)
      t.string('provider', 32).notNullable(); // 'vault' | 'azure' — which KMS wrapped it
      t.text('wrapped_dek').notNullable(); // opaque KMS-wrapped DEK (never the plaintext key)
      t.string('created_at', 40).notNullable();
    });
  },
  async down(knex) {
    await knex.schema.dropTableIfExists('app_keyring');
  },
};

/**
 * 012 — Upstream OAuth 2.1 client. Lets Kravn connect (as an OAuth CLIENT) to a remote MCP server that
 * requires OAuth 2.1 (Notion, Linear, Stripe, …). `server_oauth` holds one row per server: the discovered
 * authorization-server URL + metadata, the (dynamically-registered) client info and the access/refresh
 * tokens — all credential fields ENCRYPTED at rest. `server_oauth_pending` holds the short-lived
 * (state -> code_verifier) round-trip during an authorization, single-use and expiring.
 */
const serverOAuth: Migration = {
  name: '012_server_oauth',
  async up(knex) {
    await createIfMissing(knex, 'server_oauth', (t) => {
      t.string('server_id', 64).primary();
      t.text('auth_server_url').notNullable();
      t.text('metadata').notNullable(); // AS metadata JSON (public — endpoints, no secret)
      t.text('client_info_enc').notNullable(); // encrypted JSON of the registered client (holds client_secret)
      t.text('resource').notNullable(); // RFC 8707 audience (the MCP server URL)
      t.text('scope').notNullable();
      t.text('access_token_enc').notNullable(); // encrypted; '' until first authorization
      t.text('refresh_token_enc').notNullable(); // encrypted; '' if none
      t.string('expires_at', 40).notNullable().defaultTo('');
      t.string('created_at', 40).notNullable();
      t.string('updated_at', 40).notNullable();
    });
    await createIfMissing(knex, 'server_oauth_pending', (t) => {
      t.string('state', 191).primary(); // opaque, unguessable; the callback's only trust anchor (no session)
      t.string('server_id', 64).notNullable();
      t.text('code_verifier').notNullable(); // PKCE verifier, consumed once at token exchange
      t.text('redirect_uri').notNullable();
      t.string('expires_at', 40).notNullable();
      t.string('created_at', 40).notNullable();
    });
  },
  async down(knex) {
    await knex.schema.dropTableIfExists('server_oauth_pending');
    await knex.schema.dropTableIfExists('server_oauth');
  },
};

/**
 * 013 — Persist the operator-provided upstream-OAuth config (endpoints + client) so it survives a failed
 * Connect and can be edited from the server form, instead of being re-typed each attempt. Nullable text
 * (no default — MySQL forbids defaults on TEXT); the app treats null as "no saved config".
 */
const serverOAuthOperatorConfig: Migration = {
  name: '013_server_oauth_operator_config',
  async up(knex) {
    if ((await knex.schema.hasTable('server_oauth')) && !(await knex.schema.hasColumn('server_oauth', 'operator_config_enc'))) {
      await knex.schema.alterTable('server_oauth', (t) => {
        t.text('operator_config_enc').nullable(); // encrypted JSON of the operator's raw OAuth input
      });
    }
  },
  async down(knex) {
    if ((await knex.schema.hasTable('server_oauth')) && (await knex.schema.hasColumn('server_oauth', 'operator_config_enc'))) {
      await knex.schema.alterTable('server_oauth', (t) => t.dropColumn('operator_config_enc'));
    }
  },
};

const serverTls: Migration = {
  name: '014_server_tls',
  async up(knex) {
    if (!(await knex.schema.hasTable('servers'))) return;
    const add: Array<[string, () => void]> = [];
    if (!(await knex.schema.hasColumn('servers', 'tls_ca'))) add.push(['tls_ca', () => {}]);
    if (!(await knex.schema.hasColumn('servers', 'tls_client_cert'))) add.push(['tls_client_cert', () => {}]);
    if (!(await knex.schema.hasColumn('servers', 'tls_client_key'))) add.push(['tls_client_key', () => {}]);
    if (!add.length) return;
    await knex.schema.alterTable('servers', (t) => {
      for (const [col] of add) t.text(col).nullable(); // PEM: CA bundle, client cert, encrypted client key
    });
  },
  async down(knex) {
    if (!(await knex.schema.hasTable('servers'))) return;
    for (const col of ['tls_ca', 'tls_client_cert', 'tls_client_key']) {
      if (await knex.schema.hasColumn('servers', col)) await knex.schema.alterTable('servers', (t) => t.dropColumn(col));
    }
  },
};

const sessions: Migration = {
  name: '015_sessions',
  async up(knex) {
    await createIfMissing(knex, 'sessions', (t) => {
      t.string('jti', 64).notNullable().unique(); // the session token's jti
      t.string('user_id', 64).notNullable();
      t.string('created_at', 40).notNullable();
      t.string('last_seen_at', 40).notNullable();
      t.string('expires_at', 40).notNullable(); // absolute expiry (mirrors the token exp)
      t.integer('revoked').notNullable().defaultTo(0);
      t.string('ip', 64);
      t.text('user_agent');
      t.index(['user_id']);
    });
  },
  async down(knex) {
    await knex.schema.dropTableIfExists('sessions');
  },
};

// Tool-definition fingerprints — rug-pull / tool-poisoning defence. One row per (server, tool); we pin the
// approved definition (hash of description + inputSchema) so a later silent change is detected on resync.
const toolFingerprints: Migration = {
  name: '016_tool_fingerprints',
  async up(knex) {
    await createIfMissing(knex, 'tool_fingerprints', (t) => {
      t.string('id', 64).notNullable().unique(); // deterministic: hash(serverId, toolName)
      t.string('server_id', 64).notNullable();
      t.string('tool_name', 191).notNullable();
      t.string('approved_hash', 64).notNullable(); // fingerprint of the currently-trusted definition
      t.text('approved_desc'); // truncated approved description, for the review diff
      t.string('approved_at', 40).notNullable();
      t.string('approved_by', 191).notNullable(); // admin email, or 'auto (first seen)'
      t.string('pending_hash', 64); // a detected changed definition awaiting re-approval
      t.text('pending_desc'); // truncated changed description
      t.string('status', 16).notNullable().defaultTo('approved'); // approved | changed
      t.string('first_seen_at', 40).notNullable();
      t.string('updated_at', 40).notNullable();
      t.index(['server_id']);
      t.index(['status']);
    });
  },
  async down(knex) {
    await knex.schema.dropTableIfExists('tool_fingerprints');
  },
};

// Human-in-the-loop approval queue — a matching (high-risk) tool call is held here until an admin approves,
// denies, or it times out. One row per held call.
const toolApprovals: Migration = {
  name: '017_tool_approvals',
  async up(knex) {
    await createIfMissing(knex, 'tool_approvals', (t) => {
      t.string('id', 64).notNullable().unique();
      t.string('server_id', 64).notNullable();
      t.string('server_name', 191).notNullable().defaultTo('');
      t.string('tool_name', 191).notNullable();
      t.string('mcp_endpoint_id', 64);
      t.string('actor_id', 64);
      t.string('actor_email', 191);
      t.text('args_preview'); // truncated, secret-redacted JSON of the call arguments
      t.string('status', 16).notNullable().defaultTo('pending'); // pending | approved | denied | expired
      t.text('reason');
      t.string('resolved_by', 191);
      t.string('created_at', 40).notNullable();
      t.string('resolved_at', 40);
      t.index(['status']);
      t.index(['created_at']);
    });
  },
  async down(knex) {
    await knex.schema.dropTableIfExists('tool_approvals');
  },
};

// Cost / quota governance — per-period usage counters, keyed by (period, scope). scope_type is
// global | user | endpoint | model; scope_id is the matching id (or '' for global). Upsert-incremented on
// each tool call and LLM round so budgets and chargeback can be checked/reported cheaply.
const usageCounters: Migration = {
  name: '018_usage_counters',
  async up(knex) {
    await createIfMissing(knex, 'usage_counters', (t) => {
      t.string('period_key', 16).notNullable(); // e.g. 2026-07-09 (UTC day)
      t.string('scope_type', 16).notNullable(); // global | user | endpoint | model
      t.string('scope_id', 64).notNullable().defaultTo(''); // '' for global
      t.integer('calls').notNullable().defaultTo(0);
      t.bigInteger('input_tokens').notNullable().defaultTo(0);
      t.bigInteger('output_tokens').notNullable().defaultTo(0);
      t.string('updated_at', 40).notNullable();
      t.primary(['period_key', 'scope_type', 'scope_id']);
    });
  },
  async down(knex) {
    await knex.schema.dropTableIfExists('usage_counters');
  },
};

// Per-instance native-plugin config. Lets a native plugin (e.g. Azure, Outlook) be added as MULTIPLE server
// instances, each with its own credentials — unifying native + remote as one multi-instance "MCP Server" model.
// Additive + non-destructive: just a nullable column. The existing seeded ("default") instance keeps reading the
// plugin's current config via fallback, so nothing needs re-configuring; only NEW instances use plugin_config.
const pluginInstanceConfig: Migration = {
  name: '019_plugin_config',
  async up(knex) {
    if (!(await knex.schema.hasTable('servers'))) return;
    if (!(await knex.schema.hasColumn('servers', 'plugin_config'))) {
      await knex.schema.alterTable('servers', (t) => t.text('plugin_config').nullable()); // JSON; secret fields encrypted at rest
    }
  },
  async down(knex) {
    if ((await knex.schema.hasTable('servers')) && (await knex.schema.hasColumn('servers', 'plugin_config'))) {
      await knex.schema.alterTable('servers', (t) => t.dropColumn('plugin_config'));
    }
  },
};

// The `onChatInput` DLP pipeline (e.g. PII Tokenizer) can transform an end-user message before it reaches
// the LLM. We persist BOTH: `content` (what the user typed + sees) and `model_content` (what the model
// actually received — e.g. a CUIT tokenized). Additive/nullable — a null column means the model saw
// `content` verbatim, so pre-existing messages are unchanged and nothing needs backfilling.
const chatModelContent: Migration = {
  name: '020_chat_model_content',
  async up(knex) {
    if (!(await knex.schema.hasTable('chat_messages'))) return;
    if (!(await knex.schema.hasColumn('chat_messages', 'model_content'))) {
      await knex.schema.alterTable('chat_messages', (t) => t.text('model_content').nullable());
    }
  },
  async down(knex) {
    if ((await knex.schema.hasTable('chat_messages')) && (await knex.schema.hasColumn('chat_messages', 'model_content'))) {
      await knex.schema.alterTable('chat_messages', (t) => t.dropColumn('model_content'));
    }
  },
};

// Shared projects: a project (owned by chat_projects.user_id) can be shared with other Kravn users, each as
// an 'editor' (edit instructions/docs) or 'viewer' (read + use). The owner is never a member row.
const chatProjectMembers: Migration = {
  name: '021_chat_project_members',
  async up(knex) {
    await createIfMissing(knex, 'chat_project_members', (t) => {
      t.string('project_id').notNullable();
      t.string('user_id').notNullable();
      t.string('role').notNullable(); // 'editor' | 'viewer'
      t.string('created_at').notNullable();
      t.primary(['project_id', 'user_id']);
      t.index('user_id');
    });
  },
  async down(knex) {
    if (await knex.schema.hasTable('chat_project_members')) await knex.schema.dropTable('chat_project_members');
  },
};

// Scheduled tasks: run a prompt on a cron/calendar schedule; the result lands in a new conversation.
const chatSchedules: Migration = {
  name: '022_chat_schedules',
  async up(knex) {
    await createIfMissing(knex, 'chat_schedules', (t) => {
      t.string('id').primary();
      t.string('user_id').notNullable();
      t.string('name').notNullable();
      t.text('prompt').notNullable();
      t.string('provider_id').notNullable();
      t.string('model').notNullable();
      t.string('vserver_slug').notNullable().defaultTo('');
      t.string('project_id').nullable();
      t.string('kind').notNullable(); // 'cron' | 'once'
      t.string('cron').notNullable().defaultTo('');
      t.string('run_at').notNullable().defaultTo('');
      t.string('timezone').notNullable().defaultTo('UTC');
      t.boolean('enabled').notNullable().defaultTo(true);
      t.string('next_run_at').nullable();
      t.string('last_run_at').nullable();
      t.string('last_status').nullable();
      t.text('last_error').nullable();
      t.string('last_conversation_id').nullable();
      t.string('created_at').notNullable();
      t.string('updated_at').notNullable();
      t.index('user_id');
      t.index('next_run_at');
    });
  },
  async down(knex) {
    if (await knex.schema.hasTable('chat_schedules')) await knex.schema.dropTable('chat_schedules');
  },
};

// Personal prompt library — each user's own reusable prompt templates (beyond admin/MCP prompts).
const chatUserPrompts: Migration = {
  name: '023_chat_user_prompts',
  async up(knex) {
    await createIfMissing(knex, 'chat_user_prompts', (t) => {
      t.string('id').primary();
      t.string('user_id').notNullable();
      t.string('name').notNullable();
      t.text('content').notNullable();
      t.string('created_at').notNullable();
      t.string('updated_at').notNullable();
      t.index('user_id');
    });
  },
  async down(knex) {
    if (await knex.schema.hasTable('chat_user_prompts')) await knex.schema.dropTable('chat_user_prompts');
  },
};

const chatConversationTags: Migration = {
  name: '024_chat_conversation_tags',
  async up(knex) {
    if (!(await knex.schema.hasTable('chat_conversations'))) return;
    if (!(await knex.schema.hasColumn('chat_conversations', 'tags'))) {
      // Comma-separated tag list (a chat may carry several tags / act as folders).
      await knex.schema.alterTable('chat_conversations', (t) => t.text('tags').nullable());
    }
  },
  async down(knex) {
    if ((await knex.schema.hasTable('chat_conversations')) && (await knex.schema.hasColumn('chat_conversations', 'tags'))) {
      await knex.schema.alterTable('chat_conversations', (t) => t.dropColumn('tags'));
    }
  },
};

const chatMemory: Migration = {
  name: '025_chat_memory',
  async up(knex) {
    await createIfMissing(knex, 'chat_memory', (t) => {
      t.string('id').primary();
      t.string('user_id').notNullable();
      // A single durable fact the assistant should remember across every chat for this user.
      t.text('content').notNullable();
      t.string('created_at').notNullable();
      t.string('updated_at').notNullable();
      t.index('user_id');
    });
  },
  async down(knex) {
    if (await knex.schema.hasTable('chat_memory')) await knex.schema.dropTable('chat_memory');
  },
};

const chatAssistants: Migration = {
  name: '026_chat_assistants',
  async up(knex) {
    await createIfMissing(knex, 'chat_assistants', (t) => {
      t.string('id').primary();
      t.string('user_id').notNullable();
      t.string('name').notNullable();
      // No DB default on the TEXT column (MySQL < 8.0.13 rejects DEFAULT on TEXT); the repo always writes it.
      t.text('instructions').notNullable();
      t.string('provider_id').notNullable().defaultTo('');
      t.string('model').notNullable().defaultTo('');
      t.string('vserver_slug').notNullable().defaultTo('');
      t.string('created_at').notNullable();
      t.string('updated_at').notNullable();
      t.index('user_id');
    });
  },
  async down(knex) {
    if (await knex.schema.hasTable('chat_assistants')) await knex.schema.dropTable('chat_assistants');
  },
};

const chatConversationAssistant: Migration = {
  name: '027_chat_conversation_assistant',
  async up(knex) {
    if (!(await knex.schema.hasTable('chat_conversations'))) return;
    if (!(await knex.schema.hasColumn('chat_conversations', 'assistant_id'))) {
      await knex.schema.alterTable('chat_conversations', (t) => t.string('assistant_id').nullable());
    }
  },
  async down(knex) {
    if ((await knex.schema.hasTable('chat_conversations')) && (await knex.schema.hasColumn('chat_conversations', 'assistant_id'))) {
      await knex.schema.alterTable('chat_conversations', (t) => t.dropColumn('assistant_id'));
    }
  },
};

const chatConversationFlags: Migration = {
  name: '028_chat_conversation_flags',
  async up(knex) {
    if (!(await knex.schema.hasTable('chat_conversations'))) return;
    if (!(await knex.schema.hasColumn('chat_conversations', 'pinned'))) {
      await knex.schema.alterTable('chat_conversations', (t) => t.integer('pinned').notNullable().defaultTo(0));
    }
    if (!(await knex.schema.hasColumn('chat_conversations', 'archived'))) {
      await knex.schema.alterTable('chat_conversations', (t) => t.integer('archived').notNullable().defaultTo(0));
    }
  },
  async down(knex) {
    if (!(await knex.schema.hasTable('chat_conversations'))) return;
    if (await knex.schema.hasColumn('chat_conversations', 'pinned')) await knex.schema.alterTable('chat_conversations', (t) => t.dropColumn('pinned'));
    if (await knex.schema.hasColumn('chat_conversations', 'archived')) await knex.schema.alterTable('chat_conversations', (t) => t.dropColumn('archived'));
  },
};

/** Ordered list of migrations. Append new ones; never edit a shipped migration. */
const MIGRATIONS: Migration[] = [initial, projectDocs, attachments, oauth, teamServerTools, userDisabled, pipelineSteps, pipelineScope, pipelineOptIn, auditLog, appKeyring, serverOAuth, serverOAuthOperatorConfig, serverTls, sessions, toolFingerprints, toolApprovals, usageCounters, pluginInstanceConfig, chatModelContent, chatProjectMembers, chatSchedules, chatUserPrompts, chatConversationTags, chatMemory, chatAssistants, chatConversationAssistant, chatConversationFlags];

/**
 * An in-code Knex MigrationSource so migrations ship inside the compiled bundle
 * (no separate .js files to locate at runtime / in the container).
 */
const migrationSource: Knex.MigrationSource<Migration> = {
  async getMigrations() {
    return MIGRATIONS;
  },
  getMigrationName(migration) {
    return migration.name;
  },
  async getMigration(migration) {
    return { up: migration.up, down: migration.down };
  },
};

/** Outcome of preparing a non-default DB schema, so the caller can warn when it could not be applied. */
export interface SchemaSetupResult {
  requested: boolean;
  schema?: string;
  applied: boolean;
  effective?: string;
}

/**
 * Make unqualified table names land in the requested schema on SQL Server.
 *
 * SQL Server has no per-session search_path: unqualified objects resolve through the connecting
 * principal's DEFAULT_SCHEMA. So Kravn creates the schema and repoints the login's default schema
 * at it. Best-effort — a sysadmin login (e.g. sa) always maps to dbo and cannot be repointed, and a
 * least-privilege login may lack ALTER permission; in both cases tables fall back to the effective
 * default (dbo) and the caller warns. The schema name is a validated identifier (env.resolveSchema),
 * so it is safe to inline; the principal name is escaped with quotename().
 */
async function applyMssqlSchema(knex: Knex, schema: string): Promise<SchemaSetupResult> {
  await knex.raw(`if schema_id(?) is null exec('create schema [${schema}]')`, [schema]);
  try {
    await knex.raw(
      `declare @u sysname = quotename(user_name()); exec('alter user ' + @u + ' with default_schema = [${schema}]')`,
    );
  } catch {
    /* sysadmin or insufficient permission — fall back to the effective default below */
  }
  const raw = (await knex.raw(`select schema_name() as s`)) as unknown;
  const rows = (Array.isArray(raw) ? raw : (raw as { recordset?: unknown[] })?.recordset) ?? [];
  const effective = (rows as Array<{ s?: string }>)[0]?.s;
  return { requested: true, schema, applied: effective === schema, effective };
}

/**
 * Ensure the target schema exists on PostgreSQL without requiring CREATE-on-database when it already does.
 *
 * `CREATE SCHEMA IF NOT EXISTS` checks the CREATE-on-database privilege BEFORE the existence check, so it
 * errors for a least-privilege app user even when the schema is already there. We look it up first and only
 * attempt creation when it is genuinely missing — so an operator can pre-create it
 * (`CREATE SCHEMA <s> AUTHORIZATION <app_user>`) and run Kravn without ever granting CREATE on the database.
 * The schema name is a validated identifier (env.resolveSchema), so it is safe to inline.
 */
async function ensurePgSchema(knex: Knex, schema: string): Promise<void> {
  const found = (await knex.raw('select 1 from information_schema.schemata where schema_name = ?', [schema])) as {
    rows?: unknown[];
  };
  if (!found?.rows || found.rows.length === 0) {
    await knex.raw(`create schema if not exists "${schema}"`);
  }
}

/** Run all pending migrations. Safe to call on every boot. Returns how the requested schema was applied. */
export async function runMigrations(knex: Knex, db?: DbConfig): Promise<SchemaSetupResult> {
  const schema = db?.schema;
  let result: SchemaSetupResult = { requested: !!schema, schema, applied: false };
  if (schema && db?.client === 'pg') {
    await ensurePgSchema(knex, schema);
    result = { requested: true, schema, applied: true, effective: schema };
  } else if (schema && db?.client === 'mssql') {
    result = await applyMssqlSchema(knex, schema);
  }
  await knex.migrate.latest({ migrationSource });
  return result;
}
