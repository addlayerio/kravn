import type { Logger } from 'pino';
import { loadEnv, type Env } from './config/env.js';
import { resolveSecret } from './config/secret.js';
import { createLogger } from './logger.js';
import { createKnex } from './db/knex.js';
import { createStore, type Store } from './db/store.js';
import { runMigrations } from './db/migrations.js';
import { createRepos, type Repos } from './db/repos.js';
import { Encryptor } from './crypto.js';
import { SettingsService } from './settings/settings.service.js';
import { JwtService } from './auth/jwt.js';
import { AuthService } from './auth/auth.service.js';
import { SsoService } from './auth/sso.service.js';
import { SsrfGuard } from './http/ssrf.js';
import { installGlobalSsrfDispatcher } from './http/client.js';
import { UpstreamManager } from './mcp/upstream.js';
import { RegistryService } from './mcp/registry.service.js';
import { DownstreamMcp } from './mcp/downstream.js';
import { LogStore } from './logstore.js';
import { Metrics } from './metrics.js';
import { PluginManager } from './plugins/manager.js';
import { ChatService } from './chat/chat.service.js';
import { PyodideExecutor, type CodeExecutor } from './interpreter/executor.js';
import { nativePlugins } from './plugins/native.js';

export interface Services {
  env: Env;
  log: Logger;
  store: Store;
  repos: Repos;
  settings: SettingsService;
  encryptor: Encryptor;
  jwt: JwtService;
  auth: AuthService;
  sso: SsoService;
  ssrf: SsrfGuard;
  upstream: UpstreamManager;
  registry: RegistryService;
  downstream: DownstreamMcp;
  plugins: PluginManager;
  chat: ChatService;
  interpreter: CodeExecutor;
  logstore: LogStore;
  metrics: Metrics;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
  }
}

/** Build and initialize every service. Connecting to upstreams is left to start() (background). */
export async function createServices(env: Env = loadEnv()): Promise<Services> {
  const log = createLogger(env);
  const secret = resolveSecret(env);

  const knex = createKnex(env.db);
  await runMigrations(knex, env.db);
  const store = createStore(env.db.kind, knex);
  const repos = createRepos(store);

  const encryptor = new Encryptor(secret);
  const jwt = new JwtService(secret);

  const settings = new SettingsService(repos.settings, log);
  await settings.init();

  const logstore = new LogStore();
  const metrics = new Metrics();

  const ssrf = new SsrfGuard(settings, log);
  installGlobalSsrfDispatcher(ssrf);

  const upstream = new UpstreamManager(log, () => settings.get().mcp.requestTimeoutMs);
  // The code interpreter is shipped as a native plugin (privileged runtime); build it with the executor injected.
  const interpreter = new PyodideExecutor(log);
  const plugins = new PluginManager(env.pluginsDir, repos, log, logstore, nativePlugins({ interpreter }));
  upstream.setPluginManager(plugins);
  const registry = new RegistryService({ repos, encryptor, upstream, settings, ssrf, log, logstore, metrics, plugins });
  const downstream = new DownstreamMcp(repos, registry, settings, plugins);
  plugins.onChange = () =>
    registry.syncPluginServers().catch((err) => log.warn({ err }, 'plugin-server sync failed'));
  await plugins.scan();

  const auth = new AuthService(repos, settings, env, log);
  await auth.bootstrapFromEnv();
  const sso = new SsoService(repos, encryptor, jwt, settings, log);
  const chat = new ChatService(repos, encryptor, registry, log, plugins);

  log.info({ db: env.db.kind, dataDir: env.dataDir }, 'Kravn services initialized');

  return { env, log, store, repos, settings, encryptor, jwt, auth, sso, ssrf, upstream, registry, downstream, plugins, chat, interpreter, logstore, metrics };
}

/** Kick off background work after the HTTP server is listening. */
export function startBackground(services: Services): void {
  services.registry.syncAll().catch((err) => services.log.warn({ err }, 'initial upstream sync failed'));
}

export async function shutdownServices(services: Services): Promise<void> {
  await services.upstream.disconnectAll().catch(() => {});
  await services.interpreter.dispose().catch(() => {});
  await services.store.close().catch(() => {});
}
