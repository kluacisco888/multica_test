import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { ResolveUser } from '../../src/auth.js';
import type { Clock } from '../../src/clock.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrations.js';
import { users } from '../../src/db/schema/index.js';
import type { SyncEntity } from '../../src/sync/columns.js';
import { createTestDatabase, type TestDatabase } from './database.js';

/** Header the test resolver reads the session user id from (stand-in until EURO-5). */
export const TEST_USER_HEADER = 'x-test-user-id';

const headerResolver: ResolveUser = async (request) => {
  const id = request.headers[TEST_USER_HEADER];
  return typeof id === 'string' ? { id } : null;
};

export interface TestApp {
  app: FastifyInstance;
  database: TestDatabase;
  config: AppConfig;
  createUser(username: string): Promise<{ id: string; headers: Record<string, string> }>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  clock?: Clock;
  syncEntities?: readonly SyncEntity[];
  env?: Record<string, string>;
  resolveUser?: ResolveUser;
  /** Runs after migrations, before the app is built (e.g. create fixture tables). */
  prepare?: (database: TestDatabase) => Promise<void>;
}

/** Real Fastify app on a fresh, migrated PostgreSQL database. Call via `app.inject()`. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database = await createTestDatabase();
  await runMigrations(database.db);
  await options.prepare?.(database);
  const config = loadConfig({ DATABASE_URL: database.url, LOG_LEVEL: 'silent', ...options.env });
  const app = await buildApp({
    config,
    db: database.db,
    resolveUser: options.resolveUser ?? headerResolver,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.syncEntities ? { syncEntities: options.syncEntities } : {}),
  });
  await app.ready();
  return {
    app,
    database,
    config,
    async createUser(username) {
      const [user] = await database.db.insert(users).values({ username }).returning();
      if (!user) throw new Error('user insert failed');
      return { id: user.id, headers: { [TEST_USER_HEADER]: user.id } };
    },
    async close() {
      await app.close();
      await database.destroy();
    },
  };
}
