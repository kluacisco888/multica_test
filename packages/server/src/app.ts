import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { createAccounts, type Accounts } from './accounts.js';
import { registerAuthentication } from './auth.js';
import { systemClock, type Clock } from './clock.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/client.js';
import { sendError } from './http-errors.js';
import { createCredentialCipher } from './notify/credentials.js';
import { createNotifier, type Notifier } from './notify/notifier.js';
import { authRoutes } from './routes/auth.js';
import { channelRoutes } from './routes/channels.js';
import { changesRoutes } from './routes/changes.js';
import { createHolidayService, type HolidayService } from './holidays/service.js';
import { healthRoutes } from './routes/health.js';
import { holidayRoutes } from './routes/holidays.js';
import { listRoutes } from './routes/lists.js';
import { settingsRoutes } from './routes/settings.js';
import { taskRoutes } from './routes/tasks.js';
import { createSessionStore, type SessionStore } from './sessions.js';
import type { SyncEntity } from './sync/columns.js';
import { syncEntities as registeredSyncEntities } from './sync/registry.js';
import { createSyncWriter, type SyncWriter } from './sync/sync.js';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  clock?: Clock;
  syncEntities?: readonly SyncEntity[];
  logger?: FastifyServerOptions['logger'];
  /** Extra routes (tests register fixture resource routes); added after the built-in ones. */
  routes?: (app: FastifyInstance) => void;
}

declare module 'fastify' {
  interface FastifyInstance {
    clock: Clock;
    db: Db;
    sync: SyncWriter;
    accounts: Accounts;
    sessions: SessionStore;
    holidays: HolidayService;
    /** Delivers messages to 通知渠道; shared by 提醒, 专注 and 习惯. */
    notifier: Notifier;
  }
}

function trustHops(hops: number) {
  return (_address: string, hop: number) => hop < hops;
}

/** Build the Fastify app without listening; tests call this with injected deps. */
export async function buildApp(deps: AppDeps) {
  const { config, db } = deps;
  const clock = deps.clock ?? systemClock;
  const sessions = createSessionStore(db, clock);
  const accounts = createAccounts(db, sessions, clock);

  const app = Fastify({
    logger: deps.logger ?? false,
    // A number means "trust this many hops"; Fastify's typings take it as a function.
    trustProxy:
      typeof config.trustProxy === 'number'
        ? trustHops(config.trustProxy)
        : config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  app.decorate('clock', clock);
  app.decorate('db', db);
  app.decorate('sync', createSyncWriter(db, clock));
  app.decorate('accounts', accounts);
  app.decorate('sessions', sessions);
  app.decorate(
    'holidays',
    createHolidayService({
      db,
      clock,
      log: app.log,
      dataUrl: config.holidayDataUrl,
      timezone: config.defaultTimezone,
    }),
  );
  const cipher = config.encryptionKey ? createCredentialCipher(config.encryptionKey) : null;
  app.decorate('notifier', createNotifier({ db, cipher, clock }));
  await app.register(fastifyCookie);
  registerAuthentication(app, { sessions, config });

  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return sendError(reply, 500, 'internal', '服务器内部错误');
    }
    return sendError(reply, status, 'bad_request', (error as Error).message);
  });

  healthRoutes(app, { db, config });
  authRoutes(app, { accounts, sessions, config });
  changesRoutes(app, { db, syncEntities: deps.syncEntities ?? registeredSyncEntities });
  listRoutes(app);
  taskRoutes(app);
  settingsRoutes(app);
  holidayRoutes(app);
  channelRoutes(app, { cipher });
  deps.routes?.(app);

  if (config.webDistDir) {
    await app.register(fastifyStatic, { root: path.resolve(config.webDistDir) });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url === '/api' || request.url.startsWith('/api/');
    // Client-side routes of the single-page app fall back to index.html.
    if (!isApi && config.webDistDir && request.method === 'GET') {
      return reply.sendFile('index.html');
    }
    return sendError(reply, 404, 'not_found', '资源不存在');
  });

  return app;
}
