import { env } from './config/env.js';
import { createApp } from './app.js';
import { registerCronJobs, registerSheetsSync } from './jobs/index.js';
import { connectMongo } from './config/db.js';
import { logger } from './utils/logger.js';

logger.info('[SERVER] Starting Lease Management backend...');

/**
 * Node terminates the whole process on an unhandled promise rejection by
 * default (since Node 15) — one Google Sheets quota error (or any other
 * error) thrown from code that isn't awaited inside a request's try/catch
 * would otherwise take the entire server down for every user until someone
 * manually restarts it. Log and keep serving instead.
 */
process.on('unhandledRejection', (reason) => {
  logger.error('[ERROR] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('[ERROR] Uncaught exception:', err);
});

// Same Mongo database/connection string as the other two apps (shared by
// design — see the split-into-three-apps plan) — connect before serving,
// since routes call getCollection() synchronously off the shared connection.
await connectMongo();

const app = createApp();

app.listen(env.port, env.host, () => {
  logger.info(`[SERVER] Lease Management API running on ${env.host}:${env.port} (${env.nodeEnv})`);
  // This backend owns its own cron + Sheets<->Mongo sync (see jobs/index.js)
  // — scoped to only the jobs Lease Management's domain needs, independent
  // of the other two apps' backends. See splendid-rolling-candy.md Phase 1c.
  if (env.enableCron) {
    registerCronJobs();
    logger.info('[SERVER] Cron jobs ENABLED (ENABLE_CRON=true)');
  } else {
    logger.info('[SERVER] Cron jobs disabled (set ENABLE_CRON=true in .env to enable the automation triggers)');
  }

  if (env.enableSheetsSync) {
    registerSheetsSync();
    logger.info('[SYNC] Background sync service started');
  } else {
    logger.info('[SERVER] Sheets<->Mongo sync disabled (set ENABLE_SHEETS_SYNC=true in .env to enable it)');
  }
});
