import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../../src/app.js';
import { SESSION_COOKIE } from '../../src/auth.js';
import type { Clock } from '../../src/clock.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrations.js';
import type { SyncEntity } from '../../src/sync/columns.js';
import { createTestDatabase, type TestDatabase } from './database.js';

export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 'test-key').toString('base64');

export interface TestUser {
  id: string;
  username: string;
  password: string;
  /** Request headers carrying this user's session cookie. */
  headers: Record<string, string>;
}

export interface TestApp {
  app: FastifyInstance;
  database: TestDatabase;
  config: AppConfig;
  /** Create a user through the accounts module and log in over HTTP. */
  createUser(username: string, options?: { password?: string; isAdmin?: boolean }): Promise<TestUser>;
  /** `POST /api/auth/login`; on success `headers` carries the new session cookie. */
  login(username: string, password: string): Promise<{ statusCode: number; body: unknown; headers: Record<string, string> }>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  clock?: Clock;
  syncEntities?: readonly SyncEntity[];
  env?: Record<string, string>;
  /** Extra (fixture) routes registered like real resource routes. */
  routes?: (app: FastifyInstance) => void;
  /** Runs after migrations, before the app is built (e.g. create fixture tables). */
  prepare?: (database: TestDatabase) => Promise<void>;
  /** Fastify logger options, e.g. a capturing `stream` to assert on log lines. */
  logger?: AppDeps['logger'];
}

/** `cookie` request header from a response's Set-Cookie for the session. */
export function sessionCookieHeader(setCookie: string | string[] | undefined): Record<string, string> {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const session = all.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return session ? { cookie: session.split(';')[0] as string } : {};
}

/** Real Fastify app on a fresh, migrated PostgreSQL database. Call via `app.inject()`. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database = await createTestDatabase();
  await runMigrations(database.db);
  await options.prepare?.(database);
  // Own data volume per test app: 附件 land in `<dataDir>/attachments`.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dida-test-data-'));
  const config = loadConfig({
    DATABASE_URL: database.url,
    DATA_DIR: dataDir,
    LOG_LEVEL: 'silent',
    // Fixed test key so 通知渠道 work; pass `APP_ENCRYPTION_KEY: ''` to test without one.
    APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ...options.env,
  });
  const app = await buildApp({
    config,
    db: database.db,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.syncEntities ? { syncEntities: options.syncEntities } : {}),
    ...(options.routes ? { routes: options.routes } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  await app.ready();

  async function login(username: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    return { statusCode: res.statusCode, body: res.json(), headers: sessionCookieHeader(res.headers['set-cookie']) };
  }

  return {
    app,
    database,
    config,
    login,
    async createUser(username, { password = `pw-${username}-12345`, isAdmin = false } = {}) {
      const account = await app.accounts.create({ username, password, isAdmin });
      const res = await login(username, password);
      if (res.statusCode !== 200) throw new Error(`login of test user failed: ${res.statusCode}`);
      return { id: account.id, username, password, headers: res.headers };
    },
    async close() {
      await app.close();
      await database.destroy();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
