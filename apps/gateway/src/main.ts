import { loadEnv } from './config/env.js';
import { createServices, startBackground, shutdownServices, runDbMigrations } from './services.js';
import { buildApp } from './app.js';
import { initOtel, shutdownOtel } from './otel.js';
import { APP_VERSION } from './version.js';

async function main(): Promise<void> {
  const env = loadEnv();

  // `node main.js migrate` -> apply the schema and exit. Used by the Helm migration Job so the schema
  // is migrated once before the pods roll. Without the subcommand, pods still migrate on boot.
  if (process.argv[2] === 'migrate') {
    await runDbMigrations(env);
    process.exit(0);
  }

  // OpenTelemetry tracing (opt-in). Manual instrumentation, so init order isn't critical.
  await initOtel({ enabled: env.otelEnabled, version: APP_VERSION, log: console });

  const services = await createServices(env);
  const app = await buildApp(services);

  await app.listen({ host: env.host, port: env.port });
  app.log.info(`Kravn is up on http://${env.host}:${env.port}`);
  startBackground(services);

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ sig }, 'shutting down');
    try {
      await app.close();
      await shutdownServices(services);
      await shutdownOtel();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
