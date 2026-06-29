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

/** Ordered list of migrations. Append new ones; never edit a shipped migration. */
const MIGRATIONS: Migration[] = [initial, projectDocs, attachments];

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

/** Run all pending migrations. Safe to call on every boot. */
export async function runMigrations(knex: Knex, db?: DbConfig): Promise<void> {
  if (db?.schema) {
    if (db.client === 'pg') {
      await knex.raw(`create schema if not exists "${db.schema}"`);
    } else if (db.client === 'mssql') {
      await knex.raw(`if not exists (select 1 from sys.schemas where name = '${db.schema}') exec('create schema [${db.schema}]')`);
    }
  }
  await knex.migrate.latest({ migrationSource });
}
