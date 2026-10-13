import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Executor } from './db/client.js';
import { lists, tasks } from './db/schema/tasks.js';
import type { TaskRow } from './organize.js';

/*
 * What every 智能清单 (今天、明天、最近 7 天、已完成、不重要的; EURO-13) starts
 * from: the user's live tasks in live 清单 that are not 归档 (spec 用户故事 16).
 * Each smart list adds its own date / status rule on top. The 回收站 is the
 * exception: it lists deleted tasks and is served by `trash.ts`.
 *
 * EURO-13 adds the 不进智能清单 switch here, next to the 归档 rule.
 */

/** 清单 whose tasks may appear in 智能清单. */
function smartListLists(userId: string) {
  return and(eq(lists.userId, userId), isNull(lists.deletedAt), isNull(lists.archivedAt));
}

/** Drizzle condition on `tasks`: candidates for the 智能清单 of `userId`. */
export function smartListScope(db: Executor, userId: string) {
  const eligible = db.select({ id: lists.id }).from(lists).where(smartListLists(userId));
  return and(eq(tasks.userId, userId), isNull(tasks.deletedAt), inArray(tasks.listId, eligible));
}

/** Every candidate task of the user's 智能清单, unordered. */
export async function smartListCandidates(db: Executor, userId: string): Promise<TaskRow[]> {
  return db.select().from(tasks).where(smartListScope(db, userId));
}
