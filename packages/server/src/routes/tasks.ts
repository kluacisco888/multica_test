import { and, arrayOverlaps, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  batchRequestSchema,
  createTaskRequestSchema,
  moveTaskRequestSchema,
  type BatchResponse,
  type MoveTaskResponse,
  tagWithChildren,
  tasksQuerySchema,
  TASK_MAX_TAGS,
  updateTaskRequestSchema,
  type Reminder,
  type TaskDatesInput,
  type TasksResponse,
} from '@dida/shared';
import { liveChannels } from '../notify/notifier.js';
import { sessionUser } from '../auth.js';
import type { Executor, Tx } from '../db/client.js';
import { filters } from '../db/schema/filters.js';
import { tags } from '../db/schema/tags.js';
import { lists, tasks } from '../db/schema/tasks.js';
import { sendValidationError } from '../http-errors.js';
import { compareTasks, ensureInbox, taskDateColumns, taskToApi, type TaskRow } from '../organize.js';
import { endOfChildren, inKeyOrder, pinnedTasks, placeTask, topOfList, topOfPinned } from '../task-order.js';
import { readSettings } from '../settings.js';
import { moveToTrash } from '../trash.js';
import { findOwned, type SyncOps } from '../sync/sync.js';
import { calendarTasks, filterTasks, matrixTasks, smartListTasks } from '../task-views.js';
import {
  ancestorsOf,
  checklistFromDescription,
  descendantsOf,
  descriptionFromChecklist,
  exceedsDepth,
  liveTasksOfList,
  lockTaskTrees,
} from '../task-tree.js';
import { generateNextInstance } from '../repeat.js';
import {
  checklistMode,
  depthExceeded,
  invalidChannels,
  invalidList,
  invalidParent,
  invalidPin,
  invalidPosition,
  invalidReminders,
  invalidTags,
  notFound,
  Rejection,
  repeatNeedsDate,
  respond,
  tooManyTags,
} from './respond.js';
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
export async function checkChannels(db: Executor, userId: string, ids: string[] | null | undefined): Promise<void> {
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
    if ('view' in query.data) {
      const response: TasksResponse = { tasks: await matrixTasks(app.db, userId, app.clock.now()) };
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
              sortOrder: sortOrder ?? (await endOfChildren(ops, siblings, parent.id)),
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
            sortOrder: sortOrder ?? (await topOfList(ops, tx, userId, list.id)),
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
    return respond(
      reply,
      () => app.sync.transaction(userId, (ops, tx) => applyTaskPatch(app, ops, tx, userId, found.id, body.data)),
      (row) => taskToApi(row),
    );
  });

  /** 拖拽排序 (spec 用户故事 32): right after `afterId` in the task's group; see `moveTaskRequestSchema`. */
  app.post<Params>('/api/tasks/:id/move', async (request, reply) => {
    const userId = sessionUser(request).id;
    if (!(await findOwned(app.db, tasks, userId, request.params.id))) return notFound(reply);
    const body = moveTaskRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const { afterId } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          // Serialize reorders (and tree changes) of one user, so two drops never compute keys from the same neighbours.
          await lockTaskTrees(tx, userId);
          const task = await findOwned(tx, tasks, userId, request.params.id);
          if (!task) throw new Rejection(notFound);
          const field = task.pinOrder !== null ? 'pinOrder' : 'sortOrder';
          const members =
            field === 'pinOrder'
              ? await pinnedTasks(tx, userId)
              : inKeyOrder(
                  (await liveTasksOfList(tx, userId, task.listId)).filter((r) => r.parentId === task.parentId),
                  'sortOrder',
                );
          const group = members.filter((r) => r.id !== task.id);
          const index = afterId === null ? 0 : group.findIndex((r) => r.id === afterId.toLowerCase()) + 1;
          if (index === 0 && afterId !== null) throw new Rejection(invalidPosition);
          const { key, rekeyed } = await placeTask(ops, group, index, field);
          const moved = await ops.update(tasks, task.id, field === 'pinOrder' ? { pinOrder: key } : { sortOrder: key });
          if (!moved) throw new Rejection(notFound);
          return [moved, ...rekeyed];
        }),
      (rows) => {
        const response: MoveTaskResponse = { tasks: rows.map(taskToApi) };
        return response;
      },
    );
  });

  /** 批量操作 (spec 用户故事 34): see `batchRequestSchema`. All or nothing, one transaction. */
  app.post('/api/tasks/batch', async (request, reply) => {
    const body = batchRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    const { ids, action } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          await lockTaskTrees(tx, userId);
          const rows = await tx
            .select()
            .from(tasks)
            .where(and(eq(tasks.userId, userId), inArray(tasks.id, ids), isNull(tasks.deletedAt)));
          // Another user's, deleted or unknown ids: nothing changes, like a single 404.
          if (rows.length !== ids.length) throw new Rejection(notFound);
          const changed = new Map<string, TaskRow>();
          // 删除: read each 清单 once. Rows deleted earlier in this batch stay in the cache, which is safe:
          // their ids are skipped below, and a later root only takes its own subtree from the cache.
          const listCache = new Map<string, TaskRow[]>();
          const listRowsOf = async (listId: string) => {
            let rows = listCache.get(listId);
            if (!rows) listCache.set(listId, (rows = await liveTasksOfList(tx, userId, listId)));
            return rows;
          };
          // Moved tasks each land on top of the target 清单: go bottom-up so they keep the order they were given in.
          for (const id of action.op === 'move' ? [...ids].reverse() : ids) {
            // Read fresh: an earlier task of the batch may have cascaded to this one.
            const task = await findOwned(tx, tasks, userId, id);
            if (!task) continue; // deleted with its parent earlier in this batch
            if (action.op === 'delete') {
              await moveToTrash(ops, tx, userId, task, await listRowsOf(task.listId));
              continue;
            }
            const patch = batchPatch(action, task);
            if (patch.tagIds && patch.tagIds.length > TASK_MAX_TAGS) throw new Rejection(tooManyTags);
            changed.set(id, await applyTaskPatch(app, ops, tx, userId, task.id, patch));
          }
          // Return the tasks as they are after the whole batch (cascades included).
          const live = await tx
            .select()
            .from(tasks)
            .where(and(eq(tasks.userId, userId), inArray(tasks.id, [...changed.keys()]), isNull(tasks.deletedAt)));
          return changed.size === 0 ? [] : live;
        }),
      (rows) => {
        const response: BatchResponse = { tasks: rows.sort(compareTasks).map(taskToApi) };
        return response;
      },
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

type UpdateTaskBody = z.output<typeof updateTaskRequestSchema>;

/** The single-task change a 批量操作 (other than 删除) makes to `task`. */
function batchPatch(action: Exclude<z.output<typeof batchRequestSchema>['action'], { op: 'delete' }>, task: TaskRow): UpdateTaskBody {
  switch (action.op) {
    case 'complete':
      return { status: 'completed' };
    case 'abandon':
      return { status: 'abandoned' };
    case 'move':
      return { listId: action.listId };
    case 'dates':
      return { dates: action.dates };
    case 'priority':
      return { priority: action.priority };
    case 'pin':
      return { pinned: action.pinned };
    case 'tags':
      // Keep the task's other 标签 in their order; new ones go last.
      return { tagIds: [...task.tagIds.filter((t) => !action.remove.includes(t)), ...action.add.filter((t) => !task.tagIds.includes(t))] };
  }
}

/**
 * One task change (`PATCH /api/tasks/:id`, and each task of a 批量操作) inside
 * the caller's transaction: validation, moves between 清单 and parents,
 * 检查清单 mode, status cascades, the next instance of a 重复任务, 置顶.
 * Throws a `Rejection` for an invalid change.
 */
async function applyTaskPatch(app: FastifyInstance, ops: SyncOps, tx: Tx, userId: string, taskId: string, patch: UpdateTaskBody): Promise<TaskRow> {
  const { status, listId, parentId, kind, sortOrder, description, dates, repeat, reminders, columnId, pinned, ...fields } = patch;
  const reshapes = parentId !== undefined || listId !== undefined || status !== undefined;
  if (reshapes) await lockTaskTrees(tx, userId);
  // Read under the lock: the row may have moved since the request was checked.
  const task = await findOwned(tx, tasks, userId, taskId);
  if (!task) throw new Rejection(notFound);

  // A 重复规则 needs a date; clearing the dates stops the repeat too.
  const hasDate = dates !== undefined ? dates !== null : task.allDay !== null;
  if (repeat && !hasDate) throw new Rejection(repeatNeedsDate);
  const repeatPatch = dates === null ? { repeat: null } : repeat !== undefined ? { repeat } : {};
  // 提醒 must fit the (new) dates; new dates drop the reminders that no longer fit.
  const targetAllDay = dates !== undefined ? (dates?.allDay ?? null) : task.allDay;
  if (reminders && !reminders.every((r) => fitsDates(r, targetAllDay))) throw new Rejection(invalidReminders);
  const remindersPatch =
    reminders !== undefined
      ? { reminders }
      : dates !== undefined
        ? { reminders: task.reminders.filter((r) => fitsDates(r, targetAllDay)) }
        : {};
  // Completing a 重复任务 generates the next instance, dated with the 工作日日历.
  const completing = status === 'completed' && task.status === 'open' && (repeatPatch.repeat ?? task.repeat) != null;
  const calendar = completing ? await app.holidays.calendar() : null;

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
      ? await endOfChildren(ops, siblingRows, targetParent, task.id)
      : movedList
        ? await topOfList(ops, tx, userId, targetList, task.id)
        : undefined);

  // 置顶: top-level tasks only; becoming a 子任务 unpins.
  if (pinned === true && targetParent !== null) throw new Rejection(invalidPin);
  const pinPatch =
    pinned === true
      ? task.pinOrder === null
        ? { pinOrder: await topOfPinned(ops, tx, userId, task.id) }
        : {}
      : pinned === false || (targetParent !== null && task.pinOrder !== null)
        ? { pinOrder: null }
        : {};

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
    ...pinPatch,
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
    const childPatch = {
      ...(movedList ? { listId: targetList } : {}),
      ...(movedList && child.columnId !== null ? { columnId: null } : {}),
      ...(status === 'completed' && child.status === 'open' ? { status: 'completed' as const, completedAt: now } : {}),
      ...(status === 'abandoned' && child.status === 'open' ? { status: 'abandoned' as const, abandonedAt: now } : {}),
    };
    if (Object.keys(childPatch).length > 0) await ops.update(tasks, child.id, childPatch);
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
}
