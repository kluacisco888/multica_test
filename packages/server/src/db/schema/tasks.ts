import { sql } from 'drizzle-orm';
import { boolean, check, date, index, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
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
    /** 归档: hidden from the sidebar tree and its tasks kept out of every 智能清单; null while not archived. */
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    syncIndex('lists', t),
    // One live 收件箱 per user.
    uniqueIndex('lists_one_inbox_per_user').on(t.userId).where(sql`${t.isInbox} AND ${t.deletedAt} IS NULL`),
  ],
);

/**
 * 任务, including 子任务 (`parent_id`), 优先级 and 标签.
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
    /** Parent for a 子任务 (same 清单, at most 5 levels; enforced by the API). */
    parentId: uuid().references((): AnyPgColumn => tasks.id),
    title: text().notNull(),
    /** `text`: Markdown 描述; `checklist`: content is 检查项. */
    kind: text({ enum: ['text', 'checklist'] }).notNull().default('text'),
    /** Markdown source; empty in `checklist` mode. */
    description: text().notNull().default(''),
    status: text({ enum: ['open', 'completed', 'abandoned'] }).notNull().default('open'),
    completedAt: timestamp({ withTimezone: true }),
    /** 放弃: set while `status` is `abandoned`. */
    abandonedAt: timestamp({ withTimezone: true }),
    sortOrder: text().notNull(),
    allDay: boolean(),
    startDate: date(),
    dueDate: date(),
    startAt: timestamp({ withTimezone: true }),
    dueAt: timestamp({ withTimezone: true }),
    timeZone: text(),
    /** 优先级 */
    priority: text({ enum: ['none', 'low', 'medium', 'high'] }).notNull().default('none'),
    /** 标签 ids (no FK on array elements; routes only store live, own 标签 and deleting a 标签 strips it). */
    tagIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /**
     * 回收站: the 任务 whose deletion tombstoned this row (its own id for the
     * task the user deleted, the deleted ancestor for its 子任务). Restore and
     * 彻底删除 act on the whole batch. Null for rows not in the 回收站.
     */
    trashRootId: uuid(),
    /** Content cleared (彻底删除 or the 30-day cleanup); the tombstone stays (ADR-0004). */
    purgedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    syncIndex('tasks', t),
    index('tasks_trash_idx').on(t.userId, t.trashRootId).where(sql`${t.trashRootId} IS NOT NULL`),
    index('tasks_user_list_idx').on(t.userId, t.listId),
    index('tasks_parent_idx').on(t.parentId),
    index('tasks_tag_ids_idx').using('gin', t.tagIds),
    check('tasks_status_check', sql`${t.status} IN ('open', 'completed', 'abandoned')`),
    check(
      'tasks_dates_check',
      sql`CASE
        WHEN ${t.allDay} IS NULL THEN ${t.startDate} IS NULL AND ${t.dueDate} IS NULL AND ${t.startAt} IS NULL AND ${t.dueAt} IS NULL AND ${t.timeZone} IS NULL
        WHEN ${t.allDay} THEN ${t.dueDate} IS NOT NULL AND ${t.startAt} IS NULL AND ${t.dueAt} IS NULL AND ${t.timeZone} IS NULL AND (${t.startDate} IS NULL OR ${t.startDate} <= ${t.dueDate})
        ELSE ${t.dueAt} IS NOT NULL AND ${t.timeZone} IS NOT NULL AND ${t.startDate} IS NULL AND ${t.dueDate} IS NULL AND (${t.startAt} IS NULL OR ${t.startAt} <= ${t.dueAt})
      END`,
    ),
    check('tasks_kind_check', sql`${t.kind} IN ('text', 'checklist')`),
    check('tasks_priority_check', sql`${t.priority} IN ('none', 'low', 'medium', 'high')`),
  ],
);

/** 检查项 of a 任务 in 检查清单 mode: only a title and a checked state. */
export const checklistItems = pgTable(
  'checklist_items',
  {
    ...syncColumns(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    title: text().notNull(),
    completed: boolean().notNull().default(false),
    /** Fractional key among the 检查项 of the task. */
    sortOrder: text().notNull(),
    /** 回收站 batch, like `tasks.trash_root_id`: the 检查项 was tombstoned because that 任务 was deleted. */
    trashRootId: uuid(),
  },
  (t) => [syncIndex('checklist_items', t), index('checklist_items_task_idx').on(t.taskId)],
);
