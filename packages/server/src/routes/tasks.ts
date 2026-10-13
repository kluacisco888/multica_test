import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  createTaskRequestSchema,
  tasksQuerySchema,
  updateTaskRequestSchema,
  type TaskDatesInput,
  type TasksResponse,
} from '@dida/shared';
import { sessionUser } from '../auth.js';
import type { Executor } from '../db/client.js';
import { lists, tasks } from '../db/schema/tasks.js';
import { sendValidationError } from '../http-errors.js';
import { compareTasks, ensureInbox, taskDateColumns, taskToApi, topOfList } from '../organize.js';
import { readSettings } from '../settings.js';
import { findOwned } from '../sync/sync.js';
import { invalidList, notFound, Rejection, respond } from './respond.js';

type Params = { Params: { id: string } };

/** Columns for the requested dates; timed dates get the user's current time zone. */
async function dateColumns(tx: Executor, userId: string, dates: TaskDatesInput | null) {
  const timeZone = dates?.allDay === false ? (await readSettings(tx, userId)).timeZone : null;
  return taskDateColumns(dates, timeZone);
}

/** 任务 basics: quick add, edit, Markdown description, complete, move, dates (spec 用户故事 20、21、23–27、31、40). */
export function taskRoutes(app: FastifyInstance) {
  app.get('/api/tasks', async (request, reply) => {
    const query = tasksQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const userId = sessionUser(request).id;
    const list = await findOwned(app.db, lists, userId, query.data.listId);
    if (!list) return notFound(reply);
    const rows = await app.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.listId, list.id), isNull(tasks.deletedAt)));
    const response: TasksResponse = { tasks: rows.sort(compareTasks).map(taskToApi) };
    return response;
  });

  app.get<Params>('/api/tasks/:id', async (request, reply) => {
    const task = await findOwned(app.db, tasks, sessionUser(request).id, request.params.id);
    if (!task) return notFound(reply);
    return taskToApi(task);
  });

  app.post('/api/tasks', async (request, reply) => {
    const body = createTaskRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    const { id, listId, title, description = '', sortOrder, dates = null } = body.data;
    // No 清单 given: the 收件箱.
    const list = listId ? await findOwned(app.db, lists, userId, listId) : await ensureInbox(app.db, app.sync, userId);
    if (!list) return invalidList(reply);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) =>
          ops.insert(tasks, {
            ...(id ? { id } : {}),
            ...(await dateColumns(tx, userId, dates)),
            listId: list.id,
            title,
            description,
            status: 'open',
            completedAt: null,
            sortOrder: sortOrder ?? (await topOfList(tx, userId, list.id)),
          }),
        ),
      (row) => reply.code(201).send(taskToApi(row)),
    );
  });

  app.patch<Params>('/api/tasks/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const task = await findOwned(app.db, tasks, userId, request.params.id);
    if (!task) return notFound(reply);
    const body = updateTaskRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const { status, listId, sortOrder, dates, ...fields } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const moved = listId !== undefined && listId !== task.listId;
          if (moved && !(await findOwned(tx, lists, userId, listId))) throw new Rejection(invalidList);
          const target = listId ?? task.listId;
          const row = await ops.update(tasks, task.id, {
            ...fields,
            ...(dates !== undefined ? await dateColumns(tx, userId, dates) : {}),
            ...(moved ? { listId: target } : {}),
            ...(sortOrder ? { sortOrder } : moved ? { sortOrder: await topOfList(tx, userId, target) } : {}),
            ...(status === 'completed' ? { status, completedAt: task.completedAt ?? app.clock.now() } : {}),
            ...(status === 'open' ? { status, completedAt: null } : {}),
          });
          if (!row) throw new Rejection(notFound);
          return row;
        }),
      (row) => taskToApi(row),
    );
  });
}
