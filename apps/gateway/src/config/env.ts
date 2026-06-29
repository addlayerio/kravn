import { z } from 'zod';
import path from 'node:path';

/**
 * TIER-1 (bootstrap) configuration — the only thing that comes from the environment.
 * Everything else is runtime application config (see SettingsService).
 *
 * Kravn must boot with NONE of these set.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  KRAVN_DATA_DIR: z.string().default('./data'),
  /** Empty -> embedded SQLite at <dataDir>/kravn.sqlite. */
  DATABASE_URL: z.string().default(''),
  /** Empty -> auto-generated and persisted (single-node). Required for multi-replica. */
  KRAVN_SECRET: z.string().default(''),
  KRAVN_PUBLIC_URL: z.string().default(''),
  /** Optional non-interactive admin bootstrap (otherwise the UI setup wizard runs). */
  KRAVN_ADMIN_EMAIL: z.string().default(''),
  KRAVN_ADMIN_PASSWORD: z.string().default(''),
  /** Where the built admin SPA lives (served as static). */
  KRAVN_STATIC_DIR: z.string().default(''),
  /** Where plugins are discovered/installed (default <dataDir>/plugins). */
  KRAVN_PLUGINS_DIR: z.string().default(''),
  /**
   * Which slice of the backend this process serves (same image, different pods):
   *   all     -> everything (default, single-pod)
   *   gateway -> control-plane API + MCP endpoint + operator SPA (no end-user chat API)
   *   chat    -> end-user chat API only (+ shared auth/sso/bootstrap/health) — the dedicated chat pod
   */
  KRAVN_ROLE: z.enum(['all', 'gateway', 'chat']).default('all'),
  /** Base URL of the separate end-user client SPA, used as an SSO return target (e.g. https://chat.example.com). */
  KRAVN_CLIENT_URL: z.string().default(''),
  /** Build all tables inside this DB schema (PostgreSQL + SQL Server). Empty -> the default schema. */
  KRAVN_DB_SCHEMA: z.string().default(''),
});

export type RawEnv = z.infer<typeof envSchema>;
export type AppRole = 'all' | 'gateway' | 'chat';

export type DbKind = 'sqlite' | 'pg' | 'mysql' | 'mssql';
export type DbClient = 'better-sqlite3' | 'pg' | 'mysql2' | 'mssql';

export interface DbConfig {
  kind: DbKind;
  /** Knex client driver name. */
  client: DbClient;
  /** Knex connection — a DSN string (pg/mysql) or a connection object (sqlite/mssql). */
  connection: unknown;
  /** sqlite only: absolute file path, used to ensure the parent dir exists. */
  file?: string;
  /** Build/use all tables inside this schema (PostgreSQL via searchPath; SQL Server via the login DEFAULT_SCHEMA); undefined -> default schema. */
  schema?: string;
}

export interface Env {
  nodeEnv: 'development' | 'production' | 'test';
  isProd: boolean;
  port: number;
  host: string;
  dataDir: string;
  db: DbConfig;
  secret: string; // resolved later by secret.ts if env was empty
  rawSecret: string;
  publicUrl: string;
  adminEmail: string;
  adminPassword: string;
  staticDir: string;
  pluginsDir: string;
  role: AppRole;
  /** Base URL of the end-user client SPA (SSO return target); '' if not configured. */
  clientUrl: string;
}

function sqlite(file: string): DbConfig {
  return { kind: 'sqlite', client: 'better-sqlite3', connection: { filename: file }, file };
}

/** Parse a sqlserver://user:pass@host:port/db?encrypt=...&trustServerCertificate=... DSN into a tedious config. */
function parseMssql(dsn: string): DbConfig {
  const u = new URL(dsn);
  return {
    kind: 'mssql',
    client: 'mssql',
    connection: {
      server: decodeURIComponent(u.hostname),
      port: u.port ? Number(u.port) : 1433,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, '') || undefined,
      options: {
        // Azure SQL requires encryption; default on, allow opt-out for local dev.
        encrypt: u.searchParams.get('encrypt') !== 'false',
        trustServerCertificate: u.searchParams.get('trustServerCertificate') === 'true',
      },
    },
  };
}

/**
 * Resolve the bootstrap DATABASE_URL into a Knex connection config.
 *
 * Empty  -> embedded SQLite (boots of one).
 * postgres:// | postgresql://   -> PostgreSQL (pg)
 * mysql:// | mariadb://         -> MySQL / MariaDB (mysql2)
 * sqlserver:// | mssql://       -> Microsoft SQL Server (tedious)
 * sqlite:// | <path>            -> SQLite file
 */
function resolveDb(databaseUrl: string, dataDir: string): DbConfig {
  const url = databaseUrl.trim();
  if (!url) {
    return sqlite(path.resolve(dataDir, 'kravn.sqlite'));
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return { kind: 'pg', client: 'pg', connection: url };
  }
  if (url.startsWith('mysql://') || url.startsWith('mariadb://')) {
    return { kind: 'mysql', client: 'mysql2', connection: url.replace(/^mariadb:\/\//, 'mysql://') };
  }
  if (url.startsWith('sqlserver://') || url.startsWith('mssql://')) {
    return parseMssql(url);
  }
  if (url.startsWith('sqlite://')) {
    const file = url.replace(/^sqlite:\/\//, '');
    return sqlite(path.resolve(file || path.join(dataDir, 'kravn.sqlite')));
  }
  // Treat anything else as a sqlite file path.
  return sqlite(path.resolve(url));
}

/** Validate an optional absolute http(s) URL; '' stays ''. Fails fast on a malformed value (e.g. '//evil'). */
function absoluteUrlOrEmpty(name: string, value: string): string {
  const t = value.trim().replace(/\/$/, '');
  if (!t) return '';
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL (got: "${value}")`);
  }
  return t;
}

function resolveSchema(value: string): string | undefined {
  const t = value.trim();
  if (!t) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    throw new Error(`KRAVN_DB_SCHEMA must be a simple identifier [A-Za-z0-9_] (got: "${value}")`);
  }
  return t;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const raw = envSchema.parse(source);
  const dataDir = path.resolve(raw.KRAVN_DATA_DIR);
  const schema = resolveSchema(raw.KRAVN_DB_SCHEMA);
  return {
    nodeEnv: raw.NODE_ENV,
    isProd: raw.NODE_ENV === 'production',
    port: raw.PORT,
    host: raw.HOST,
    dataDir,
    db: { ...resolveDb(raw.DATABASE_URL, dataDir), schema },
    secret: raw.KRAVN_SECRET,
    rawSecret: raw.KRAVN_SECRET,
    publicUrl: raw.KRAVN_PUBLIC_URL.replace(/\/$/, ''),
    adminEmail: raw.KRAVN_ADMIN_EMAIL.trim().toLowerCase(),
    adminPassword: raw.KRAVN_ADMIN_PASSWORD,
    staticDir: raw.KRAVN_STATIC_DIR,
    pluginsDir: raw.KRAVN_PLUGINS_DIR ? path.resolve(raw.KRAVN_PLUGINS_DIR) : path.resolve(dataDir, 'plugins'),
    role: raw.KRAVN_ROLE,
    clientUrl: absoluteUrlOrEmpty('KRAVN_CLIENT_URL', raw.KRAVN_CLIENT_URL),
  };
}
