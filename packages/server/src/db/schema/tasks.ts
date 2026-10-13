import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { syncColumns, syncIndex } from '../../sync/columns.js';

/** 文件夹: groups 清单, one level deep, never holds tasks directly. */
export const folders = pgTable(
  'folders',
  {
    ...syncColumns(),
    name: text().notNull(),
    /** Fractional key; shares the top-level sidebar space with 清单 outside folders. */
    sortOrder: text().notNull(),
    collapsed: boolean().notNull().default(false),
  },
  (t) => [syncIndex('folders', t)],
);

/** 清单, including each user's single 收件箱 (`is_inbox`). */
export const lists = pgTable(
  'lists',
  {
    ...syncColumns(),
    name: text().notNull(),
    /** #rrggbb or null (no colour). */
    color: text(),
    /** Short emoji / symbol shown instead of the default icon, or null. */
    icon: text(),
    folderId: uuid().references(() => folders.id),
    sortOrder: text().notNull(),
    isInbox: boolean().notNull().default(false),
  },
  (t) => [
    syncIndex('lists', t),
    // One live 收件箱 per user.
    uniqueIndex('lists_one_inbox_per_user').on(t.userId).where(sql`${t.isInbox} AND ${t.deletedAt} IS NULL`),
  ],
);

/** 任务. Dates, priority, tags, subtasks etc. are added by later tasks. */
export const tasks = pgTable(
  'tasks',
  {
    ...syncColumns(),
    listId: uuid()
      .notNull()
      .references(() => lists.id),
    title: text().notNull(),
    /** Markdown source. */
    description: text().notNull().default(''),
    status: text({ enum: ['open', 'completed', 'abandoned'] }).notNull().default('open'),
    completedAt: timestamp({ withTimezone: true }),
    sortOrder: text().notNull(),
  },
  (t) => [
    syncIndex('tasks', t),
    index('tasks_user_list_idx').on(t.userId, t.listId),
    check('tasks_status_check', sql`${t.status} IN ('open', 'completed', 'abandoned')`),
  ],
);
