import { z } from 'zod';
import { DEFAULT_TIME_ZONE, timeZoneSchema } from './task-dates.js';

/** Per-user preferences (设置). Only the time zone so far (spec 用户故事 26). */

export const settingsSchema = z.object({
  /** IANA time zone used to store and show timed task dates. */
  timeZone: z.string(),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = { timeZone: DEFAULT_TIME_ZONE };

/** `PATCH /api/settings` */
export const updateSettingsRequestSchema = z.object({ timeZone: timeZoneSchema }).partial().strict();
export type UpdateSettingsRequest = z.input<typeof updateSettingsRequestSchema>;
