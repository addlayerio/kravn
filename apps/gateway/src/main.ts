import { loadEnv } from './config/env.js';
import { createServices, startBackground, shutdownServices } from './services.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const env = loadEnv();
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
