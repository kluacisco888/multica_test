import { describe, expect, it } from 'vitest';
import { mergeViewOptions } from './settings.js';
import { arrangeTasks, defaultViewOptions, layoutsFor, viewOptionsSchema, type ArrangeContext } from './task-view.js';
import type { Task } from './tasks.js';

const LIST_A = '00000000-0000-4000-8000-00000000000a';
const LIST_B = '00000000-0000-4000-8000-00000000000b';
const TAG_X = '00000000-0000-4000-8000-0000000000f1';

const ctx: ArrangeContext = {
  now: new Date('2026-10-13T02:00:00.000Z'), // 周二
  timeZone: 'Asia/Shanghai',
  lists: [
    { id: LIST_A, name: '工作' },
    { id: LIST_B, name: '生活' },
  ],
  tags: [{ id: TAG_X, name: '重要' }],
};

let n = 0;
function task(title: string, extra: Partial<Task> = {}): Task {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    revision: n,
    listId: LIST_A,
    parentId: null,
    title,
    kind: 'text',
    description: '',
    status: 'open',
    completedAt: null,
    abandonedAt: null,
    sortOrder: `a${n}`,
    dates: null,
    priority: 'none',
    tagIds: [],
    repeat: null,
    reminders: [],
    reminderChannelIds: null,
    columnId: null,
    ...extra,
  };
}
const due = (dueDate: string) => ({ allDay: true as const, startDate: null, dueDate });
const titles = (sections: ReturnType<typeof arrangeTasks>) => sections.map((s) => [s.title, s.tasks.map((t) => t.title)]);

describe('排序和分组', () => {
  const overdue = task('过期', { dates: due('2026-10-01') });
  const today = task('今天', { dates: due('2026-10-13') });
  const friday = task('周五', { dates: due('2026-10-16'), priority: 'high' });
  const later = task('以后', { dates: due('2026-11-01'), listId: LIST_B });
  const noDate = task('无日期', { priority: 'low', tagIds: [TAG_X], sortOrder: 'a0' });
  const done = task('做完', { status: 'completed', completedAt: '2026-10-13T01:00:00.000Z' });
  const doneEarlier = task('早做完', { status: 'completed', completedAt: '2026-10-12T01:00:00.000Z' });
  const all = [noDate, later, friday, done, today, overdue, doneEarlier];

  it('date grouping: 已过期, each day with its weekday, 更远, 无日期, then 已完成', () => {
    const sections = arrangeTasks(all, { sortBy: 'date', groupBy: 'date' }, ctx);
    expect(titles(sections)).toEqual([
      ['已过期', ['过期']],
      ['今天 周二', ['今天']],
      ['10月16日 周五', ['周五']],
      ['更远', ['以后']],
      ['无日期', ['无日期']],
      ['已完成', ['做完', '早做完']],
    ]);
    expect(sections[0]?.overdue).toBe(true);
    expect(sections.at(-1)?.completed).toBe(true);
  });

  it('sorting without groups', () => {
    const open = (sortBy: 'custom' | 'date' | 'priority' | 'title') =>
      arrangeTasks(all, { sortBy, groupBy: 'none' }, ctx)[0]?.tasks.map((t) => t.title);
    expect(open('custom')).toEqual(['无日期', '过期', '今天', '周五', '以后']);
    expect(open('date')).toEqual(['过期', '今天', '周五', '以后', '无日期']);
    expect(open('priority')).toEqual(['周五', '无日期', '过期', '今天', '以后']);
    expect(open('title')).toEqual(['过期', '今天', '无日期', '以后', '周五']);
  });

  it('grouping by 清单, 优先级 and 标签', () => {
    const open = [noDate, later, friday, today];
    expect(titles(arrangeTasks(open, { sortBy: 'date', groupBy: 'list' }, ctx))).toEqual([
      ['工作', ['今天', '周五', '无日期']],
      ['生活', ['以后']],
    ]);
    expect(titles(arrangeTasks(open, { sortBy: 'date', groupBy: 'priority' }, ctx))).toEqual([
      ['高优先级', ['周五']],
      ['低优先级', ['无日期']],
      ['无优先级', ['今天', '以后']],
    ]);
    expect(titles(arrangeTasks(open, { sortBy: 'date', groupBy: 'tag' }, ctx))).toEqual([
      ['重要', ['无日期']],
      ['无标签', ['今天', '周五', '以后']],
    ]);
  });

  it('the 已完成 view groups completed tasks by completion day', () => {
    const sections = arrangeTasks(all, defaultViewOptions('smart:completed'), { ...ctx, completedView: true });
    expect(titles(sections)).toEqual([
      ['今天 周二', ['做完']],
      ['昨天 周一', ['早做完']],
    ]);
  });

  it('defaults: date smart lists group by day, 清单 keep the custom order', () => {
    expect(defaultViewOptions('smart:today')).toEqual({ sortBy: 'date', groupBy: 'date' });
    expect(defaultViewOptions(`list:${LIST_A}`)).toEqual({ sortBy: 'custom', groupBy: 'none' });
    expect(defaultViewOptions(`filter:${LIST_A}`)).toEqual({ sortBy: 'date', groupBy: 'none' });
  });

  it('view options merge per view; null resets a view', () => {
    const a = { sortBy: 'title', groupBy: 'none' } as const;
    const b = { sortBy: 'priority', groupBy: 'list' } as const;
    expect(mergeViewOptions({ 'smart:today': a }, { search: b })).toEqual({ 'smart:today': a, search: b });
    expect(mergeViewOptions({ 'smart:today': a, search: b }, { 'smart:today': null })).toEqual({ search: b });
  });
});

describe('视图 layouts', () => {
  it('offers 列表 / 看板 / 时间线 where they apply, none for 搜索', () => {
    expect(layoutsFor('list')).toEqual(['list', 'kanban', 'timeline']);
    expect(layoutsFor('smart')).toEqual(['list', 'kanban', 'timeline']);
    expect(layoutsFor('filter')).toEqual(['list', 'kanban', 'timeline']);
    expect(layoutsFor('tag')).toEqual(['list', 'timeline']);
    expect(layoutsFor('search')).toEqual([]);
  });

  it('stores every layout in one `layout` field; old saves without it stay valid', () => {
    for (const layout of ['list', 'kanban', 'timeline'] as const) {
      expect(viewOptionsSchema.parse({ sortBy: 'custom', groupBy: 'none', layout }).layout).toBe(layout);
    }
    expect(viewOptionsSchema.parse({ sortBy: 'custom', groupBy: 'none' }).layout).toBeUndefined();
    expect(viewOptionsSchema.safeParse({ sortBy: 'custom', groupBy: 'none', mode: 'kanban' }).success).toBe(false);
  });
});
