import type { Knex } from 'knex';
import type { DbKind } from '../config/env.js';

/**
 * A deliberately small, portable data layer over Knex.
 *
 * The repos keep plain parameterized SQL with `?` placeholders; knex.raw() translates the
 * placeholders to each dialect's form, so the exact same SQL runs on SQLite, PostgreSQL,
 * MySQL/MariaDB and SQL Server. Schema construction/evolution lives in migrations.ts.
 */
export interface Store {
  readonly kind: DbKind;
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Delete matching rows and return how many were removed (knex normalizes the count across dialects). */
  delCount(table: string, where: Record<string, unknown>): Promise<number>;
  close(): Promise<void>;
}

/**
 * Normalize the dialect-specific shape of a knex.raw() result into a flat array of rows:
 *  - pg            -> { rows: [...] }
 *  - mssql         -> { recordset: [...] } or [...]
 *  - mysql2        -> [ rows[], fields[] ]
 *  - better-sqlite3-> [...]
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (result == null) return [];
  if (Array.isArray(result)) {
    // mysql2 returns a [rows, fields] tuple; everything else is already a row array.
    if (result.length > 0 && Array.isArray(result[0])) return result[0] as Record<string, unknown>[];
    return result as Record<string, unknown>[];
  }
  const obj = result as { rows?: unknown; recordset?: unknown };
  if (Array.isArray(obj.rows)) return obj.rows as Record<string, unknown>[];
  if (Array.isArray(obj.recordset)) return obj.recordset as Record<string, unknown>[];
  return [];
}

class KnexStore implements Store {
  constructor(
    readonly kind: DbKind,
    private readonly db: Knex,
  ) {}

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.db.raw(sql, params as Knex.RawBinding[]);
  }
  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const res = await this.db.raw(sql, params as Knex.RawBinding[]);
    return rowsOf(res)[0] as T | undefined;
  }
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.db.raw(sql, params as Knex.RawBinding[]);
    return rowsOf(res) as T[];
  }
  async delCount(table: string, where: Record<string, unknown>): Promise<number> {
    return Number(await this.db(table).where(where).del());
  }
  async close(): Promise<void> {
    await this.db.destroy();
  }
}

export function createStore(kind: DbKind, db: Knex): Store {
  return new KnexStore(kind, db);
}
