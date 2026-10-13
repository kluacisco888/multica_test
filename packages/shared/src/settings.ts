import { z } from 'zod';
import { hiddenSmartListsSchema, smartListIdSchema } from './smart-lists.js';
import { DEFAULT_TIME_ZONE, timeZoneSchema } from './task-dates.js';
import { MAX_VIEW_OPTIONS, viewKeySchema, viewOptionsSchema, type ViewOptions } from './task-view.js';

/**
 * Per-user preferences (设置): the time zone (spec 用户故事 26), hidden
 * 智能清单 (60) and each view's 排序 / 分组 (64).
 */

export const settingsSchema = z.object({
  /** IANA time zone used to store and show timed task dates. */
  timeZone: z.string(),
  /** 智能清单 hidden from the sidebar. */
  hiddenSmartLists: z.array(smartListIdSchema),
  /** View key (see `viewKeySchema`) → its sort and grouping; views not listed use `defaultViewOptions`. */
  viewOptions: z.record(z.string(), viewOptionsSchema),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = { timeZone: DEFAULT_TIME_ZONE, hiddenSmartLists: [], viewOptions: {} };

/**
 * `PATCH /api/settings`. `viewOptions` is merged per view: a view set to
 * null goes back to its default layout.
 */
export const updateSettingsRequestSchema = z
  .object({
    timeZone: timeZoneSchema,
    hiddenSmartLists: hiddenSmartListsSchema,
    viewOptions: z
      .record(viewKeySchema, viewOptionsSchema.nullable())
      .refine((r) => Object.keys(r).length <= MAX_VIEW_OPTIONS, '视图太多'),
  })
  .partial()
  .strict();
export type UpdateSettingsRequest = z.input<typeof updateSettingsRequestSchema>;

/** Apply a `viewOptions` patch, keeping at most `MAX_VIEW_OPTIONS` views. */
export function mergeViewOptions(
  current: Record<string, ViewOptions>,
  patch: Record<string, ViewOptions | null>,
): Record<string, ViewOptions> {
  const next: Record<string, ViewOptions> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const keys = Object.keys(next);
  // Oldest entries go first when over the cap (object keys keep insertion order).
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_VIEW_OPTIONS))) delete next[key];
  return next;
}
