/**
 * Chambers API Server
 *
 * Entry point for the backend service
 */

import { buildApp } from './app.js';
import { env } from './config/env.js';
import { disconnectDatabase } from './config/database.js';

async function main(): Promise<void> {
  const app = await buildApp();

  // Graceful shutdown
  const signals = ['SIGINT', 'SIGTERM'] as const;

  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down gracefully...`);

      try {
        await app.close();
        await disconnectDatabase();
        app.log.info('Server closed successfully');
        process.exit(0);
      } catch (err) {
        app.log.error(err, 'Error during shutdown');
        process.exit(1);
      }
    });
  }

  // Start server
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`
    ╔═══════════════════════════════════════════════════╗
    ║                                                   ║
    ║   Chambers API Server                             ║
    ║   Running on http://${env.HOST}:${env.PORT}                 ║
    ║   Environment: ${env.NODE_ENV.padEnd(11)}                    ║
    ║                                                   ║
    ╚═══════════════════════════════════════════════════╝
    `);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
