import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { createAccounts, type Accounts } from './accounts.js';
import { createAttachmentStore, type AttachmentStore } from './attachments/store.js';
import { registerAuthentication } from './auth.js';
import { systemClock, type Clock } from './clock.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/client.js';
import { sendError } from './http-errors.js';
import { createCredentialCipher } from './notify/credentials.js';
import { createNotifier, type Notifier } from './notify/notifier.js';
import { adminRoutes } from './routes/admin.js';
import { attachmentRoutes } from './routes/attachments.js';
import { backupRoutes } from './routes/backup.js';
import { authRoutes } from './routes/auth.js';
import { calendarRoutes } from './routes/calendar.js';
import { commentRoutes } from './routes/comments.js';
import { countdownRoutes } from './routes/countdowns.js';
import { channelRoutes } from './routes/channels.js';
import { changesRoutes } from './routes/changes.js';
import { createHolidayService, type HolidayService } from './holidays/service.js';
import { healthRoutes } from './routes/health.js';
import { holidayRoutes } from './routes/holidays.js';
import { checklistRoutes } from './routes/checklist.js';
import { filterRoutes } from './routes/filters.js';
import { kanbanRoutes } from './routes/kanban.js';
import { listRoutes } from './routes/lists.js';
import { searchRoutes } from './routes/search.js';
import { settingsRoutes } from './routes/settings.js';
import { tagRoutes } from './routes/tags.js';
import { taskRoutes } from './routes/tasks.js';
import { trashRoutes } from './routes/trash.js';
import { recomputeNextInstances } from './repeat.js';
import { createReminderService, type ReminderService } from './reminders/scheduler.js';
import { createFocusService, type FocusService } from './focus/service.js';
import { focusRoutes } from './routes/focus.js';
import { reminderRoutes } from './routes/reminders.js';
import { habitRoutes } from './routes/habits.js';
import { createHabitReminderService, type HabitReminderService } from './reminders/habits.js';
import { createSessionStore, type SessionStore } from './sessions.js';
import type { SyncEntity } from './sync/columns.js';
import { syncEntities as registeredSyncEntities } from './sync/registry.js';
import { createSyncWriter, type SyncWriter } from './sync/sync.js';
import { createTrashService, type TrashService } from './trash.js';

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
    /** 回收站: restore, 彻底删除 and the 30-day cleanup job. */
    trash: TrashService;
    /** Files of 附件 under `<DATA_DIR>/attachments`. */
    attachmentStore: AttachmentStore;
    /** 提醒调度与投递 (see reminders/scheduler.ts). */
    reminders: ReminderService;
    /** 番茄专注 timer state and its 专注结束 notification (see focus/service.ts). */
    focus: FocusService;
    /** 习惯提醒 (see reminders/habits.ts); runs in the 提醒 job. */
    habitReminders: HabitReminderService;
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
  const sync = createSyncWriter(db, clock);
  app.decorate('sync', sync);
  const attachmentStore = createAttachmentStore(config.dataDir);
  app.decorate('attachmentStore', attachmentStore);
  app.decorate('trash', createTrashService({ db, sync, clock, files: attachmentStore, log: app.log }));
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
  // 节假日数据更新: open next instances of 重复任务 move to the corrected 工作日 (用户故事 50).
  app.holidays.onUpdated(async ({ calendar }) => {
    const moved = await recomputeNextInstances(db, app.sync, calendar);
    if (moved.length > 0) app.log.info({ tasks: moved.length }, 'repeat instances recomputed after holiday data update');
  });
  const cipher = config.encryptionKey ? createCredentialCipher(config.encryptionKey) : null;
  app.decorate('notifier', createNotifier({ db, cipher, clock }));
  app.decorate('reminders', createReminderService({ db, sync, clock, notifier: app.notifier, log: app.log }));
  app.decorate('focus', createFocusService({ db, sync, clock, notifier: app.notifier, log: app.log }));
  app.decorate('habitReminders', createHabitReminderService({ db, sync, clock, notifier: app.notifier, log: app.log }));
  await app.register(fastifyCookie);
  registerAuthentication(app, { sessions, config });

  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return sendError(reply, 500, 'internal', '服务器内部错误');
    }
    if (status === 415) return sendError(reply, 415, 'unsupported_media_type', '不支持的 Content-Type');
    return sendError(reply, status, 'bad_request', (error as Error).message);
  });

  healthRoutes(app, { db, config });
  authRoutes(app, { accounts, sessions, config });
  adminRoutes(app, { accounts });
  changesRoutes(app, { db, syncEntities: deps.syncEntities ?? registeredSyncEntities });
  listRoutes(app);
  taskRoutes(app);
  settingsRoutes(app);
  holidayRoutes(app);
  calendarRoutes(app);
  channelRoutes(app, { cipher });
  checklistRoutes(app);
  tagRoutes(app);
  trashRoutes(app);
  attachmentRoutes(app);
  commentRoutes(app);
  filterRoutes(app);
  kanbanRoutes(app);
  searchRoutes(app);
  reminderRoutes(app);
  focusRoutes(app);
  countdownRoutes(app);
  habitRoutes(app);
  backupRoutes(app, { cipher });
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
