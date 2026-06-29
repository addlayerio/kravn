import fs from 'node:fs';
import path from 'node:path';
import knex from 'knex';
import type { Knex } from 'knex';
import type { DbConfig } from '../config/env.js';

/**
 * Build the Knex instance for the configured dialect.
 *
 * Knex gives Kravn one query/migration layer over SQLite, PostgreSQL, MySQL/MariaDB and
 * SQL Server. The repos keep their plain `?`-placeholder SQL (knex.raw translates placeholders
 * per dialect); schema construction/evolution goes through versioned migrations (see migrations.ts).
 */
export function createKnex(db: DbConfig): Knex {
  if (db.client === 'better-sqlite3' && db.file) {
    fs.mkdirSync(path.dirname(db.file), { recursive: true });
  }

  const useSchema = db.schema && (db.client === 'pg' || db.client === 'mssql');

  const config: Knex.Config = {
    client: db.client,
    connection: db.connection as Knex.Config['connection'],
    // SQLite needs this so schema-builder columns without an explicit default don't throw.
    useNullAsDefault: db.client === 'better-sqlite3',
    ...(useSchema ? { searchPath: [db.schema as string], migrations: { schemaName: db.schema as string } } : {}),
    pool: {
      min: 0,
      max: 10,
      ...(db.client === 'better-sqlite3'
        ? {
            afterCreate: (conn: { pragma?: (s: string) => void }, done: (err: unknown, c: unknown) => void) => {
              try {
                conn.pragma?.('journal_mode = WAL');
                conn.pragma?.('busy_timeout = 5000');
                conn.pragma?.('foreign_keys = ON');
                conn.pragma?.('synchronous = NORMAL');
              } catch {
                /* pragmas are best-effort */
              }
              done(null, conn);
            },
          }
        : {}),
    },
  };

  return knex(config);
}
