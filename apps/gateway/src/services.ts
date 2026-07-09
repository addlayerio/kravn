import type { Logger } from 'pino';
import type { Knex } from 'knex';
import { loadEnv, type Env } from './config/env.js';
import { resolveSecret } from './config/secret.js';
import { createLogger } from './logger.js';
import { createKnex } from './db/knex.js';
import { createStore, type Store } from './db/store.js';
import { runMigrations } from './db/migrations.js';
import { createRepos, type Repos } from './db/repos.js';
import { Encryptor } from './crypto.js';
import { KeyManager } from './crypto/kms/key-manager.js';
import { SettingsService } from './settings/settings.service.js';
import { JwtService } from './auth/jwt.js';
import { AuthService } from './auth/auth.service.js';
import { ScimService } from './scim/scim.service.js';
import { SsoService } from './auth/sso.service.js';
import { OAuthService } from './auth/oauth.service.js';
import { SsrfGuard } from './http/ssrf.js';
import { installGlobalSsrfDispatcher } from './http/client.js';
import { UpstreamManager } from './mcp/upstream.js';
import { RegistryService } from './mcp/registry.service.js';
import { AuditService } from './audit/audit.service.js';
import { ApprovalService } from './approvals/approval.service.js';
import { UsageService } from './usage/usage.service.js';
import { UpstreamOAuthService } from './auth/upstream-oauth.service.js';
import { EventBus } from './events/bus.js';
import { DownstreamMcp } from './mcp/downstream.js';
import { LogStore } from './logstore.js';
import { Metrics } from './metrics.js';
import { PluginManager } from './plugins/manager.js';
import { ChatService } from './chat/chat.service.js';
import { PyodideExecutor, type CodeExecutor } from './interpreter/executor.js';
import { nativePlugins } from './plugins/native.js';
import { createSharedStore, type SharedStore } from './cluster/shared-store.js';

export interface Services {
  env: Env;
  log: Logger;
  store: Store;
  repos: Repos;
  settings: SettingsService;
  encryptor: Encryptor;
  jwt: JwtService;
  auth: AuthService;
  scim: ScimService;
  sso: SsoService;
  oauth: OAuthService;
  ssrf: SsrfGuard;
  upstream: UpstreamManager;
  registry: RegistryService;
  /** Upstream OAuth 2.1 client — connect to OAuth-protected remote MCP servers. */
  upstreamOAuth: UpstreamOAuthService;
  /** In-process event bus pushed to operator UIs over SSE (live updates instead of polling). */
  events: EventBus;
  downstream: DownstreamMcp;
  plugins: PluginManager;
  chat: ChatService;
  interpreter: CodeExecutor;
  logstore: LogStore;
  metrics: Metrics;
  /** Immutable, hash-chained, SIEM-exported audit trail (config changes, etc.). */
  audit: AuditService;
  /** Human-in-the-loop maker-checker: holds high-risk tool calls until an admin approves/denies them. */
  approvals: ApprovalService;
  /** Cost/quota governance: meters tool calls + LLM tokens and enforces org-wide daily budgets. */
  usage: UsageService;
  /** Cross-replica shared state (rate-limit counters, in-flight OIDC login); memory-backed when no Redis URL. */
  sharedStore: SharedStore;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
  }
}

/** Warn when KRAVN_DB_SCHEMA was set on a dialect that can't honor it. */
function warnSchemaDialect(env: Env, log: Logger): void {
  if (env.db.schema && (env.db.client === 'better-sqlite3' || env.db.client === 'mysql2')) {
    log.warn(
      { client: env.db.client },
      'KRAVN_DB_SCHEMA is not applicable to this dialect (SQLite: N/A; MySQL: the schema is the database — set it in DATABASE_URL); ignored',
    );
  }
}

/** Prepare the schema (schema-aware migrations) and log how the requested DB schema was applied. */
async function migrateDatabase(env: Env, knex: Knex, log: Logger): Promise<void> {
  warnSchemaDialect(env, log);
  const schemaResult = await runMigrations(knex, env.db);
  if (schemaResult.requested && !schemaResult.applied) {
    log.warn(
      { requested: schemaResult.schema, effective: schemaResult.effective, client: env.db.client },
      'KRAVN_DB_SCHEMA could not be applied — tables were created in the effective default schema. On SQL Server connect with a non-sysadmin login (Kravn repoints its DEFAULT_SCHEMA) or pre-set the login DEFAULT_SCHEMA to the target',
    );
  } else if (schemaResult.requested && schemaResult.applied) {
    log.info({ schema: schemaResult.schema, client: env.db.client }, 'KRAVN_DB_SCHEMA applied — tables built inside schema');
  }
}

/**
 * Run schema migrations standalone, then release the connection. Entry point for the `migrate` subcommand
 * (`node main.js migrate`), used by the Helm migration Job to apply the schema once before the pods roll.
 */
export async function runDbMigrations(env: Env = loadEnv()): Promise<void> {
  const log = createLogger(env);
  const knex = createKnex(env.db);
  try {
    await migrateDatabase(env, knex, log);
    log.info({ db: env.db.kind }, 'schema migrations complete');
  } finally {
    await knex.destroy();
  }
}

/** Build and initialize every service. Connecting to upstreams is left to start() (background). */
export async function createServices(env: Env = loadEnv()): Promise<Services> {
  const log = createLogger(env);
  const secret = resolveSecret(env);

  const knex = createKnex(env.db);
  // Always safe to call: Knex serializes concurrent runs with a lock, and pending migrations are a
  // no-op once a migration step (the Helm migration Job, `node main.js migrate`) has already applied them.
  await migrateDatabase(env, knex, log);
  const store = createStore(env.db.kind, knex);
  const repos = createRepos(store);

  // Resolve the at-rest encryption key set. Default: derived from the bootstrap secret. With KRAVN_KMS_*
  // set: a DEK unwrapped from an external KMS/HSM (envelope encryption), with the bootstrap key retained
  // as a read fallback so existing secrets still decrypt. JWT signing stays on the bootstrap secret.
  const keyManager = await KeyManager.create({ env, secret, store, log });
  const encryptor = keyManager.encryptor;
  const jwt = new JwtService(secret);

  const settings = new SettingsService(repos.settings, log);
  await settings.init();

  const logstore = new LogStore();
  const metrics = new Metrics();
  const sharedStore = await createSharedStore(env, log);

  const ssrf = new SsrfGuard(settings, log);
  installGlobalSsrfDispatcher(ssrf);

  const audit = new AuditService({ repos, log, ssrf, settings });
  await audit.init();

  const upstream = new UpstreamManager(log, () => settings.get().mcp.requestTimeoutMs);
  // The code interpreter is shipped as a native plugin (privileged runtime); build it with the executor injected.
  const interpreter = new PyodideExecutor(log);
  const events = new EventBus();
  // Human-in-the-loop approvals: the approval-gate native hook holds a call and blocks in ApprovalService until
  // an admin decides (or it times out). Built before the plugin manager so it can be injected into the hook.
  const approvals = new ApprovalService({ repos, audit, events, log });
  const plugins = new PluginManager(env.pluginsDir, repos, log, logstore, nativePlugins({ interpreter, approvals }), encryptor);
  upstream.setPluginManager(plugins);
  const upstreamOAuth = new UpstreamOAuthService({ repos, encryptor, ssrf, log });
  // Cost/quota governance: meters tool calls + LLM tokens and enforces org-wide daily budgets.
  const usage = new UsageService({ repos, settings, metrics, audit, log });
  const registry = new RegistryService({ repos, encryptor, upstream, settings, ssrf, log, logstore, metrics, plugins, upstreamOAuth, events, audit, usage });
  const downstream = new DownstreamMcp(repos, registry, settings, plugins);
  plugins.onChange = () => {
    downstream.invalidateRegistryCache(); // a plugin toggle changes the tool/resource/prompt set — reflect now
    registry.syncPluginServers().catch((err) => log.warn({ err }, 'plugin-server sync failed'));
    events.fire('registry'); // push the change to connected operator UIs
  };
  await plugins.scan();

  const scim = new ScimService(store);
  const auth = new AuthService(repos, settings, env, log);
  await auth.bootstrapFromEnv();
  // Guarantee the Platform Administrator Team exists and holds every admin (backfills pre-feature installs,
  // and self-heals against lockout). Membership in it gates the whole admin console.
  await repos.teams
    .reconcilePlatformAdmins()
    .catch((err) => log.error({ err }, 'platform-admin reconciliation failed (admins keep console access via role)'));
  const sso = new SsoService(repos, encryptor, jwt, settings, log, sharedStore);
  const oauth = new OAuthService(repos, jwt, settings);
  const chat = new ChatService(repos, encryptor, registry, log, plugins, settings, usage);

  log.info({ db: env.db.kind, dataDir: env.dataDir }, 'Kravn services initialized');

  return { env, log, store, repos, settings, encryptor, jwt, auth, scim, sso, oauth, ssrf, upstream, registry, upstreamOAuth, events, downstream, plugins, chat, interpreter, logstore, metrics, audit, approvals, usage, sharedStore };
}

/** Kick off background work after the HTTP server is listening. */
export function startBackground(services: Services): void {
  services.registry.syncAll().catch((err) => services.log.warn({ err }, 'initial upstream sync failed'));
}

export async function shutdownServices(services: Services): Promise<void> {
  await services.upstream.disconnectAll().catch(() => {});
  await services.interpreter.dispose().catch(() => {});
  await services.sharedStore.close().catch(() => {});
  await services.store.close().catch(() => {});
}
