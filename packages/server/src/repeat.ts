import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  dueDayOf,
  nextOccurrence,
  shiftTaskDates,
  todayIn,
  type RepeatBasis,
  type WorkdayCalendar,
} from '@dida/shared';
import type { Db, Tx } from './db/client.js';
import { checklistItems, tasks } from './db/schema/tasks.js';
import { taskDatesToApi, taskDateColumns, type TaskRow } from './organize.js';
import type { SyncOps, SyncWriter } from './sync/sync.js';
import { liveChecklistItems } from './task-tree.js';

/*
 * 重复任务 (spec 用户故事 41–50): completing an instance generates the next
 * one; 节假日数据更新 recomputes next instances that are still open. The dates
 * come from the pure 重复规则引擎 in shared.
 */

/** "Today" for a task: its own time zone when timed, else the user's. */
function todayFor(row: TaskRow, now: Date, userTimeZone: string): string {
  return todayIn(now, row.allDay === false && row.timeZone ? row.timeZone : userTimeZone);
}

/**
 * Generate the next instance of a 重复任务 that was just completed. Does
 * nothing when the task does not repeat, the series has ended, or an instance
 * was already generated from it (completed, re-opened, completed again).
 * Returns the new instance.
 */
export async function generateNextInstance(
  ops: SyncOps,
  tx: Tx,
  { task, userId, now, userTimeZone, calendar }: { task: TaskRow; userId: string; now: Date; userTimeZone: string; calendar: WorkdayCalendar },
): Promise<TaskRow | null> {
  const dates = taskDatesToApi(task);
  if (!task.repeat || !dates) return null;
  const [existing] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.repeatPrevId, task.id), isNull(tasks.deletedAt)));
  if (existing) return null;

  const today = todayFor(task, now, userTimeZone);
  const due = dueDayOf(dates);
  const nextDue = nextOccurrence({ rule: task.repeat, due, completedOn: today, today, index: task.repeatIndex, calendar });
  if (!nextDue) return null;

  const basis: RepeatBasis = { prevDue: due, completedOn: today, today, nextDue };
  const row = await ops.insert(tasks, {
    ...taskDateColumns(shiftTaskDates(dates, nextDue), task.timeZone),
    listId: task.listId,
    parentId: task.parentId,
    title: task.title,
    kind: task.kind,
    description: task.description,
    status: 'open',
    completedAt: null,
    // Takes the completed instance's place in the 清单.
    sortOrder: task.sortOrder,
    priority: task.priority,
    tagIds: task.tagIds,
    repeat: task.repeat,
    repeatIndex: task.repeatIndex + 1,
    repeatPrevId: task.id,
    repeatBasis: basis,
  });
  // A 检查清单 starts over: same 检查项, none checked.
  if (task.kind === 'checklist') {
    for (const item of await liveChecklistItems(tx, userId, task.id)) {
      await ops.insert(checklistItems, { taskId: row.id, title: item.title, completed: false, sortOrder: item.sortOrder });
    }
  }
  return row;
}

/**
 * After 节假日数据更新 (spec 用户故事 50): recompute the date of every open,
 * generated next instance with the new 工作日日历. Instances whose date the
 * user changed by hand are left alone. Returns the ids of the moved tasks.
 */
export async function recomputeNextInstances(db: Db, sync: SyncWriter, calendar: WorkdayCalendar): Promise<string[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'open'), isNull(tasks.deletedAt), isNotNull(tasks.repeat), isNotNull(tasks.repeatBasis)));
  const moved: string[] = [];
  for (const row of rows) {
    const dates = taskDatesToApi(row);
    const basis = row.repeatBasis;
    if (!dates || !basis || !row.repeat) continue;
    if (dueDayOf(dates) !== basis.nextDue) continue; // moved by hand
    const nextDue = nextOccurrence({
      rule: row.repeat,
      due: basis.prevDue,
      completedOn: basis.completedOn,
      today: basis.today,
      index: row.repeatIndex - 1,
      calendar,
    });
    if (!nextDue || nextDue === basis.nextDue) continue;
    const updated = await sync.transaction(row.userId, async (ops, tx) => {
      // Re-check under the transaction: the user may have changed it meanwhile.
      const [current] = await tx.select().from(tasks).where(and(eq(tasks.id, row.id), isNull(tasks.deletedAt)));
      if (!current || current.status !== 'open' || current.revision !== row.revision) return null;
      return ops.update(tasks, row.id, {
        ...taskDateColumns(shiftTaskDates(dates, nextDue), row.timeZone),
        repeatBasis: { ...basis, nextDue },
      });
    });
    if (updated) moved.push(row.id);
  }
  return moved;
}

