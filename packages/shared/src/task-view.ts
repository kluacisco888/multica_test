import { z } from 'zod';
import { compareSortKeys } from './sort-key.js';
import { taskDaySpan, type ViewClock } from './smart-lists.js';
import { addDays, relativeDayLabel, todayIn, WEEKDAY_NAMES, weekday, zonedDateTime } from './task-dates.js';
import { PRIORITIES, PRIORITY_LABELS, type Task } from './tasks.js';

/*
 * 排序和分组 (spec 用户故事 64): how a task view lays out its tasks. Each view
 * (清单, 标签, 智能清单, 过滤器, 搜索) remembers its own choice in 设置
 * (`viewOptions`, keyed by `viewKey`). Open tasks are sorted and grouped;
 * completed ones always come last in one 已完成 section, newest first —
 * except in the 已完成 smart list, where they are the content and get grouped.
 */

export const SORT_OPTIONS = ['custom', 'date', 'priority', 'title'] as const;
export const GROUP_OPTIONS = ['none', 'list', 'date', 'priority', 'tag'] as const;
export const sortBySchema = z.enum(SORT_OPTIONS);
export const groupBySchema = z.enum(GROUP_OPTIONS);
export type SortBy = z.infer<typeof sortBySchema>;
export type GroupBy = z.infer<typeof groupBySchema>;
export const SORT_LABELS: Record<SortBy, string> = { custom: '自定义', date: '日期', priority: '优先级', title: '标题' };
export const GROUP_LABELS: Record<GroupBy, string> = { none: '不分组', list: '清单', date: '日期', priority: '优先级', tag: '标签' };

/**
 * How a view shows its tasks (the 视图 switcher): `list` (the default),
 * `timeline` (时间线, spec 用户故事 68, see `timeline.ts`) or `kanban` (看板,
 * 用户故事 66、67, see `kanban.ts`). Missing means `list`, so layouts saved
 * before these existed stay valid. The 日历 (用户故事 69) is its own module
 * (`/calendar`), not a layout of a view.
 */
export const VIEW_LAYOUTS = ['list', 'kanban', 'timeline'] as const;
export const viewLayoutSchema = z.enum(VIEW_LAYOUTS);
export type ViewLayout = z.infer<typeof viewLayoutSchema>;
export const VIEW_LAYOUT_LABELS: Record<ViewLayout, string> = { list: '列表', kanban: '看板', timeline: '时间线' };
/** Views that can be shown as a board: 清单, 智能清单 and 过滤器. */
export const KANBAN_VIEW_KINDS: readonly ViewKind[] = ['list', 'smart', 'filter'];

/** The layouts the 视图 switcher offers for a kind of view (搜索: none). */
export function layoutsFor(kind: ViewKind): ViewLayout[] {
  if (kind === 'search') return [];
  return VIEW_LAYOUTS.filter((layout) => layout !== 'kanban' || KANBAN_VIEW_KINDS.includes(kind));
}

export const viewOptionsSchema = z.object({ sortBy: sortBySchema, groupBy: groupBySchema, layout: viewLayoutSchema.optional() }).strict();
export type ViewOptions = z.infer<typeof viewOptionsSchema>;

/** `list:<id>`, `tag:<id>`, `smart:<id>`, `filter:<id>` or `search`. */
export const viewKeySchema = z.string().regex(/^(?:(?:list|tag|filter):[0-9a-fA-F-]{36}|smart:[a-zA-Z]{1,32}|search)$/, '视图不合法');
export const MAX_VIEW_OPTIONS = 500;

export type ViewKind = 'list' | 'tag' | 'smart' | 'filter' | 'search';

/** Layout of a view the user has not changed. Date smart lists group by day, like the reference. */
export function defaultViewOptions(viewKey: string): ViewOptions {
  if (viewKey === 'smart:today' || viewKey === 'smart:tomorrow' || viewKey === 'smart:week') return { sortBy: 'date', groupBy: 'date' };
  if (viewKey === 'smart:completed') return { sortBy: 'date', groupBy: 'date' };
  if (viewKey.startsWith('smart:') || viewKey.startsWith('filter:') || viewKey === 'search') return { sortBy: 'date', groupBy: 'none' };
  return { sortBy: 'custom', groupBy: 'none' };
}

export interface TaskSection {
  /** Stable key, e.g. `overdue`, `day:2026-10-13`, `list:<id>`, `completed`. */
  key: string;
  title: string;
  /** Overdue group: the reference shows it in its own colour. */
  overdue?: boolean;
  completed?: boolean;
  /** 已置顶: open pinned tasks (with their 子任务 in the custom order), shown first. */
  pinned?: boolean;
  tasks: Task[];
}

export interface ArrangeContext extends ViewClock {
  /** 清单 in sidebar order. */
  lists: readonly { id: string; name: string }[];
  /** 标签 in display order. */
  tags: readonly { id: string; name: string }[];
  /** The 已完成 smart list: completed tasks are the content, grouped like open ones. */
  completedView?: boolean;
}

/** Sortable key of a task's due point: `YYYY-MM-DD` + time (all-day sorts before timed on the same day). */
function dueKey(task: Task, timeZone: string): string | null {
  if (!task.dates) return null;
  if (task.dates.allDay) return `${task.dates.dueDate} `;
  const { date, time } = zonedDateTime(task.dates.dueAt, timeZone);
  return `${date}T${time}`;
}

const priorityRank = (task: Task) => PRIORITIES.indexOf(task.priority);
const custom = (a: Task, b: Task) => compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id);
const titleCollator = new Intl.Collator('zh-CN', { numeric: true });

export function compareTasksBy(sortBy: SortBy, timeZone: string): (a: Task, b: Task) => number {
  const byDate = (a: Task, b: Task) => {
    const ka = dueKey(a, timeZone);
    const kb = dueKey(b, timeZone);
    if (ka === kb) return 0;
    if (ka === null) return 1; // no date last
    if (kb === null) return -1;
    return ka < kb ? -1 : 1;
  };
  switch (sortBy) {
    case 'custom':
      return custom;
    case 'date':
      return (a, b) => byDate(a, b) || priorityRank(a) - priorityRank(b) || custom(a, b);
    case 'priority':
      return (a, b) => priorityRank(a) - priorityRank(b) || byDate(a, b) || custom(a, b);
    case 'title':
      return (a, b) => titleCollator.compare(a.title, b.title) || custom(a, b);
  }
}

/** `今天 周二`, `明天 周三`, `10月16日 周五` — the reference's day headings. */
function dayTitle(date: string, today: string): string {
  const name = WEEKDAY_NAMES[weekday(date)] as string;
  let label = relativeDayLabel(date, today);
  if (label === name) {
    // Within the coming week the list label is the weekday; headings spell out the date.
    const [, m, d] = date.split('-').map(Number);
    label = `${m}月${d}日`;
  }
  return `${label} ${name}`;
}

type Grouping = { key: string; title: string; order: number; overdue?: boolean };

function dateGroup(task: Task, ctx: ArrangeContext, today: string): Grouping {
  if (task.status !== 'open' && task.completedAt) {
    // Completed tasks (in the 已完成 view) group by the day they were completed.
    const done = todayIn(new Date(task.completedAt), ctx.timeZone);
    return { key: `day:${done}`, title: dayTitle(done, today), order: -Date.parse(`${done}T00:00:00Z`) };
  }
  const span = taskDaySpan(task.dates, ctx.timeZone);
  if (!span) return { key: 'noDate', title: '无日期', order: Number.MAX_SAFE_INTEGER };
  if (span.due < today) return { key: 'overdue', title: '已过期', order: -1, overdue: true };
  // A range that started earlier shows under today.
  const day = span.start < today ? today : span.start;
  if (day > addDays(today, 6)) return { key: 'later', title: '更远', order: Number.MAX_SAFE_INTEGER - 1 };
  return { key: `day:${day}`, title: dayTitle(day, today), order: Date.parse(`${day}T00:00:00Z`) };
}

function groupOf(groupBy: GroupBy, task: Task, ctx: ArrangeContext, today: string): Grouping {
  switch (groupBy) {
    case 'none':
      return { key: 'all', title: '', order: 0 };
    case 'date':
      return dateGroup(task, ctx, today);
    case 'priority':
      return { key: `priority:${task.priority}`, title: PRIORITY_LABELS[task.priority], order: priorityRank(task) };
    case 'list': {
      const index = ctx.lists.findIndex((l) => l.id === task.listId);
      const list = ctx.lists[index];
      return list ? { key: `list:${list.id}`, title: list.name, order: index } : { key: 'list:unknown', title: '其他', order: ctx.lists.length };
    }
    case 'tag': {
      // A task with several 标签 shows under the first one in display order.
      const index = ctx.tags.findIndex((t) => task.tagIds.includes(t.id));
      const tag = ctx.tags[index];
      return tag ? { key: `tag:${tag.id}`, title: tag.name, order: index } : { key: 'untagged', title: '无标签', order: ctx.tags.length };
    }
  }
}

function group(tasks: Task[], options: ViewOptions, ctx: ArrangeContext): TaskSection[] {
  const today = todayIn(ctx.now, ctx.timeZone);
  const compare = compareTasksBy(options.sortBy, ctx.timeZone);
  const groups = new Map<string, Grouping & { tasks: Task[] }>();
  for (const task of tasks) {
    const g = groupOf(options.groupBy, task, ctx, today);
    const existing = groups.get(g.key);
    if (existing) existing.tasks.push(task);
    else groups.set(g.key, { ...g, tasks: [task] });
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ key, title, overdue, tasks: items }) => ({ key, title, ...(overdue ? { overdue } : {}), tasks: items.sort(compare) }));
}

/** 已完成 and 放弃 tasks, most recently closed first. */
const closedAt = (t: Task) => t.completedAt ?? t.abandonedAt ?? '';
const newestCompletedFirst = (a: Task, b: Task) => closedAt(b).localeCompare(closedAt(a)) || custom(a, b);

/**
 * Lay out a view: open tasks sorted and grouped by `options`, then one
 * 已完成 section. Sections without tasks are left out; with `groupBy: none`
 * the open tasks form one section with an empty title.
 */
export function arrangeTasks(tasks: readonly Task[], options: ViewOptions, ctx: ArrangeContext): TaskSection[] {
  if (ctx.completedView) {
    // The 已完成 smart list holds completed tasks only (放弃 never counts as done).
    const done = tasks.filter((t) => t.status === 'completed');
    if (options.groupBy === 'date') return group(done, options, ctx).map((s) => ({ ...s, tasks: s.tasks.sort(newestCompletedFirst) }));
    return group(done, options, ctx);
  }
  const openTasks = tasks.filter((t) => t.status === 'open');
  // 已置顶 (spec 用户故事 33): open pinned tasks above every group, newest pin first.
  const pinned = pinnedTasks(openTasks, options.sortBy === 'custom');
  const open = group(
    openTasks.filter((t) => !pinned.has(t)),
    options,
    ctx,
  );
  const pinnedSection: TaskSection[] =
    pinned.size > 0 ? [{ key: 'pinned', title: '已置顶', pinned: true, tasks: [...pinned].sort(byPin) }] : [];
  // 放弃 tasks keep their record under 已完成, next to the completed ones (spec 用户故事 28).
  const done = tasks.filter((t) => t.status !== 'open').sort(newestCompletedFirst);
  return [...pinnedSection, ...open, ...(done.length > 0 ? [{ key: 'completed', title: '已完成', completed: true, tasks: done }] : [])];
}

/** Pinned roots by pin key, then their 子任务 (which follow their parent there) by sort key. */
function byPin(a: Task, b: Task): number {
  if (a.pinOrder !== null && b.pinOrder !== null) return compareSortKeys(a.pinOrder, b.pinOrder) || custom(a, b);
  if (a.pinOrder !== null) return -1;
  if (b.pinOrder !== null) return 1;
  return custom(a, b);
}

/** Open pinned top-level tasks, with their open 子任务 when `withSubtrees` (the nested custom order). */
function pinnedTasks(open: readonly Task[], withSubtrees: boolean): Set<Task> {
  const out = new Set(open.filter((t) => t.pinOrder !== null && t.parentId === null));
  if (!withSubtrees || out.size === 0) return out;
  const ids = new Set([...out].map((t) => t.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of open) {
      if (t.parentId !== null && ids.has(t.parentId) && !ids.has(t.id)) {
        ids.add(t.id);
        out.add(t);
        grew = true;
      }
    }
  }
  return out;
}
