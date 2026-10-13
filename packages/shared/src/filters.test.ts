import { describe, expect, it } from 'vitest';
import { filterRulesSchema, isEmptyFilter, liveRules, matchesFilter, type FilterRulesInput, type FilterTask } from './filters.js';

const clock = { now: new Date('2026-10-13T02:00:00.000Z'), timeZone: 'Asia/Shanghai' };
const LIST_A = '00000000-0000-4000-8000-00000000000a';
const LIST_B = '00000000-0000-4000-8000-00000000000b';
const TAG_X = '00000000-0000-4000-8000-0000000000f1';
const TAG_Y = '00000000-0000-4000-8000-0000000000f2';

const task = (extra: Partial<FilterTask> = {}): FilterTask => ({
  status: 'open',
  completedAt: null,
  dates: null,
  priority: 'none',
  listId: LIST_A,
  tagIds: [],
  ...extra,
});
const due = (dueDate: string) => ({ allDay: true as const, startDate: null, dueDate });

function matches(input: FilterRulesInput, t: FilterTask, scope: string[] = input.tagIds ?? []) {
  return matchesFilter(filterRulesSchema.parse(input), t, clock, new Set(scope));
}

describe('过滤器 rules', () => {
  it('an empty filter matches every task except 放弃 ones', () => {
    expect(isEmptyFilter(filterRulesSchema.parse({}))).toBe(true);
    expect(matches({}, task())).toBe(true);
    expect(matches({}, task({ status: 'completed', completedAt: '2026-10-01T00:00:00.000Z' }))).toBe(true);
    expect(matches({}, task({ status: 'abandoned' }))).toBe(false);
  });

  it('values within a condition are OR-ed', () => {
    expect(matches({ listIds: [LIST_A, LIST_B] }, task({ listId: LIST_B }))).toBe(true);
    expect(matches({ priorities: ['high', 'low'] }, task({ priority: 'low' }))).toBe(true);
    expect(matches({ priorities: ['high'] }, task({ priority: 'low' }))).toBe(false);
    expect(matches({ dates: ['today', 'noDate'] }, task())).toBe(true);
    expect(matches({ dates: ['today', 'noDate'] }, task({ dates: due('2026-10-13') }))).toBe(true);
    expect(matches({ dates: ['today', 'noDate'] }, task({ dates: due('2026-10-14') }))).toBe(false);
  });

  it('conditions are AND-ed', () => {
    const rules = { listIds: [LIST_A], tagIds: [TAG_X], priorities: ['high' as const], dates: ['week' as const] };
    const hit = task({ tagIds: [TAG_X], priority: 'high', dates: due('2026-10-19') });
    expect(matches(rules, hit)).toBe(true);
    expect(matches(rules, { ...hit, listId: LIST_B })).toBe(false);
    expect(matches(rules, { ...hit, tagIds: [TAG_Y] })).toBe(false);
    expect(matches(rules, { ...hit, priority: 'medium' })).toBe(false);
    expect(matches(rules, { ...hit, dates: due('2026-10-20') })).toBe(false);
  });

  it('标签: the scope (with child 标签) decides; 无标签 is its own option', () => {
    // TAG_Y is a child of TAG_X: the caller passes both in the scope.
    expect(matches({ tagIds: [TAG_X] }, task({ tagIds: [TAG_Y] }), [TAG_X, TAG_Y])).toBe(true);
    expect(matches({ tagIds: [TAG_X] }, task())).toBe(false);
    expect(matches({ untagged: true }, task())).toBe(true);
    expect(matches({ untagged: true }, task({ tagIds: [TAG_X] }))).toBe(false);
    expect(matches({ tagIds: [TAG_X], untagged: true }, task({ tagIds: [TAG_X] }))).toBe(true);
  });

  it('date options', () => {
    const at = (d: string, extra: Partial<FilterTask> = {}) => task({ dates: due(d), ...extra });
    expect(matches({ dates: ['overdue'] }, at('2026-10-12'))).toBe(true);
    expect(matches({ dates: ['overdue'] }, at('2026-10-13'))).toBe(false);
    // Completed tasks are never overdue.
    expect(matches({ dates: ['overdue'] }, at('2026-10-12', { status: 'completed', completedAt: '2026-10-12T00:00:00.000Z' }))).toBe(false);
    expect(matches({ dates: ['tomorrow'] }, at('2026-10-14'))).toBe(true);
    expect(matches({ dates: ['week'] }, at('2026-10-13'))).toBe(true);
    expect(matches({ dates: ['week'] }, at('2026-10-12'))).toBe(false);
  });

  it('rejects unknown fields and dedupes values', () => {
    expect(filterRulesSchema.safeParse({ status: 'open' }).success).toBe(false);
    expect(filterRulesSchema.safeParse({ dates: ['someday'] }).success).toBe(false);
    expect(filterRulesSchema.parse({ priorities: ['high', 'high'], listIds: [LIST_A, LIST_A.toUpperCase()] })).toMatchObject({
      priorities: ['high'],
      listIds: [LIST_A],
    });
  });

  it('liveRules drops ids that are no longer live; a condition left empty no longer restricts', () => {
    const rules = filterRulesSchema.parse({ listIds: [LIST_A, LIST_B], tagIds: [TAG_X], priorities: ['high'] });
    const live = liveRules(rules, new Set([LIST_B]), new Set());
    expect(live).toMatchObject({ listIds: [LIST_B], tagIds: [], priorities: ['high'] });
    expect(matchesFilter(live, task({ listId: LIST_B, priority: 'high' }), clock, new Set())).toBe(true);
    expect(isEmptyFilter(liveRules(filterRulesSchema.parse({ listIds: [LIST_A] }), new Set(), new Set()))).toBe(true);
  });
});
