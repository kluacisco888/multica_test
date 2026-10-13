import { loadConfig } from '../config.js';
import { createDatabase } from './client.js';
import { rollbackLastMigration } from './migrations.js';

// Usage (inside the app container): node dist/db/rollback-cli.js
// Rolls back exactly one migration. Stop the app first, otherwise it
// re-applies the migration on its next start.
const config = loadConfig(process.env);
const database = createDatabase(config.databaseUrl);
try {
  const tag = await rollbackLastMigration(database.pool);
  console.log(tag ? `Rolled back ${tag}` : 'No applied migrations');
} finally {
  await database.close();
}
