import { sql } from 'drizzle-orm';
import { boolean, check, date, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { CountdownCalendar, CountdownRepeat, Reminder } from '@dida/shared';
import { syncColumns, syncIndex } from '../../sync/columns.js';

/**
 * 倒数日 (spec 用户故事 99–101). `date` is the 公历 date as entered; for a
 * 农历 倒数日 its 农历 day is what repeats (see shared/countdown-dates.ts).
 * `reminders` are day reminders relative to the next occurrence; each one
 * is scheduled in `reminder_deliveries` (`countdown_id`).
 */
export const countdowns = pgTable(
  'countdowns',
  {
    ...syncColumns(),
    name: text().notNull(),
    icon: text().notNull(),
    date: date().notNull(),
    calendar: text({ enum: ['solar', 'lunar'] }).$type<CountdownCalendar>().notNull(),
    repeat: text({ enum: ['none', 'yearly'] }).$type<CountdownRepeat>().notNull(),
    reminders: jsonb().$type<Reminder[]>().notNull().default([]),
    /** null: the default 通知渠道. */
    reminderChannelIds: jsonb().$type<string[] | null>(),
    pinned: boolean().notNull().default(false),
    /** 已归档; null while 记录中. */
    archivedAt: timestamp({ withTimezone: true }),
    sortOrder: text().notNull(),
  },
  (t) => [
    syncIndex('countdowns', t),
    check('countdowns_calendar_check', sql`${t.calendar} IN ('solar', 'lunar')`),
    check('countdowns_repeat_check', sql`${t.repeat} IN ('none', 'yearly')`),
  ],
);
