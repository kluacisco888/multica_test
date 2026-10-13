import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  createHabitRequestSchema,
  putCheckinRequestSchema,
  todayIn,
  tryParseCivilDate,
  updateHabitRequestSchema,
  type Habit,
  type HabitsResponse,
} from '@dida/shared';
import { sessionUser } from '../auth.js';
import type { Executor } from '../db/client.js';
import { habitCheckins, habits } from '../db/schema/habits.js';
import { notificationChannels } from '../db/schema/channels.js';
import { sendError, sendValidationError } from '../http-errors.js';
import { readSettings } from '../settings.js';
import { findOwned } from '../sync/sync.js';
import { invalidChannels, notFound, Rejection, respond } from './respond.js';

type HabitRow = typeof habits.$inferSelect;
type CheckinRow = typeof habitCheckins.$inferSelect;
type Params = { Params: { id: string } };
type DayParams = { Params: { id: string; date: string } };

export function habitToApi(row: HabitRow, checkins: CheckinRow[] = []): Habit {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revision: row.revision,
    name: row.name,
    color: row.color,
    frequency: row.frequency,
    goal: row.goal,
    reminders: row.reminders,
    reminderChannelIds: row.reminderChannelIds,
    startDate: row.startDate,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    checkins: checkins
      .filter((c) => c.habitId === row.id && c.deletedAt === null)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((c) => ({ date: c.date, count: c.count })),
  };
}

/** Live 打卡 of these habits. */
export async function liveCheckins(db: Executor, userId: string, habitIds: string[]): Promise<CheckinRow[]> {
  if (habitIds.length === 0) return [];
  return db
    .select()
    .from(habitCheckins)
    .where(and(eq(habitCheckins.userId, userId), inArray(habitCheckins.habitId, habitIds), isNull(habitCheckins.deletedAt)));
}

async function withCheckins(db: Executor, userId: string, row: HabitRow): Promise<Habit> {
  return habitToApi(row, await liveCheckins(db, userId, [row.id]));
}

async function channelsOwned(db: Executor, userId: string, ids: string[] | null | undefined): Promise<boolean> {
  if (!ids || ids.length === 0) return true;
  const rows = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(and(eq(notificationChannels.userId, userId), inArray(notificationChannels.id, ids), isNull(notificationChannels.deletedAt)));
  return rows.length === new Set(ids).size;
}

const habitArchived = (reply: Parameters<typeof notFound>[0]) => sendError(reply, 400, 'habit_archived', '已归档的习惯不能打卡');
const invalidDate = (reply: Parameters<typeof notFound>[0]) => sendError(reply, 400, 'invalid_date', '日期格式应为 YYYY-MM-DD');
const futureDate = (reply: Parameters<typeof notFound>[0]) => sendError(reply, 400, 'future_date', '不能给以后的日期打卡');

/** 习惯打卡 (spec 用户故事 93–98). */
export function habitRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { archived?: string } }>('/api/habits', async (request) => {
    const userId = sessionUser(request).id;
    const archived = request.query.archived === 'true';
    const rows = await app.db
      .select()
      .from(habits)
      .where(and(eq(habits.userId, userId), isNull(habits.deletedAt), archived ? isNotNull(habits.archivedAt) : isNull(habits.archivedAt)))
      .orderBy(asc(habits.createdAt), asc(habits.id));
    const checkins = await liveCheckins(app.db, userId, rows.map((r) => r.id));
    const response: HabitsResponse = { habits: rows.map((r) => habitToApi(r, checkins)) };
    return response;
  });

  app.get<Params>('/api/habits/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const row = await findOwned(app.db, habits, userId, request.params.id);
    if (!row) return notFound(reply);
    return withCheckins(app.db, userId, row);
  });

  app.post('/api/habits', async (request, reply) => {
    const body = createHabitRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    const { id, name, color = null, frequency, goal, reminders, reminderChannelIds = null, startDate } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          if (!(await channelsOwned(tx, userId, reminderChannelIds))) throw new Rejection(invalidChannels);
          const { timeZone } = await readSettings(tx, userId);
          return ops.insert(habits, {
            ...(id ? { id } : {}),
            name,
            color,
            frequency,
            goal,
            reminders,
            reminderChannelIds,
            startDate: startDate ?? todayIn(app.clock.now(), timeZone),
            archivedAt: null,
          });
        }),
      (row) => reply.code(201).send(habitToApi(row)),
    );
  });

  app.patch<Params>('/api/habits/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const habit = await findOwned(app.db, habits, userId, request.params.id);
    if (!habit) return notFound(reply);
    const body = updateHabitRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const { archived, ...patch } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          if (!(await channelsOwned(tx, userId, patch.reminderChannelIds))) throw new Rejection(invalidChannels);
          const archivedAt = archived === undefined ? {} : { archivedAt: archived ? (habit.archivedAt ?? app.clock.now()) : null };
          const row = await ops.update(habits, habit.id, { ...patch, ...archivedAt });
          if (!row) throw new Rejection(notFound);
          return withCheckins(tx, userId, row);
        }),
      (result) => result,
    );
  });

  /** 删除习惯: the habit and its 打卡 become tombstones. */
  app.delete<Params>('/api/habits/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const habit = await findOwned(app.db, habits, userId, request.params.id);
    if (!habit) return notFound(reply);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          for (const c of await liveCheckins(tx, userId, [habit.id])) await ops.softDelete(habitCheckins, c.id);
          if (!(await ops.softDelete(habits, habit.id))) throw new Rejection(notFound);
          return null;
        }),
      () => reply.code(204).send(),
    );
  });

  /** 打卡 / 补打卡: set the day's amount (a 完成一次 habit always records 1). */
  app.put<DayParams>('/api/habits/:id/checkins/:date', async (request, reply) => {
    const userId = sessionUser(request).id;
    const habit = await findOwned(app.db, habits, userId, request.params.id);
    if (!habit) return notFound(reply);
    const { date } = request.params;
    if (!tryParseCivilDate(date)) return invalidDate(reply);
    const body = putCheckinRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return sendValidationError(reply, body.error);
    if (habit.archivedAt) return habitArchived(reply);
    const count = habit.goal.type === 'once' ? 1 : body.data.count;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const { timeZone } = await readSettings(tx, userId);
          if (date > todayIn(app.clock.now(), timeZone)) throw new Rejection(futureDate);
          const [existing] = await tx
            .select()
            .from(habitCheckins)
            .where(and(eq(habitCheckins.habitId, habit.id), eq(habitCheckins.date, date)))
            .for('update');
          if (!existing) await ops.insert(habitCheckins, { habitId: habit.id, date, count });
          else if (existing.deletedAt) await ops.restore(habitCheckins, existing.id, { count });
          else if (existing.count !== count) await ops.update(habitCheckins, existing.id, { count });
          return withCheckins(tx, userId, habit);
        }),
      (result) => result,
    );
  });

  /** 撤销打卡 of a day. */
  app.delete<DayParams>('/api/habits/:id/checkins/:date', async (request, reply) => {
    const userId = sessionUser(request).id;
    const habit = await findOwned(app.db, habits, userId, request.params.id);
    if (!habit) return notFound(reply);
    const { date } = request.params;
    if (!tryParseCivilDate(date)) return invalidDate(reply);
    if (habit.archivedAt) return habitArchived(reply);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const [existing] = await tx
            .select({ id: habitCheckins.id })
            .from(habitCheckins)
            .where(and(eq(habitCheckins.habitId, habit.id), eq(habitCheckins.date, date), isNull(habitCheckins.deletedAt)));
          if (existing) await ops.softDelete(habitCheckins, existing.id);
          return withCheckins(tx, userId, habit);
        }),
      (result) => result,
    );
  });
}
