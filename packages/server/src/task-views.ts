import { and, eq, isNull } from 'drizzle-orm';
import {
  COUNTED_SMART_LISTS,
  filterRulesSchema,
  listInSmartLists,
  matchesFilter,
  matchesSmartList,
  tagWithChildren,
  type FilterRules,
  type SmartListId,
  type Task,
  type ViewClock,
} from '@dida/shared';
import type { Executor } from './db/client.js';
import type { filters } from './db/schema/filters.js';
import { lists, tasks } from './db/schema/tasks.js';
import { compareTasks, taskToApi, type TaskRow } from './organize.js';
import { liveTags } from './routes/tags.js';
import { readSettings } from './settings.js';

/*
 * Cross-清单 task views: 智能清单 and 过滤器 (spec 用户故事 17、59–62). The
 * rules are the pure functions in shared (smart-lists.ts, filters.ts); this
 * module only loads the user's live tasks and 清单 and applies them, so the
 * server and any future client agree on what a view contains.
 */

export type FilterRow = typeof filters.$inferSelect;

async function liveTaskRows(db: Executor, userId: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)));
}

/** Ids of the user's live 清单 that take part in 智能清单 (see `listInSmartLists`). */
async function smartListScope(db: Executor, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: lists.id, excludeFromSmartLists: lists.excludeFromSmartLists })
    .from(lists)
    .where(and(eq(lists.userId, userId), isNull(lists.deletedAt)));
  return new Set(rows.filter(listInSmartLists).map((r) => r.id));
}

export async function viewClock(db: Executor, userId: string, now: Date): Promise<ViewClock> {
  return { now, timeZone: (await readSettings(db, userId)).timeZone };
}

/** The tasks of smart list `id`, in list order (the client sorts and groups them). */
export async function smartListTasks(db: Executor, userId: string, id: SmartListId, now: Date): Promise<Task[]> {
  const [rows, scope, clock] = await Promise.all([liveTaskRows(db, userId), smartListScope(db, userId), viewClock(db, userId, now)]);
  return rows
    .filter((row) => scope.has(row.listId))
    .sort(compareTasks)
    .map(taskToApi)
    .filter((task) => matchesSmartList(id, task, clock));
}

/** Open-task counts of the counted smart lists (sidebar badges). */
export async function smartListCounts(db: Executor, userId: string, now: Date): Promise<Record<string, number>> {
  const [rows, scope, clock] = await Promise.all([liveTaskRows(db, userId), smartListScope(db, userId), viewClock(db, userId, now)]);
  const open = rows.filter((row) => row.status === 'open' && scope.has(row.listId)).map(taskToApi);
  return Object.fromEntries(COUNTED_SMART_LISTS.map((id) => [id, open.filter((task) => matchesSmartList(id, task, clock)).length]));
}

/** Stored rules, read leniently: a row written by an older version still loads. */
export function storedRules(row: FilterRow): FilterRules {
  const parsed = filterRulesSchema.safeParse(row.rules);
  return parsed.success ? parsed.data : filterRulesSchema.parse({});
}

/** The tasks a 过滤器 selects, in every 清单 (不进智能清单 does not apply to 过滤器). */
export async function filterTasks(db: Executor, userId: string, filter: FilterRow, now: Date): Promise<Task[]> {
  const rules = storedRules(filter);
  const [rows, tagRows, clock] = await Promise.all([liveTaskRows(db, userId), liveTags(db, userId), viewClock(db, userId, now)]);
  const tagScope = new Set(rules.tagIds.flatMap((id) => tagWithChildren(tagRows, id)));
  return rows
    .sort(compareTasks)
    .map(taskToApi)
    .filter((task) => matchesFilter(rules, task, clock, tagScope));
}
