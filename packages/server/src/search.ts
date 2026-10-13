import { and, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import { SEARCH_RESULT_LIMIT, type SearchMatchField, type SearchResponse } from '@dida/shared';
import type { Executor } from './db/client.js';
import { checklistItems, tasks } from './db/schema/tasks.js';
import { compareTasks, taskToApi } from './organize.js';

/*
 * 全局搜索 (spec 用户故事 63). Each place a task's text lives is a
 * `SearchSource`; the search runs every registered source, so adding a field
 * is one more entry in `searchSources` and nothing else changes:
 *
 *   - 评论 (EURO-16) registers a source over its comments table with
 *     `field: 'comment'` returning the commented task ids.
 *
 * No source filters by 清单: tasks of 清单 with 不进智能清单 on, and of 归档
 * 清单 (EURO-15), are found like any other. Only deleted tasks (回收站) are
 * left out, in `searchTasks`.
 */

export interface SearchSource {
  field: SearchMatchField;
  /** Ids of the user's tasks whose text in this source matches the ILIKE `pattern`. */
  matchingTaskIds(db: Executor, userId: string, pattern: string): Promise<string[]>;
}

/** ILIKE pattern for "contains `text`", with `%`, `_` and `\` taken literally. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const titleSource: SearchSource = {
  field: 'title',
  async matchingTaskIds(db, userId, pattern) {
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt), ilike(tasks.title, pattern)));
    return rows.map((r) => r.id);
  },
};

const descriptionSource: SearchSource = {
  field: 'description',
  async matchingTaskIds(db, userId, pattern) {
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt), ilike(tasks.description, pattern)));
    return rows.map((r) => r.id);
  },
};

const checklistSource: SearchSource = {
  field: 'checklist',
  async matchingTaskIds(db, userId, pattern) {
    const rows = await db
      .selectDistinct({ id: checklistItems.taskId })
      .from(checklistItems)
      .where(and(eq(checklistItems.userId, userId), isNull(checklistItems.deletedAt), ilike(checklistItems.title, pattern)));
    return rows.map((r) => r.id);
  },
};

/** Every place searched. 评论 (EURO-16) adds its source here. */
export const searchSources: SearchSource[] = [titleSource, descriptionSource, checklistSource];

/** Live tasks matching `query` in any source: open ones first, at most `SEARCH_RESULT_LIMIT`. */
export async function searchTasks(
  db: Executor,
  userId: string,
  query: string,
  sources: readonly SearchSource[] = searchSources,
): Promise<SearchResponse> {
  const pattern = containsPattern(query);
  const matches = new Map<string, SearchMatchField[]>();
  for (const source of sources) {
    for (const id of await source.matchingTaskIds(db, userId, pattern)) {
      matches.set(id, [...(matches.get(id) ?? []), source.field]);
    }
  }
  const ids = [...matches.keys()];
  const rows =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt), inArray(tasks.id, ids), or(eq(tasks.status, 'open'), eq(tasks.status, 'completed'))));
  const found = rows.sort(compareTasks).slice(0, SEARCH_RESULT_LIMIT);
  return {
    tasks: found.map(taskToApi),
    matches: Object.fromEntries(found.map((row) => [row.id, matches.get(row.id) ?? []])),
    truncated: rows.length > SEARCH_RESULT_LIMIT,
  };
}
