import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrations.js';

const config = loadConfig(process.env);
const database = createDatabase(config.databaseUrl);

await mkdir(path.join(config.dataDir, 'attachments'), { recursive: true });
await runMigrations(database.db);

const app = await buildApp({
  config,
  db: database.db,
  logger: { level: config.logLevel },
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await database.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
app.log.info({ publicUrl: config.publicUrl }, 'dida-clone ready');
