import { and, eq, isNull } from 'drizzle-orm';
import {
  COUNTED_SMART_LISTS,
  filterRulesSchema,
  listInSmartLists,
  liveQuadrants,
  liveRules,
  matchesFilter,
  matchesSmartList,
  quadrantMatcher,
  tagWithChildren,
  taskInRange,
  type CalendarRange,
  type FilterRules,
  type SmartListId,
  type Task,
  type ViewClock,
} from '@dida/shared';
import type { Executor } from './db/client.js';
import type { filters } from './db/schema/filters.js';
import { tags } from './db/schema/tags.js';
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
    .select({ id: lists.id, excludeFromSmartLists: lists.excludeFromSmartLists, archivedAt: lists.archivedAt })
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

/** The user's 清单 and 标签 that 过滤器 rules may name: live ones, and deleted ones (ignored, see `liveRules`). */
export interface RuleRefs {
  liveLists: Set<string>;
  liveTags: Set<string>;
  deletedLists: Set<string>;
  deletedTags: Set<string>;
}

export async function ruleRefs(db: Executor, userId: string): Promise<RuleRefs> {
  const [listRows, tagRows] = await Promise.all([
    db.select({ id: lists.id, deletedAt: lists.deletedAt }).from(lists).where(eq(lists.userId, userId)),
    db.select({ id: tags.id, deletedAt: tags.deletedAt }).from(tags).where(eq(tags.userId, userId)),
  ]);
  const split = (rows: { id: string; deletedAt: Date | null }[]) => ({
    live: new Set(rows.filter((r) => r.deletedAt === null).map((r) => r.id)),
    deleted: new Set(rows.filter((r) => r.deletedAt !== null).map((r) => r.id)),
  });
  const l = split(listRows);
  const t = split(tagRows);
  return { liveLists: l.live, liveTags: t.live, deletedLists: l.deleted, deletedTags: t.deleted };
}

/** A 过滤器's rules as they apply now (deleted 清单 / 标签 left out). */
export function effectiveRules(row: FilterRow, refs: RuleRefs): FilterRules {
  return liveRules(storedRules(row), refs.liveLists, refs.liveTags);
}

/** The tasks a 过滤器 selects, in every 清单 (不进智能清单 does not apply to 过滤器). */
export async function filterTasks(db: Executor, userId: string, filter: FilterRow, now: Date): Promise<Task[]> {
  const [rows, tagRows, clock, refs] = await Promise.all([
    liveTaskRows(db, userId),
    liveTags(db, userId),
    viewClock(db, userId, now),
    ruleRefs(db, userId),
  ]);
  const rules = effectiveRules(filter, refs);
  const tagScope = new Set(rules.tagIds.flatMap((id) => tagWithChildren(tagRows, id)));
  return rows
    .sort(compareTasks)
    .map(taskToApi)
    .filter((task) => matchesFilter(rules, task, clock, tagScope));
}

/**
 * 日历视图 (spec 用户故事 69): open and completed tasks with a day in `range`
 * in the user's time zone, from every 清单 except archived ones.
 */
export async function calendarTasks(db: Executor, userId: string, range: CalendarRange): Promise<Task[]> {
  const [rows, listRows, { timeZone }] = await Promise.all([
    liveTaskRows(db, userId),
    db
      .select({ id: lists.id, archivedAt: lists.archivedAt })
      .from(lists)
      .where(and(eq(lists.userId, userId), isNull(lists.deletedAt))),
    readSettings(db, userId),
  ]);
  const shown = new Set(listRows.filter((l) => l.archivedAt === null).map((l) => l.id));
  return rows
    .filter((row) => shown.has(row.listId) && row.status !== 'abandoned')
    .sort(compareTasks)
    .map(taskToApi)
    .filter((task) => taskInRange(task.dates, range, timeZone));
}

/**
 * 四象限 (spec 用户故事 72): open and completed tasks that some quadrant's
 * rules take, from every 清单 except archived ones. Each quadrant's tasks are
 * then picked out with the same `quadrantMatcher` on the client.
 */
export async function matrixTasks(db: Executor, userId: string, now: Date): Promise<Task[]> {
  const [rows, listRows, tagRows, settings, refs] = await Promise.all([
    liveTaskRows(db, userId),
    db
      .select({ id: lists.id, archivedAt: lists.archivedAt })
      .from(lists)
      .where(and(eq(lists.userId, userId), isNull(lists.deletedAt))),
    liveTags(db, userId),
    readSettings(db, userId),
    ruleRefs(db, userId),
  ]);
  const shown = new Set(listRows.filter((l) => l.archivedAt === null).map((l) => l.id));
  const matcher = quadrantMatcher(liveQuadrants(settings.matrixQuadrants, refs.liveLists, refs.liveTags), tagRows, { now, timeZone: settings.timeZone });
  return rows
    .filter((row) => shown.has(row.listId))
    .sort(compareTasks)
    .map(taskToApi)
    .filter((task) => matcher.indexOf(task) >= 0);
}
