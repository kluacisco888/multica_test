import { and, arrayOverlaps, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  createTaskRequestSchema,
  tagWithChildren,
  tasksQuerySchema,
  updateTaskRequestSchema,
  type Reminder,
  type TaskDatesInput,
  type TasksResponse,
} from '@dida/shared';
import { liveChannels } from '../notify/notifier.js';
import { sessionUser } from '../auth.js';
import type { Executor } from '../db/client.js';
import { filters } from '../db/schema/filters.js';
import { tags } from '../db/schema/tags.js';
import { lists, tasks } from '../db/schema/tasks.js';
import { sendValidationError } from '../http-errors.js';
import { compareTasks, ensureInbox, taskDateColumns, taskToApi, topOfList, type TaskRow } from '../organize.js';
import { readSettings } from '../settings.js';
import { moveToTrash } from '../trash.js';
import { findOwned } from '../sync/sync.js';
import { calendarTasks, filterTasks, smartListTasks } from '../task-views.js';
import {
  ancestorsOf,
  checklistFromDescription,
  descendantsOf,
  descriptionFromChecklist,
  endOfChildren,
  exceedsDepth,
  liveTasksOfList,
  lockTaskTrees,
} from '../task-tree.js';
import { generateNextInstance } from '../repeat.js';
import { checklistMode, depthExceeded, invalidChannels, invalidList, invalidReminders, invalidParent, invalidTags, notFound, Rejection, repeatNeedsDate, respond } from './respond.js';
import { checkColumn } from './kanban.js';
import { liveTags } from './tags.js';

type Params = { Params: { id: string } };

/** Columns for the requested dates; timed dates get the user's current time zone. */
async function dateColumns(tx: Executor, userId: string, dates: TaskDatesInput | null) {
  const timeZone = dates?.allDay === false ? (await readSettings(tx, userId)).timeZone : null;
  return taskDateColumns(dates, timeZone);
}

/** Throws a 400 rejection unless every id is a live 标签 of the user. */
async function checkTags(db: Executor, userId: string, tagIds: string[] | undefined): Promise<void> {
  if (!tagIds || tagIds.length === 0) return;
  const live = new Set((await liveTags(db, userId)).map((t) => t.id));
  if (!tagIds.every((id) => live.has(id))) throw new Rejection(invalidTags);
}

/** Whether a 提醒 suits a task with `allDay` (null: no date): timed tasks take `before`, 全天 ones `day`. */
const fitsDates = (r: Reminder, allDay: boolean | null) => allDay !== null && (allDay ? r.type === 'day' : r.type === 'before');

/** Throws a 400 rejection unless every id is a live 通知渠道 of the user. */
async function checkChannels(db: Executor, userId: string, ids: string[] | null | undefined): Promise<void> {
  if (!ids || ids.length === 0) return;
  const live = new Set((await liveChannels(db, userId)).map((c) => c.id));
  if (!ids.every((id) => live.has(id))) throw new Rejection(invalidChannels);
}

/**
 * 任务: quick add, edit, Markdown 描述, complete, move, dates (spec 用户故事 20、21、23–27、31、40),
 * 子任务 trees and 检查清单 mode (用户故事 35–37), 优先级 (22), 标签 (18), 放弃 (28) and 删除 (29).
 */
export function taskRoutes(app: FastifyInstance) {
  app.get('/api/tasks', async (request, reply) => {
    const query = tasksQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const userId = sessionUser(request).id;
    if ('smart' in query.data) {
      const response: TasksResponse = { tasks: await smartListTasks(app.db, userId, query.data.smart, app.clock.now()) };
      return response;
    }
    if ('filterId' in query.data) {
      const filter = await findOwned(app.db, filters, userId, query.data.filterId);
      if (!filter) return notFound(reply);
      const response: TasksResponse = { tasks: await filterTasks(app.db, userId, filter, app.clock.now()) };
      return response;
    }
    if ('from' in query.data) {
      const response: TasksResponse = { tasks: await calendarTasks(app.db, userId, query.data) };
      return response;
    }
    let scope;
    if ('listId' in query.data) {
      const list = await findOwned(app.db, lists, userId, query.data.listId);
      if (!list) return notFound(reply);
      scope = eq(tasks.listId, list.id);
    } else {
      const tag = await findOwned(app.db, tags, userId, query.data.tagId);
      if (!tag) return notFound(reply);
      // A parent 标签 shows its children's tasks too.
      scope = arrayOverlaps(tasks.tagIds, tagWithChildren(await liveTags(app.db, userId), tag.id));
    }
    const rows = await app.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), scope, isNull(tasks.deletedAt)));
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
    const {
      id,
      listId,
      parentId,
      title,
      description = '',
      sortOrder,
      dates = null,
      priority = 'none',
      tagIds = [],
      repeat = null,
      reminders = [],
      reminderChannelIds = null,
      columnId = null,
    } = body.data;
    if (repeat && !dates) return repeatNeedsDate(reply);
    if (!reminders.every((r) => fitsDates(r, dates?.allDay ?? null))) return invalidReminders(reply);

    if (parentId) {
      // A 子任务 goes into its parent's 清单.
      return respond(
        reply,
        () =>
          app.sync.transaction(userId, async (ops, tx) => {
            await lockTaskTrees(tx, userId);
            await checkTags(tx, userId, tagIds);
            await checkChannels(tx, userId, reminderChannelIds);
            const parent = await findOwned(tx, tasks, userId, parentId);
            if (!parent || (listId && listId !== parent.listId)) throw new Rejection(invalidParent);
            await checkColumn(tx, userId, parent.listId, columnId);
            const siblings = await liveTasksOfList(tx, userId, parent.listId);
            if (exceedsDepth(siblings, parent.id, null, null)) throw new Rejection(depthExceeded);
            return ops.insert(tasks, {
              ...(id ? { id } : {}),
              ...(await dateColumns(tx, userId, dates)),
              listId: parent.listId,
              parentId: parent.id,
              title,
              kind: 'text',
              description,
              status: 'open',
              completedAt: null,
              priority,
              tagIds,
              repeat,
              reminders,
              reminderChannelIds,
              columnId,
              sortOrder: sortOrder ?? endOfChildren(siblings, parent.id),
            });
          }),
        (row) => reply.code(201).send(taskToApi(row)),
      );
    }

    // No 清单 given: the 收件箱.
    const list = listId ? await findOwned(app.db, lists, userId, listId) : await ensureInbox(app.db, app.sync, userId);
    if (!list) return invalidList(reply);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          await checkTags(tx, userId, tagIds);
          await checkChannels(tx, userId, reminderChannelIds);
          await checkColumn(tx, userId, list.id, columnId);
          return ops.insert(tasks, {
            ...(id ? { id } : {}),
            ...(await dateColumns(tx, userId, dates)),
            listId: list.id,
            parentId: null,
            title,
            kind: 'text',
            description,
            status: 'open',
            completedAt: null,
            abandonedAt: null,
            priority,
            tagIds,
            repeat,
            reminders,
            reminderChannelIds,
            columnId,
            sortOrder: sortOrder ?? (await topOfList(tx, userId, list.id)),
          });
        }),
      (row) => reply.code(201).send(taskToApi(row)),
    );
  });

  app.patch<Params>('/api/tasks/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const found = await findOwned(app.db, tasks, userId, request.params.id);
    if (!found) return notFound(reply);
    const body = updateTaskRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const { status, listId, parentId, kind, sortOrder, description, dates, repeat, reminders, columnId, ...fields } = body.data;
    // A 重复规则 needs a date; clearing the dates stops the repeat too.
    const hasDate = dates !== undefined ? dates !== null : found.allDay !== null;
    if (repeat && !hasDate) return repeatNeedsDate(reply);
    const repeatPatch = dates === null ? { repeat: null } : repeat !== undefined ? { repeat } : {};
    // 提醒 must fit the (new) dates; new dates drop the reminders that no longer fit.
    const targetAllDay = dates !== undefined ? (dates?.allDay ?? null) : found.allDay;
    if (reminders && !reminders.every((r) => fitsDates(r, targetAllDay))) return invalidReminders(reply);
    const remindersPatch =
      reminders !== undefined
        ? { reminders }
        : dates !== undefined
          ? { reminders: found.reminders.filter((r) => fitsDates(r, targetAllDay)) }
          : {};
    // Completing a 重复任务 generates the next instance, dated with the 工作日日历.
    const completing = status === 'completed' && found.status === 'open' && (repeatPatch.repeat ?? found.repeat) != null;
    const calendar = completing ? await app.holidays.calendar() : null;

    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const reshapes = parentId !== undefined || listId !== undefined || status !== undefined;
          if (reshapes) await lockTaskTrees(tx, userId);
          // Re-read under the lock: the row may have moved since the check above.
          const task = await findOwned(tx, tasks, userId, found.id);
          if (!task) throw new Rejection(notFound);
          await checkTags(tx, userId, fields.tagIds);
          await checkChannels(tx, userId, fields.reminderChannelIds);
          const listRows = reshapes ? await liveTasksOfList(tx, userId, task.listId) : [];
          const subtree = reshapes ? descendantsOf(listRows, task.id) : [];

          // Where the task ends up: parent and 清单.
          let targetParent = task.parentId;
          let targetList = task.listId;
          let siblingRows: TaskRow[] = listRows;
          if (parentId !== undefined && parentId !== null) {
            const parent = await findOwned(tx, tasks, userId, parentId);
            if (!parent || parent.id === task.id || subtree.some((r) => r.id === parent.id)) throw new Rejection(invalidParent);
            if (listId !== undefined && listId !== parent.listId) throw new Rejection(invalidParent);
            siblingRows = parent.listId === task.listId ? listRows : await liveTasksOfList(tx, userId, parent.listId);
            if (exceedsDepth(siblingRows, parent.id, listRows, task.id)) throw new Rejection(depthExceeded);
            targetParent = parent.id;
            targetList = parent.listId;
          } else {
            if (listId !== undefined && listId !== task.listId) {
              if (!(await findOwned(tx, lists, userId, listId))) throw new Rejection(invalidList);
              targetList = listId;
              targetParent = null; // a 子任务 moved to another 清单 becomes a top-level task there
            }
            if (parentId === null) targetParent = null;
          }
          const movedList = targetList !== task.listId;
          const reparented = targetParent !== task.parentId;
          // 看板分栏 belong to one 清单: moving elsewhere lands in 未分组 unless a 分栏 there is given.
          await checkColumn(tx, userId, targetList, columnId);
          const columnPatch = columnId !== undefined ? { columnId } : movedList && task.columnId !== null ? { columnId: null } : {};
          const newSortOrder =
            sortOrder ??
            (reparented && targetParent !== null
              ? endOfChildren(siblingRows, targetParent, task.id)
              : movedList
                ? await topOfList(tx, userId, targetList)
                : undefined);

          // 描述 / 检查清单 mode.
          const targetKind = kind ?? task.kind;
          if (targetKind === 'checklist' && description !== undefined && description !== '') throw new Rejection(checklistMode);
          let newDescription = description;
          if (kind === 'checklist' && task.kind === 'text') {
            await checklistFromDescription(ops, tx, userId, task.id, task.description);
            newDescription = '';
          } else if (kind === 'text' && task.kind === 'checklist') {
            const text = await descriptionFromChecklist(ops, tx, userId, task.id);
            newDescription ??= text;
          }

          const now = app.clock.now();
          const wasOpen = task.status === 'open';
          const row = await ops.update(tasks, task.id, {
            ...fields,
            ...repeatPatch,
            ...remindersPatch,
            ...(dates !== undefined ? await dateColumns(tx, userId, dates) : {}),
            ...(newDescription !== undefined ? { description: newDescription } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(movedList ? { listId: targetList } : {}),
            ...columnPatch,
            ...(reparented ? { parentId: targetParent } : {}),
            ...(newSortOrder ? { sortOrder: newSortOrder } : {}),
            ...(status === 'completed' ? { status, completedAt: task.completedAt ?? now, abandonedAt: null } : {}),
            ...(status === 'abandoned' ? { status, abandonedAt: task.abandonedAt ?? now, completedAt: null } : {}),
            ...(status === 'open' ? { status, completedAt: null, abandonedAt: null } : {}),
          });
          if (!row) throw new Rejection(notFound);

          // Cascades: the subtree follows the task into its 清单; completing / abandoning
          // completes / abandons the open 子任务 below; re-opening re-opens closed ancestors.
          for (const child of subtree) {
            const patch = {
              ...(movedList ? { listId: targetList } : {}),
              ...(movedList && child.columnId !== null ? { columnId: null } : {}),
              ...(status === 'completed' && child.status === 'open' ? { status: 'completed' as const, completedAt: now } : {}),
              ...(status === 'abandoned' && child.status === 'open' ? { status: 'abandoned' as const, abandonedAt: now } : {}),
            };
            if (Object.keys(patch).length > 0) await ops.update(tasks, child.id, patch);
          }
          if (status === 'open') {
            for (const ancestor of ancestorsOf(listRows, task.id)) {
              if (ancestor.status !== 'open') {
                await ops.update(tasks, ancestor.id, { status: 'open', completedAt: null, abandonedAt: null });
              }
            }
          }
          if (calendar && wasOpen && row.status === 'completed') {
            const { timeZone } = await readSettings(tx, userId);
            await generateNextInstance(ops, tx, { task: row, userId, now, userTimeZone: timeZone, calendar });
          }
          return row;
        }),
      (row) => taskToApi(row),
    );
  });

  /** 删除: into the 回收站 with its 子任务 (spec 用户故事 29). */
  app.delete<Params>('/api/tasks/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    if (!(await findOwned(app.db, tasks, userId, request.params.id))) return notFound(reply);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          await lockTaskTrees(tx, userId);
          const task = await findOwned(tx, tasks, userId, request.params.id);
          if (!task) throw new Rejection(notFound);
          await moveToTrash(ops, tx, userId, task, await liveTasksOfList(tx, userId, task.listId));
          return task;
        }),
      () => reply.code(204).send(),
    );
  });
}
