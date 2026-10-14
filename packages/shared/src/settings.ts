import { z } from 'zod';
import { defaultQuadrants, matrixQuadrantsSchema, quadrantSchema } from './matrix.js';
import { DEFAULT_ALL_DAY_REMINDER_TIME, timeOfDaySchema } from './reminders.js';
import { DEFAULT_POMODORO_SETTINGS, pomodoroSettingsPatchSchema, pomodoroSettingsSchema } from './focus.js';
import { DEFAULT_SMART_INPUT_SETTINGS, smartInputSettingsPatchSchema, smartInputSettingsSchema } from './smart-input.js';
import { hiddenSmartListsSchema, smartListIdSchema } from './smart-lists.js';
import { DEFAULT_TIME_ZONE, timeZoneSchema } from './task-dates.js';
import { DEFAULT_THEME_COLOR, DEFAULT_THEME_MODE, themeColorSchema, themeModeSchema } from './theme.js';
import { MAX_VIEW_OPTIONS, viewKeySchema, viewOptionsSchema, type ViewOptions } from './task-view.js';

/**
 * Per-user preferences (设置): the time zone (spec 用户故事 26), hidden
 * 智能清单 (60), each view's 排序 / 分组 (64), the 主题 (104) and the
 * 四象限 rules (72), the 番茄设置 (86) and 智能识别 (57–58).
 */

export const settingsSchema = z.object({
  /** IANA time zone used to store and show timed task dates. */
  timeZone: z.string(),
  /** 智能清单 hidden from the sidebar. */
  hiddenSmartLists: z.array(smartListIdSchema),
  /** View key (see `viewKeySchema`) → its sort and grouping; views not listed use `defaultViewOptions`. */
  viewOptions: z.record(z.string(), viewOptionsSchema),
  /** 全天提醒时间: when reminders of 全天 tasks fire, `HH:mm` (spec 用户故事 80). */
  allDayReminderTime: z.string(),
  /** 浅色 / 深色 / 跟随系统. */
  themeMode: themeModeSchema,
  /** 颜色系列. */
  themeColor: themeColorSchema,
  /** 四象限: the four quadrants' names and rules (see `matrix.ts`). */
  matrixQuadrants: z.array(quadrantSchema),
  /** 番茄设置 (spec 用户故事 86). */
  pomodoro: pomodoroSettingsSchema,
  /** 智能识别: on / off, 保留识别文字, 模糊时间 (spec 用户故事 57–58). */
  smartInput: smartInputSettingsSchema,
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  timeZone: DEFAULT_TIME_ZONE,
  hiddenSmartLists: [],
  viewOptions: {},
  allDayReminderTime: DEFAULT_ALL_DAY_REMINDER_TIME,
  themeMode: DEFAULT_THEME_MODE,
  themeColor: DEFAULT_THEME_COLOR,
  matrixQuadrants: defaultQuadrants(),
  pomodoro: { ...DEFAULT_POMODORO_SETTINGS },
  smartInput: { ...DEFAULT_SMART_INPUT_SETTINGS },
};

/**
 * `PATCH /api/settings`. `viewOptions` is merged per view: a view set to
 * null goes back to its default layout. `matrixQuadrants` replaces all four
 * quadrants; null restores the default ones.
 */
export const updateSettingsRequestSchema = z
  .object({
    timeZone: timeZoneSchema,
    hiddenSmartLists: hiddenSmartListsSchema,
    viewOptions: z
      .record(viewKeySchema, viewOptionsSchema.nullable())
      .refine((r) => Object.keys(r).length <= MAX_VIEW_OPTIONS, '视图太多'),
    allDayReminderTime: timeOfDaySchema,
    themeMode: themeModeSchema,
    themeColor: themeColorSchema,
    matrixQuadrants: matrixQuadrantsSchema.nullable(),
    /** Merged: only the given lengths change. */
    pomodoro: pomodoroSettingsPatchSchema,
    /** Merged: only the given fields change. */
    smartInput: smartInputSettingsPatchSchema,
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
