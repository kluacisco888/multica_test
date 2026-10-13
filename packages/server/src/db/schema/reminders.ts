import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { syncColumns, syncIndex } from '../../sync/columns.js';
import { tasks } from './tasks.js';

/** One 通知渠道 of a 提醒投递记录 and how sending to it went. */
export interface ChannelAttempt {
  channelId: string;
  /** Channel name when the reminder fired (the channel may be renamed or deleted later). */
  channelName: string;
  status: 'pending' | 'sent' | 'failed';
  /** Attempts made so far (the first send plus retries). */
  attempts: number;
  /** ISO instant of the next attempt while `pending`. */
  nextAttemptAt: string | null;
  lastError: string | null;
  /** ISO instant it was sent or finally failed. */
  finishedAt: string | null;
}

export const DELIVERY_STATUSES = ['scheduled', 'delivering', 'done', 'cancelled', 'missed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * 提醒投递记录 (spec 用户故事 78–84): one firing of a 提醒 of a 任务.
 *
 * - `scheduled`: waiting for `fire_at`. Kept in step with the task (see
 *   reminders/scheduler.ts): editing, completing or deleting the task
 *   cancels or replaces it.
 * - `delivering`: fired; `channels` holds one entry per 通知渠道, retried
 *   1, 5 and 15 minutes after a failure. `next_attempt_at` is the earliest
 *   pending attempt.
 * - `done`: every channel sent or finally failed (failures are listed in the app).
 * - `cancelled`: the task changed before it fired.
 * - `missed`: came due more than 24 hours before the server could send it.
 *
 * `source` is `rule` for a reminder of the task (`reminder_key` names it) or
 * `snooze` for a 稍后提醒. A fired row is also the 应用内提醒 until
 * `alert_dismissed_at` is set.
 */
export const reminderDeliveries = pgTable(
  'reminder_deliveries',
  {
    ...syncColumns(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    source: text({ enum: ['rule', 'snooze'] }).notNull(),
    reminderKey: text(),
    fireAt: timestamp({ withTimezone: true }).notNull(),
    status: text({ enum: DELIVERY_STATUSES }).notNull(),
    firedAt: timestamp({ withTimezone: true }),
    nextAttemptAt: timestamp({ withTimezone: true }),
    channels: jsonb().$type<ChannelAttempt[]>().notNull().default([]),
    alertDismissedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    syncIndex('reminder_deliveries', t),
    index('reminder_deliveries_task_idx').on(t.taskId),
    index('reminder_deliveries_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} IN ('scheduled', 'delivering') AND ${t.deletedAt} IS NULL`),
    check('reminder_deliveries_status_check', sql`${t.status} IN ('scheduled', 'delivering', 'done', 'cancelled', 'missed')`),
    check('reminder_deliveries_source_check', sql`${t.source} IN ('rule', 'snooze')`),
  ],
);
