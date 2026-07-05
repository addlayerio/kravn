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
  /** Bearer token that /metrics requires (for Prometheus). Empty -> /metrics needs a signed-in Kravn user. */
  KRAVN_METRICS_TOKEN: z.string().default(''),
  /** Allow stdio upstream servers (spawn a local process). Admin-only anyway; set 'false' to forbid entirely. */
  KRAVN_ALLOW_STDIO: z.enum(['true', 'false']).default('true'),
  /** How Fastify trusts proxy headers for req.ip: 'false' (direct), 'true', a hop count, or a CIDR/IP list. */
  KRAVN_TRUST_PROXY: z.string().default('1'),
  /**
   * Optional Redis-protocol URL (redis:// or rediss://) for cross-replica shared state — brute-force
   * rate-limit counters and in-flight OIDC login state. Empty -> in-process memory (single-replica).
   * The wire protocol is Redis; the Helm chart provisions Dragonfly (RESP-compatible) for this.
   */
  KRAVN_REDIS_URL: z.string().default(''),
  /**
   * External key management (KMS/HSM) for at-rest secret encryption via envelope encryption.
   *   none   -> derive the encryption key from KRAVN_SECRET / secret.key (default, unchanged).
   *   vault  -> HashiCorp Vault Transit wraps/unwraps the Data Encryption Key.
   *   azure  -> Azure Key Vault (wrapKey/unwrapKey) using an Entra app (client credentials).
   * The KEK never leaves the KMS; Kravn only ever holds the DEK, unwrapped in memory at boot.
   */
  KRAVN_KMS_PROVIDER: z.enum(['none', 'vault', 'azure']).default('none'),
  // Vault Transit
  KRAVN_KMS_VAULT_ADDR: z.string().default(''), // https://vault.internal:8200
  KRAVN_KMS_VAULT_TOKEN: z.string().default(''),
  KRAVN_KMS_VAULT_KEY: z.string().default(''), // transit key name
  KRAVN_KMS_VAULT_NAMESPACE: z.string().default(''), // Vault Enterprise namespace (optional)
  // Azure Key Vault
  KRAVN_KMS_AZURE_VAULT_URL: z.string().default(''), // https://<vault>.vault.azure.net
  KRAVN_KMS_AZURE_KEY: z.string().default(''), // key name, or "name/version"
  KRAVN_KMS_AZURE_TENANT_ID: z.string().default(''),
  KRAVN_KMS_AZURE_CLIENT_ID: z.string().default(''),
  KRAVN_KMS_AZURE_CLIENT_SECRET: z.string().default(''),
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

/** External key-management configuration (see KRAVN_KMS_* env). `none` -> bootstrap-secret key. */
export type KmsConfig =
  | { provider: 'none' }
  | { provider: 'vault'; vault: { addr: string; token: string; key: string; namespace?: string } }
  | {
      provider: 'azure';
      azure: { vaultUrl: string; key: string; tenantId: string; clientId: string; clientSecret: string };
    };

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
  /** Bearer token required by /metrics (Prometheus); '' -> /metrics requires a signed-in user. */
  metricsToken: string;
  /** Whether stdio upstream servers (local process spawn) may be created (admin-only regardless). */
  allowStdio: boolean;
  /** Fastify trustProxy value (false | true | hop count | CIDR/IP list). */
  trustProxy: boolean | number | string;
  /** Redis-protocol URL for the cross-replica shared store; '' -> in-process memory (single-replica). */
  redisUrl: string;
  /** External key management for at-rest encryption; { provider: 'none' } -> bootstrap-secret key. */
  kms: KmsConfig;
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
 * sqlite:// | file:// | <path>  -> SQLite file
 *
 * SQLAlchemy-style "dialect+driver://" DSNs (e.g. postgresql+psycopg://, mysql+pymysql://,
 * mssql+pyodbc://) are accepted too — the "+driver" suffix the Node drivers don't understand is
 * stripped. An unknown "scheme://" fails loudly instead of being silently treated as a file path
 * (which would otherwise mkdir a directory named after the whole connection string).
 */
function resolveDb(databaseUrl: string, dataDir: string): DbConfig {
  const url = databaseUrl.trim();
  if (!url) {
    return sqlite(path.resolve(dataDir, 'kravn.sqlite'));
  }

  const scheme = url.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  // Rewrite the leading "<anything>://" to a canonical scheme the Node driver accepts.
  const canonical = (s: string) => url.replace(/^[^:]+:\/\//, `${s}://`);

  if (scheme && /^postgres(ql)?(\+\w+)?$/.test(scheme)) {
    return { kind: 'pg', client: 'pg', connection: canonical('postgres') };
  }
  if (scheme && /^(mysql|mariadb)(\+\w+)?$/.test(scheme)) {
    return { kind: 'mysql', client: 'mysql2', connection: canonical('mysql') };
  }
  if (scheme && /^(sqlserver|mssql)(\+\w+)?$/.test(scheme)) {
    return parseMssql(canonical('sqlserver'));
  }
  if (scheme === 'sqlite' || scheme === 'file') {
    const file = url.replace(/^[a-z]+:\/\//i, '');
    return sqlite(path.resolve(file || path.join(dataDir, 'kravn.sqlite')));
  }
  if (scheme) {
    throw new Error(
      `Unsupported DATABASE_URL scheme "${scheme}://". Use postgres://, mysql://, sqlserver:// or sqlite:// ` +
        `(SQLAlchemy "+driver" forms like postgresql+psycopg:// are also accepted).`,
    );
  }
  // No "scheme://" at all -> a bare filesystem path to a SQLite file.
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

/** Resolve KRAVN_KMS_* into a validated KmsConfig, failing fast (at boot) if a provider is missing fields. */
function resolveKms(raw: RawEnv): KmsConfig {
  const provider = raw.KRAVN_KMS_PROVIDER;
  if (provider === 'vault') {
    const addr = absoluteUrlOrEmpty('KRAVN_KMS_VAULT_ADDR', raw.KRAVN_KMS_VAULT_ADDR);
    if (!addr || !raw.KRAVN_KMS_VAULT_TOKEN || !raw.KRAVN_KMS_VAULT_KEY) {
      throw new Error(
        'KRAVN_KMS_PROVIDER=vault requires KRAVN_KMS_VAULT_ADDR (http(s) URL), KRAVN_KMS_VAULT_TOKEN and KRAVN_KMS_VAULT_KEY',
      );
    }
    return {
      provider: 'vault',
      vault: {
        addr,
        token: raw.KRAVN_KMS_VAULT_TOKEN,
        key: raw.KRAVN_KMS_VAULT_KEY,
        namespace: raw.KRAVN_KMS_VAULT_NAMESPACE.trim() || undefined,
      },
    };
  }
  if (provider === 'azure') {
    const vaultUrl = absoluteUrlOrEmpty('KRAVN_KMS_AZURE_VAULT_URL', raw.KRAVN_KMS_AZURE_VAULT_URL);
    if (
      !vaultUrl ||
      !raw.KRAVN_KMS_AZURE_KEY ||
      !raw.KRAVN_KMS_AZURE_TENANT_ID ||
      !raw.KRAVN_KMS_AZURE_CLIENT_ID ||
      !raw.KRAVN_KMS_AZURE_CLIENT_SECRET
    ) {
      throw new Error(
        'KRAVN_KMS_PROVIDER=azure requires KRAVN_KMS_AZURE_VAULT_URL, KRAVN_KMS_AZURE_KEY, ' +
          'KRAVN_KMS_AZURE_TENANT_ID, KRAVN_KMS_AZURE_CLIENT_ID and KRAVN_KMS_AZURE_CLIENT_SECRET',
      );
    }
    return {
      provider: 'azure',
      azure: {
        vaultUrl,
        key: raw.KRAVN_KMS_AZURE_KEY,
        tenantId: raw.KRAVN_KMS_AZURE_TENANT_ID,
        clientId: raw.KRAVN_KMS_AZURE_CLIENT_ID,
        clientSecret: raw.KRAVN_KMS_AZURE_CLIENT_SECRET,
      },
    };
  }
  return { provider: 'none' };
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
    metricsToken: raw.KRAVN_METRICS_TOKEN,
    allowStdio: raw.KRAVN_ALLOW_STDIO === 'true',
    trustProxy: parseTrustProxy(raw.KRAVN_TRUST_PROXY),
    redisUrl: raw.KRAVN_REDIS_URL.trim(),
    kms: resolveKms(raw),
  };
}

/** 'false'|'true' -> boolean; a bare number -> hop count; anything else -> a CIDR/IP allowlist string. */
function parseTrustProxy(v: string): boolean | number | string {
  const t = v.trim();
  if (t === 'false') return false;
  if (t === 'true') return true;
  if (/^\d+$/.test(t)) return Number(t);
  return t;
}
