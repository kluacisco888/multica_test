import { describe, expect, it } from 'vitest';
import type { FilterTask } from './filters.js';
import {
  DEFAULT_QUADRANTS,
  defaultQuadrants,
  liveQuadrants,
  matrixQuadrantsSchema,
  quadrantMatcher,
  quadrantPriority,
  storedQuadrants,
  type Quadrant,
} from './matrix.js';

const clock = { now: new Date('2026-10-13T02:00:00.000Z'), timeZone: 'Asia/Shanghai' };
const LIST_A = '00000000-0000-4000-8000-00000000000a';
const LIST_B = '00000000-0000-4000-8000-00000000000b';
const TAG_PARENT = '00000000-0000-4000-8000-0000000000f1';
const TAG_CHILD = '00000000-0000-4000-8000-0000000000f2';
const tags = [
  { id: TAG_PARENT, parentId: null, sortOrder: 'a0' },
  { id: TAG_CHILD, parentId: TAG_PARENT, sortOrder: 'a0' },
];

const task = (extra: Partial<FilterTask> = {}): FilterTask => ({
  status: 'open',
  completedAt: null,
  dates: null,
  priority: 'none',
  listId: LIST_A,
  tagIds: [],
  ...extra,
});

const quadrants = (rules: Partial<Quadrant['rules']>[]): Quadrant[] =>
  matrixQuadrantsSchema.parse(rules.map((r, i) => ({ name: `象限${i + 1}`, rules: r })));

describe('四象限 default rules', () => {
  it('splits tasks by 优先级: 高 / 中 / 低 / 无', () => {
    const m = quadrantMatcher(DEFAULT_QUADRANTS, tags, clock);
    expect(m.indexOf(task({ priority: 'high' }))).toBe(0);
    expect(m.indexOf(task({ priority: 'medium' }))).toBe(1);
    expect(m.indexOf(task({ priority: 'low' }))).toBe(2);
    expect(m.indexOf(task({ priority: 'none' }))).toBe(3);
    expect(DEFAULT_QUADRANTS.map((q) => q.name)).toEqual(['重要且紧急', '重要不紧急', '不重要但紧急', '不重要不紧急']);
  });

  it('shows completed tasks in their quadrant, never 放弃 ones', () => {
    const m = quadrantMatcher(DEFAULT_QUADRANTS, tags, clock);
    expect(m.indexOf(task({ priority: 'high', status: 'completed', completedAt: '2026-10-12T00:00:00.000Z' }))).toBe(0);
    expect(m.indexOf(task({ priority: 'high', status: 'abandoned' }))).toBe(-1);
  });

  it('defaultQuadrants() hands out copies', () => {
    const copy = defaultQuadrants();
    copy[0]!.rules.priorities.push('low');
    expect(DEFAULT_QUADRANTS[0]!.rules.priorities).toEqual(['high']);
  });
});

describe('四象限 custom rules', () => {
  it('a task goes to the first quadrant it passes, so never two at once', () => {
    const m = quadrantMatcher(quadrants([{ listIds: [LIST_B] }, { priorities: ['high'] }, {}, {}]), tags, clock);
    expect(m.indexOf(task({ listId: LIST_B, priority: 'high' }))).toBe(0);
    expect(m.indexOf(task({ priority: 'high' }))).toBe(1);
    expect(m.indexOf(task())).toBe(2);
  });

  it('tasks no quadrant takes are left out', () => {
    const m = quadrantMatcher(quadrants([{ priorities: ['high'] }, { priorities: ['medium'] }, { dates: ['today'] }, { listIds: [LIST_B] }]), tags, clock);
    expect(m.indexOf(task({ priority: 'low' }))).toBe(-1);
  });

  it('a parent 标签 includes its children; 日期 rules follow the clock', () => {
    const m = quadrantMatcher(quadrants([{ tagIds: [TAG_PARENT] }, { dates: ['overdue'] }, { priorities: ['none'] }, {}]), tags, clock);
    expect(m.indexOf(task({ tagIds: [TAG_CHILD] }))).toBe(0);
    expect(m.indexOf(task({ dates: { allDay: true, startDate: null, dueDate: '2026-10-12' }, priority: 'low' }))).toBe(1);
  });

  it('deleted 清单 / 标签 drop out of the rules', () => {
    const live = liveQuadrants(quadrants([{ listIds: [LIST_A, LIST_B] }, { tagIds: [TAG_PARENT] }, {}, {}]), new Set([LIST_A]), new Set());
    expect(live[0]!.rules.listIds).toEqual([LIST_A]);
    expect(live[1]!.rules.tagIds).toEqual([]);
  });
});

describe('quadrantPriority', () => {
  it('is the only 优先级 the rules name', () => {
    expect(DEFAULT_QUADRANTS.map((_, i) => quadrantPriority(DEFAULT_QUADRANTS, i))).toEqual(['high', 'medium', 'low', 'none']);
    expect(quadrantPriority(quadrants([{ priorities: ['low'] }, {}, {}, {}]), 0)).toBe('low');
  });

  it('falls back to the position when the rules name none or several', () => {
    const q = quadrants([{ listIds: [LIST_A] }, { priorities: ['high', 'low'] }, {}, { dates: ['today'] }]);
    expect([0, 1, 2, 3].map((i) => quadrantPriority(q, i))).toEqual(['high', 'medium', 'low', 'none']);
  });
});

describe('matrixQuadrantsSchema', () => {
  it('takes exactly four named quadrants', () => {
    expect(matrixQuadrantsSchema.safeParse(DEFAULT_QUADRANTS.slice(0, 3)).success).toBe(false);
    expect(matrixQuadrantsSchema.safeParse([...DEFAULT_QUADRANTS, DEFAULT_QUADRANTS[0]]).success).toBe(false);
    expect(matrixQuadrantsSchema.safeParse(DEFAULT_QUADRANTS.map((q) => ({ ...q, name: '  ' }))).success).toBe(false);
    expect(matrixQuadrantsSchema.safeParse(DEFAULT_QUADRANTS.map((q) => ({ ...q, extra: 1 }))).success).toBe(false);
  });

  it('stored data that does not parse reads as the defaults', () => {
    expect(storedQuadrants(null)).toEqual(DEFAULT_QUADRANTS);
    expect(storedQuadrants([{ name: 'x' }])).toEqual(DEFAULT_QUADRANTS);
  });
});
