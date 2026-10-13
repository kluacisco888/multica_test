import { integer, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { HolidayYear } from '@dida/shared';

/**
 * 节假日年份数据 fetched from NateScarlet/holiday-cn (ADR-0006). Not a synced
 * entity: it is public reference data shared by every 用户, written only by
 * the server's refresh job, never by clients. The built-in copy in
 * `packages/server/holidays/` is used for years missing here.
 */
export const holidayYears = pgTable('holiday_years', {
  id: uuid().primaryKey().defaultRandom(),
  year: integer().notNull().unique(),
  /** The validated holiday-cn file (year, papers, days). */
  data: jsonb().$type<HolidayYear>().notNull(),
  /** Last successful fetch, whether or not the data changed. */
  fetchedAt: timestamp({ withTimezone: true }).notNull(),
  /** Last time the fetched data differed from what was stored. */
  changedAt: timestamp({ withTimezone: true }).notNull(),
});
