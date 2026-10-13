import { describe, expect, it } from 'vitest';
import { arrangeAutoBoard, arrangeListBoard, deleteKanbanColumnQuerySchema, sortKeyForDrop, type KanbanColumn } from './kanban.js';
import { compareSortKeys } from './sort-key.js';
import type { ArrangeContext } from './task-view.js';
import type { Task } from './tasks.js';

const LIST = '00000000-0000-4000-8000-00000000000a';
const ctx: ArrangeContext = {
  now: new Date('2026-10-13T02:00:00.000Z'), // 周二
  timeZone: 'Asia/Shanghai',
  lists: [{ id: LIST, name: '工作' }],
  tags: [],
};

let n = 0;
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
function task(title: string, extra: Partial<Task> = {}): Task {
  n += 1;
  return {
    id: uuid(n),
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    revision: n,
    listId: LIST,
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
    pinOrder: null,
    ...extra,
  };
}
function column(name: string, sortOrder: string): KanbanColumn {
  n += 1;
  return { id: uuid(1000 + n), createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', revision: n, listId: LIST, name, sortOrder };
}
const due = (dueDate: string) => ({ allDay: true as const, startDate: null, dueDate });
const custom = { sortBy: 'custom' as const, groupBy: 'none' as const };
const cards = (board: ReturnType<typeof arrangeListBoard>) =>
  board.columns.map((c) => [c.title, c.count, c.sections.flatMap((s) => s.tasks.map((t) => t.title))]);

describe('清单看板', () => {
  it('shows only 未分组 while the 清单 has no 分栏', () => {
    const board = arrangeListBoard([task('a'), task('b')], [], custom, ctx);
    expect(board.kind).toBe('manual');
    expect(cards(board)).toEqual([['未分组', 2, ['a', 'b']]]);
    expect(cards(arrangeListBoard([], [], custom, ctx))).toEqual([['未分组', 0, []]]);
  });

  it('puts each top-level task into its 分栏, left to right; tasks of unknown 分栏 go to 未分组', () => {
    const doing = column('进行中', 'b');
    const todo = column('待办', 'a');
    const sub = task('子任务', {});
    const parent = task('父任务', { columnId: doing.id });
    sub.parentId = parent.id;
    sub.columnId = todo.id;
    const board = arrangeListBoard(
      [task('无分栏'), parent, sub, task('待办1', { columnId: todo.id }), task('已删分栏', { columnId: uuid(9999) })],
      [doing, todo],
      custom,
      ctx,
    );
    expect(cards(board)).toEqual([
      ['未分组', 2, ['无分栏', '已删分栏']],
      ['待办', 1, ['待办1']],
      ['进行中', 1, ['父任务']],
    ]);
    expect(board.columns[1]?.column?.id).toBe(todo.id);
  });

  it('hides an empty 未分组 once 分栏 exist; empty 分栏 stay', () => {
    const todo = column('待办', 'a');
    const done = column('完成', 'b');
    expect(cards(arrangeListBoard([task('x', { columnId: todo.id })], [todo, done], custom, ctx))).toEqual([
      ['待办', 1, ['x']],
      ['完成', 0, []],
    ]);
  });

  it('lays out cards inside a column by the view options, completed last (not counted)', () => {
    const todo = column('待办', 'a');
    const board = arrangeListBoard(
      [
        task('今天', { columnId: todo.id, dates: due('2026-10-13') }),
        task('过期', { columnId: todo.id, dates: due('2026-10-01') }),
        task('完成了', { columnId: todo.id, status: 'completed', completedAt: '2026-10-12T00:00:00.000Z' }),
      ],
      [todo],
      { sortBy: 'date', groupBy: 'date' },
      ctx,
    );
    const col = board.columns[0];
    expect(col?.count).toBe(2);
    expect(col?.sections.map((s) => [s.title, s.tasks.map((t) => t.title)])).toEqual([
      ['已过期', ['过期']],
      ['今天 周二', ['今天']],
      ['已完成', ['完成了']],
    ]);
  });
});

describe('智能清单 / 过滤器看板', () => {
  const tasks = [
    task('高', { priority: 'high', dates: due('2026-10-13') }),
    task('低', { priority: 'low', dates: due('2026-10-14') }),
    task('过期', { dates: due('2026-10-01') }),
  ];

  it('groups by date unless the view groups by 优先级', () => {
    const board = arrangeAutoBoard(tasks, { sortBy: 'date', groupBy: 'none' }, ctx);
    expect(board.kind).toBe('auto');
    expect(board.columns.map((c) => [c.title, c.count])).toEqual([
      ['已过期', 1],
      ['今天 周二', 1],
      ['明天 周三', 1],
    ]);
    expect(board.columns.every((c) => c.column === null && c.sections.every((s) => s.title === ''))).toBe(true);
  });

  it('shows all four 优先级 columns when grouped by 优先级', () => {
    const board = arrangeAutoBoard(tasks, { sortBy: 'date', groupBy: 'priority' }, ctx);
    expect(board.columns.map((c) => [c.title, c.count])).toEqual([
      ['高优先级', 1],
      ['中优先级', 0],
      ['低优先级', 1],
      ['无优先级', 1],
    ]);
  });
});

describe('sortKeyForDrop', () => {
  const cardsInColumn = [
    { id: 'a', sortOrder: 'b' },
    { id: 'b', sortOrder: 'd' },
    { id: 'c', sortOrder: 'f' },
  ];
  const sorted = (key: string, others: string[]) => [...others, key].sort(compareSortKeys);

  it('places a card in front of the target, or at the end', () => {
    const front = sortKeyForDrop(cardsInColumn, 'x', 'a') as string;
    expect(sorted(front, ['b', 'd', 'f'])[0]).toBe(front);
    const middle = sortKeyForDrop(cardsInColumn, 'x', 'c') as string;
    expect(middle > 'd' && middle < 'f').toBe(true);
    const end = sortKeyForDrop(cardsInColumn, 'x', null) as string;
    expect(end > 'f').toBe(true);
    expect(sortKeyForDrop([], 'x', null)).toEqual(expect.any(String));
  });

  it('moves within the column, ignoring the card itself; null when nothing changes', () => {
    const key = sortKeyForDrop(cardsInColumn, 'a', null) as string;
    expect(key > 'f').toBe(true);
    expect(sortKeyForDrop(cardsInColumn, 'a', 'b')).toBeNull();
    expect(sortKeyForDrop(cardsInColumn, 'c', null)).toBeNull();
  });

  it('survives equal neighbour keys', () => {
    expect(() => sortKeyForDrop([{ id: 'a', sortOrder: 'b' }, { id: 'b', sortOrder: 'b' }], 'x', 'b')).not.toThrow();
  });
});

describe('删除分栏 query', () => {
  it('defaults to deleting the tasks; moveTo only with move', () => {
    expect(deleteKanbanColumnQuerySchema.parse({})).toEqual({ tasks: 'delete' });
    expect(deleteKanbanColumnQuerySchema.parse({ tasks: 'move' })).toEqual({ tasks: 'move' });
    expect(deleteKanbanColumnQuerySchema.safeParse({ tasks: 'delete', moveTo: uuid(1) }).success).toBe(false);
    expect(deleteKanbanColumnQuerySchema.safeParse({ tasks: 'other' }).success).toBe(false);
  });
});
