import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { inject } from 'vitest';
import { databaseUrl } from '../../../../scripts/test-postgres.mjs';
import { createDatabase, type Database } from '../../src/db/client.js';

export interface TestDatabase extends Database {
  url: string;
  /** Close connections and drop the database. */
  destroy(): Promise<void>;
}

/** How long `destroy()` waits for the database's sessions to go before it drops anyway. */
const SESSIONS_GONE_TIMEOUT_MS = 10_000;

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
      await admin(async (c) => {
        // pool.end() resolves before the sockets are closed. Dropping while a
        // backend is still there terminates it, and its client gets 57P01 as
        // an unhandled error; so wait (bounded) until the server has none left.
        const deadline = Date.now() + SESSIONS_GONE_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [name]);
          if (rows[0]!.n === 0) break;
          await setTimeout(10);
        }
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      });
    },
  };
}
