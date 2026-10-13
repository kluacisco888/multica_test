import { z } from 'zod';
import { filterRulesSchema, liveRules, matchesFilter, type FilterRules, type FilterTask } from './filters.js';
import { entityNameSchema } from './lists.js';
import type { ViewClock } from './smart-lists.js';
import { tagWithChildren, type TagNode } from './tags.js';
import type { Priority } from './tasks.js';

/*
 * 四象限 (spec 用户故事 72、73): four quadrants, by default 高 / 中 / 低 / 无
 * 优先级. Each quadrant's rules are 过滤器 rules and can be changed; the four
 * are stored in 设置 (`matrixQuadrants`). A task shows in the first quadrant
 * whose rules it passes, so it is never in two at once; tasks no quadrant
 * takes are not shown. Dropping a task on a quadrant gives it the quadrant's
 * 优先级 (`quadrantPriority`).
 */

export const MATRIX_QUADRANT_COUNT = 4;

/** The 优先级 each quadrant stands for, in order 一 – 四. */
export const QUADRANT_PRIORITIES: readonly Priority[] = ['high', 'medium', 'low', 'none'];

export const quadrantSchema = z.object({ name: entityNameSchema, rules: filterRulesSchema }).strict();
export type Quadrant = z.output<typeof quadrantSchema>;
export type QuadrantInput = z.input<typeof quadrantSchema>;

export const matrixQuadrantsSchema = z.array(quadrantSchema).length(MATRIX_QUADRANT_COUNT);

const rulesFor = (priority: Priority): FilterRules => ({ listIds: [], tagIds: [], untagged: false, dates: [], priorities: [priority] });

/** The reference's default quadrants. */
export const DEFAULT_QUADRANTS: readonly Quadrant[] = [
  { name: '重要且紧急', rules: rulesFor('high') },
  { name: '重要不紧急', rules: rulesFor('medium') },
  { name: '不重要但紧急', rules: rulesFor('low') },
  { name: '不重要不紧急', rules: rulesFor('none') },
];

export function defaultQuadrants(): Quadrant[] {
  return DEFAULT_QUADRANTS.map((q) => ({ name: q.name, rules: { ...q.rules, priorities: [...q.rules.priorities] } }));
}

/** Stored quadrants, read leniently: missing or invalid data (an older version) gives the defaults. */
export function storedQuadrants(value: unknown): Quadrant[] {
  const parsed = matrixQuadrantsSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultQuadrants();
}

/** The quadrants as they apply now: deleted 清单 / 标签 left out of the rules (see `liveRules`). */
export function liveQuadrants(quadrants: readonly Quadrant[], liveListIds: ReadonlySet<string>, liveTagIds: ReadonlySet<string>): Quadrant[] {
  return quadrants.map((q) => ({ name: q.name, rules: liveRules(q.rules, liveListIds, liveTagIds) }));
}

/**
 * The 优先级 a task dropped on quadrant `index` gets: the only 优先级 its rules
 * name, otherwise the 优先级 the position stands for (一 高, 二 中, 三 低, 四 无).
 */
export function quadrantPriority(quadrants: readonly Quadrant[], index: number): Priority {
  const priorities = quadrants[index]?.rules.priorities ?? [];
  if (priorities.length === 1) return priorities[0] as Priority;
  return QUADRANT_PRIORITIES[index] ?? 'none';
}

/** Sorts tasks into quadrants; built once per render / request. */
export interface QuadrantMatcher {
  /** Index of the first quadrant `task` passes, or -1. */
  indexOf(task: FilterTask): number;
}

export function quadrantMatcher(
  quadrants: readonly Quadrant[],
  tags: readonly TagNode[],
  clock: ViewClock,
): QuadrantMatcher {
  const scopes = quadrants.map((q) => new Set(q.rules.tagIds.flatMap((id) => tagWithChildren(tags, id))));
  return {
    indexOf(task) {
      return quadrants.findIndex((q, i) => matchesFilter(q.rules, task, clock, scopes[i] as Set<string>));
    },
  };
}
