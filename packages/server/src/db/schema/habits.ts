import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { HabitFrequency, HabitGoal } from '@dida/shared';
import { syncColumns, syncIndex } from '../../sync/columns.js';
import type { ChannelAttempt } from './reminders.js';

/**
 * 习惯 (spec 用户故事 93–98). Not a 任务: it never shows up in 清单.
 * `reminders` are times of day (`HH:mm`) in the user's time zone;
 * `reminder_channel_ids` null means the default 通知渠道. `archived_at` is
 * set while 已归档; deleting is a soft delete (its 打卡 are deleted too).
 */
export const habits = pgTable(
  'habits',
  {
    ...syncColumns(),
    name: text().notNull(),
    color: text(),
    frequency: jsonb().$type<HabitFrequency>().notNull(),
    goal: jsonb().$type<HabitGoal>().notNull(),
    reminders: jsonb().$type<string[]>().notNull().default([]),
    reminderChannelIds: uuid().array(),
    /** `YYYY-MM-DD` */
    startDate: text().notNull(),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [syncIndex('habits', t)],
);

/** 打卡: one day of one 习惯. 撤销 soft-deletes it; a new 打卡 that day revives the row. */
export const habitCheckins = pgTable(
  'habit_checkins',
  {
    ...syncColumns(),
    habitId: uuid()
      .notNull()
      .references(() => habits.id),
    /** `YYYY-MM-DD` */
    date: text().notNull(),
    count: integer().notNull(),
  },
  (t) => [
    syncIndex('habit_checkins', t),
    uniqueIndex('habit_checkins_habit_date_unique').on(t.habitId, t.date),
    check('habit_checkins_count_check', sql`${t.count} > 0`),
  ],
);

/**
 * One firing of a 习惯 提醒 (`fire_at` = that day's reminder time), sent to
 * 通知渠道 through the shared notifier with the 提醒 retries (1, 5, 15
 * minutes). Unique per habit and instant, so a reminder fires once.
 */
export const habitReminderDeliveries = pgTable(
  'habit_reminder_deliveries',
  {
    ...syncColumns(),
    habitId: uuid()
      .notNull()
      .references(() => habits.id),
    fireAt: timestamp({ withTimezone: true }).notNull(),
    status: text({ enum: ['delivering', 'done'] }).notNull(),
    nextAttemptAt: timestamp({ withTimezone: true }),
    channels: jsonb().$type<ChannelAttempt[]>().notNull().default([]),
  },
  (t) => [
    syncIndex('habit_reminder_deliveries', t),
    uniqueIndex('habit_reminder_deliveries_habit_fire_unique').on(t.habitId, t.fireAt),
    index('habit_reminder_deliveries_due_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'delivering'`),
    check('habit_reminder_deliveries_status_check', sql`${t.status} IN ('delivering', 'done')`),
  ],
);
