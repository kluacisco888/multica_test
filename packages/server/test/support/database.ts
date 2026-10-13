import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { databaseUrl } from '../../../../scripts/test-postgres.mjs';
import { createDatabase, type Database } from '../../src/db/client.js';

export interface TestDatabase extends Database {
  url: string;
  /** Close connections and drop the database. */
  destroy(): Promise<void>;
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('testDatabaseUrl') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A fresh, empty database on the test server; one per test file keeps files isolated. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `dida_test_${randomUUID().replaceAll('-', '')}`;
  // Identifier is generated above from hex only, so quoting is sufficient.
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  const url = databaseUrl(inject('testDatabaseUrl'), name);
  const database = createDatabase(url);
  return {
    ...database,
    url,
    async destroy() {
      await database.close();
      await admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}
