import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrations.js';
import { startBackgroundJobs, type BackgroundJobs } from './jobs.js';

const config = loadConfig(process.env);
const database = createDatabase(config.databaseUrl);

await mkdir(path.join(config.dataDir, 'attachments'), { recursive: true });
await runMigrations(database.db);

const app = await buildApp({
  config,
  db: database.db,
  logger: { level: config.logLevel },
});
// Partial uploads from a crash are never finished; drop them so backups stay clean.
await app.attachmentStore.cleanIncoming();
// 附件 / 评论 that purges before EURO-32 left behind; idempotent, so it runs on every start.
const cleared = await app.trash.cleanUpPurged();
if (cleared > 0) app.log.info({ cleared }, '回收站: cleared attachments and comments of purged tasks');

if (!config.encryptionKey) {
  app.log.warn('APP_ENCRYPTION_KEY is not set: 通知渠道 cannot be saved or used (generate one with `openssl rand -base64 32`)');
}

const bootstrap = await app.accounts.bootstrapAdmin(config.initialAdmin);
if (bootstrap === 'created') {
  app.log.info({ username: config.initialAdmin.username }, 'created the initial administrator from .env');
} else if (bootstrap === 'not_configured' && (await app.accounts.list()).length === 0) {
  app.log.warn(
    'no user exists: set INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD in .env, or run `dida create-user <name> --admin`',
  );
}

let jobs: BackgroundJobs | null = null;
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  await jobs?.stop();
  await app.close();
  await database.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
jobs = await startBackgroundJobs({
  databaseUrl: config.databaseUrl,
  holidays: app.holidays,
  trash: app.trash,
  reminders: app.reminders,
  timezone: config.defaultTimezone,
  log: app.log,
});
app.log.info({ publicUrl: config.publicUrl }, 'dida-clone ready');
