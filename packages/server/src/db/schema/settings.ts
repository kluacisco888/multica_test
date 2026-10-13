import { sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
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
  },
  (t) => [
    syncIndex('user_settings', t),
    uniqueIndex('user_settings_one_per_user').on(t.userId).where(sql`${t.deletedAt} IS NULL`),
  ],
);
