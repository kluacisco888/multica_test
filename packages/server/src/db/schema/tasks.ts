import { sql } from 'drizzle-orm';
import { boolean, check, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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

/**
 * 任务. Priority, tags, subtasks etc. are added by later tasks.
 *
 * Dates (spec 用户故事 23–26): `all_day` null means no date. All-day tasks use
 * the calendar-date columns (no time zone); timed tasks store UTC instants plus
 * the user's time zone when they were set. The check constraint keeps exactly
 * one shape filled in.
 */
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
    allDay: boolean(),
    startDate: date(),
    dueDate: date(),
    startAt: timestamp({ withTimezone: true }),
    dueAt: timestamp({ withTimezone: true }),
    timeZone: text(),
  },
  (t) => [
    syncIndex('tasks', t),
    index('tasks_user_list_idx').on(t.userId, t.listId),
    check('tasks_status_check', sql`${t.status} IN ('open', 'completed', 'abandoned')`),
    check(
      'tasks_dates_check',
      sql`CASE
        WHEN ${t.allDay} IS NULL THEN ${t.startDate} IS NULL AND ${t.dueDate} IS NULL AND ${t.startAt} IS NULL AND ${t.dueAt} IS NULL AND ${t.timeZone} IS NULL
        WHEN ${t.allDay} THEN ${t.dueDate} IS NOT NULL AND ${t.startAt} IS NULL AND ${t.dueAt} IS NULL AND ${t.timeZone} IS NULL AND (${t.startDate} IS NULL OR ${t.startDate} <= ${t.dueDate})
        ELSE ${t.dueAt} IS NOT NULL AND ${t.timeZone} IS NOT NULL AND ${t.startDate} IS NULL AND ${t.dueDate} IS NULL AND (${t.startAt} IS NULL OR ${t.startAt} <= ${t.dueAt})
      END`,
    ),
  ],
);
