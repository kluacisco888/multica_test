import { bigint, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { syncColumns, syncIndex } from '../../sync/columns.js';
import { tasks } from './tasks.js';

/**
 * 附件 of a 任务. The file itself lives on the data volume at
 * `<DATA_DIR>/attachments/<user_id>/<id>` (see attachments/store.ts), so the
 * backup's attachments.tar and the database dump stay in step.
 */
export const attachments = pgTable(
  'attachments',
  {
    ...syncColumns(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    fileName: text().notNull(),
    /** Normalised `type/subtype` sent by the uploader. */
    mimeType: text().notNull(),
    /** Bytes; at most 50MB (ATTACHMENT_MAX_BYTES). */
    size: bigint({ mode: 'number' }).notNull(),
  },
  (t) => [syncIndex('attachments', t), index('attachments_task_idx').on(t.taskId)],
);

/** 评论 on a 任务: plain text, written by the 任务's user. */
export const comments = pgTable(
  'comments',
  {
    ...syncColumns(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    content: text().notNull(),
    /** Last edit of `content`; null when never edited. */
    editedAt: timestamp({ withTimezone: true }),
  },
  (t) => [syncIndex('comments', t), index('comments_task_idx').on(t.taskId)],
);
