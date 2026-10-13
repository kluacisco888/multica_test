import { z } from 'zod';
import { holidayDaySchema } from './workday-calendar.js';

/*
 * 节假日数据 API (ADR-0006, spec 用户故事 114、115). The data is the same for
 * every 用户 (it is public State Council arrangements), so these endpoints
 * read and refresh one shared copy.
 */

/**
 * Where a year's data comes from:
 * - `remote`: fetched from holiday-cn and stored in the database
 * - `bundled`: the copy built into the image (fetching failed or has not run yet)
 * - `none`: no data (not announced yet); 工作日 falls back to Monday–Friday
 */
export const holidaySourceSchema = z.enum(['remote', 'bundled', 'none']);
export type HolidaySource = z.infer<typeof holidaySourceSchema>;

export const holidayYearStatusSchema = z.object({
  year: z.number().int(),
  source: holidaySourceSchema,
  /** Last successful fetch of this year from holiday-cn; null when never fetched. */
  fetchedAt: z.iso.datetime().nullable(),
});
export type HolidayYearStatus = z.infer<typeof holidayYearStatusSchema>;

/** `GET /api/holidays/status` */
export const holidayStatusSchema = z.object({
  /** 最后更新时间: the latest successful fetch of any year; null when never fetched. */
  lastUpdatedAt: z.iso.datetime().nullable(),
  /** The years refreshed daily: this year and next year. */
  years: z.array(holidayYearStatusSchema),
});
export type HolidayStatus = z.infer<typeof holidayStatusSchema>;

/**
 * Per-year outcome of a refresh:
 * - `updated`: the data changed (a 节假日数据更新 event was emitted)
 * - `unchanged`: fetched, same data as before
 * - `not_published`: holiday-cn has no file for that year yet
 * - `failed`: fetching failed; the stored or bundled data stays in use
 */
export const holidayRefreshOutcomeSchema = z.enum(['updated', 'unchanged', 'not_published', 'failed']);
export type HolidayRefreshOutcome = z.infer<typeof holidayRefreshOutcomeSchema>;

/** `POST /api/holidays/refresh` (立即更新) */
export const holidayRefreshResponseSchema = z.object({
  results: z.array(z.object({ year: z.number().int(), outcome: holidayRefreshOutcomeSchema })),
  status: holidayStatusSchema,
});
export type HolidayRefreshResponse = z.infer<typeof holidayRefreshResponseSchema>;

/** `GET /api/holidays/:year`: the 法定假日 and 调休补班 days of one year. */
export const holidayYearResponseSchema = z.object({
  year: z.number().int(),
  source: holidaySourceSchema,
  days: z.array(holidayDaySchema),
});
export type HolidayYearResponse = z.infer<typeof holidayYearResponseSchema>;
