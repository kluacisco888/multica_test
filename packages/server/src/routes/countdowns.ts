import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  compareCountdowns,
  compareSortKeys,
  countdownsQuerySchema,
  createCountdownRequestSchema,
  keyBetween,
  todayIn,
  updateCountdownRequestSchema,
  type Countdown,
  type CountdownsResponse,
} from '@dida/shared';
import { lunarLabel, nextOccurrence } from '@dida/shared/countdown';
import { sessionUser } from '../auth.js';
import type { Executor } from '../db/client.js';
import { countdowns } from '../db/schema/countdowns.js';
import { sendValidationError } from '../http-errors.js';
import { readSettings } from '../settings.js';
import { findOwned } from '../sync/sync.js';
import { notFound, Rejection, respond } from './respond.js';
import { checkChannels } from './tasks.js';

type Params = { Params: { id: string } };
type CountdownRow = typeof countdowns.$inferSelect;

/** API form, with the occurrence shown on `today` (the user's time zone). */
export function countdownToApi(row: CountdownRow, today: string): Countdown {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    date: row.date,
    calendar: row.calendar,
    repeat: row.repeat,
    reminders: row.reminders,
    reminderChannelIds: row.reminderChannelIds ?? null,
    pinned: row.pinned,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revision: row.revision,
    lunar: row.calendar === 'lunar' ? lunarLabel(row.date) : null,
    next: nextOccurrence(row, today),
  };
}

async function userToday(app: FastifyInstance, db: Executor, userId: string): Promise<string> {
  return todayIn(app.clock.now(), (await readSettings(db, userId)).timeZone);
}

/** 倒数日 (spec 用户故事 99–101): list, create, edit, 置顶, 归档, delete. Reminders are scheduled by the reminder service's write hook. */
export function countdownRoutes(app: FastifyInstance) {
  app.get('/api/countdowns', async (request, reply) => {
    const query = countdownsQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const userId = sessionUser(request).id;
    const archived = query.data.archived === 'true';
    const rows = await app.db
      .select()
      .from(countdowns)
      .where(and(eq(countdowns.userId, userId), isNull(countdowns.deletedAt), archived ? isNotNull(countdowns.archivedAt) : isNull(countdowns.archivedAt)));
    const today = await userToday(app, app.db, userId);
    const response: CountdownsResponse = { countdowns: rows.map((row) => countdownToApi(row, today)).sort(compareCountdowns) };
    return response;
  });

  app.get<Params>('/api/countdowns/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const row = await findOwned(app.db, countdowns, userId, request.params.id);
    if (!row) return notFound(reply);
    return countdownToApi(row, await userToday(app, app.db, userId));
  });

  app.post('/api/countdowns', async (request, reply) => {
    const body = createCountdownRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    const { id, sortOrder, ...fields } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          await checkChannels(tx, userId, fields.reminderChannelIds);
          const existing = await tx
            .select({ sortOrder: countdowns.sortOrder })
            .from(countdowns)
            .where(and(eq(countdowns.userId, userId), isNull(countdowns.deletedAt)));
          const last = existing.map((r) => r.sortOrder).sort(compareSortKeys).at(-1) ?? null;
          const row = await ops.insert(countdowns, {
            ...(id ? { id } : {}),
            ...fields,
            archivedAt: null,
            sortOrder: sortOrder ?? keyBetween(last, null),
          });
          return { row, today: await userToday(app, tx, userId) };
        }),
      ({ row, today }) => reply.code(201).send(countdownToApi(row, today)),
    );
  });

  app.patch<Params>('/api/countdowns/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const found = await findOwned(app.db, countdowns, userId, request.params.id);
    if (!found) return notFound(reply);
    const body = updateCountdownRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const { archived, ...patch } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const current = await findOwned(tx, countdowns, userId, found.id);
          if (!current) throw new Rejection(notFound);
          await checkChannels(tx, userId, patch.reminderChannelIds);
          const archivedAt = archived === undefined ? current.archivedAt : archived ? (current.archivedAt ?? app.clock.now()) : null;
          const row = await ops.update(countdowns, current.id, { ...patch, archivedAt });
          if (!row) throw new Rejection(notFound);
          return { row, today: await userToday(app, tx, userId) };
        }),
      ({ row, today }) => countdownToApi(row, today),
    );
  });

  app.delete<Params>('/api/countdowns/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const found = await findOwned(app.db, countdowns, userId, request.params.id);
    if (!found) return notFound(reply);
    const deleted = await app.sync.transaction(userId, (ops) => ops.softDelete(countdowns, found.id));
    if (!deleted) return notFound(reply);
    return reply.code(204).send();
  });
}
