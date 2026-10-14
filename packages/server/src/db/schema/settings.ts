import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { PomodoroSettings, ViewOptions } from '@dida/shared';
import { syncColumns, syncIndex } from '../../sync/columns.js';

/**
 * 设置: one row per user, created on the first change (reads fall back to the
 * defaults). A synced entity so offline clients get the time zone too.
 */
export const userSettings = pgTable(
  'user_settings',
  {
    ...syncColumns(),
    /** IANA time zone for timed task dates (spec 用户故事 26). */
    timeZone: text().notNull(),
    /** 智能清单 hidden from the sidebar (spec 用户故事 60). */
    hiddenSmartLists: text().array().notNull().default(sql`'{}'::text[]`),
    /** View key → 排序 / 分组 (spec 用户故事 64). */
    viewOptions: jsonb().$type<Record<string, ViewOptions>>().notNull().default({}),
    /** 全天提醒时间, `HH:mm` (spec 用户故事 80). */
    allDayReminderTime: text().notNull().default('09:00'),
    /*
     * 主题 (spec 用户故事 104): mode light / dark / system and the 颜色系列 id.
     * Plain text so a later mode or colour needs no migration. The defaults
     * repeat DEFAULT_THEME_MODE / DEFAULT_THEME_COLOR: drizzle-kit loads this
     * file without @dida/shared's runtime values.
     */
    themeMode: text().notNull().default('light'),
    themeColor: text().notNull().default('blue'),
    /** 四象限 names and rules (spec 用户故事 72); null until changed: the default quadrants. */
    matrixQuadrants: jsonb().$type<unknown>(),
    /** 番茄设置 (spec 用户故事 86); missing lengths read as their defaults. */
    pomodoro: jsonb().$type<Partial<PomodoroSettings>>().notNull().default({}),
  },
  (t) => [
    syncIndex('user_settings', t),
    uniqueIndex('user_settings_one_per_user').on(t.userId).where(sql`${t.deletedAt} IS NULL`),
  ],
);
