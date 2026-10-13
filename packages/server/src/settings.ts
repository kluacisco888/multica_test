import { and, eq, isNull, sql } from 'drizzle-orm';
import { DEFAULT_SETTINGS, mergeViewOptions, smartListIdSchema, type Settings, type ViewOptions } from '@dida/shared';
import type { Executor, Tx } from './db/client.js';
import { userSettings } from './db/schema/settings.js';
import type { SyncOps } from './sync/sync.js';

/* 设置: the user's preferences row, defaults until the first change. */

type SettingsRow = typeof userSettings.$inferSelect;

/** Advisory-lock namespace for creating a user's settings row (second key: hash of the user id). */
const SETTINGS_LOCK = 0x7365_7474; // "sett"

function liveSettingsWhere(userId: string) {
  return and(eq(userSettings.userId, userId), isNull(userSettings.deletedAt));
}

function toSettings(row: SettingsRow | undefined): Settings {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    timeZone: row.timeZone,
    // Ids a later version no longer knows are dropped rather than failing the read.
    hiddenSmartLists: row.hiddenSmartLists.flatMap((id) => {
      const parsed = smartListIdSchema.safeParse(id);
      return parsed.success ? [parsed.data] : [];
    }),
    viewOptions: row.viewOptions,
    allDayReminderTime: row.allDayReminderTime,
  };
}

export interface SettingsPatch {
  timeZone?: string;
  hiddenSmartLists?: Settings['hiddenSmartLists'];
  /** Merged per view; null resets a view to its default layout. */
  viewOptions?: Record<string, ViewOptions | null>;
  allDayReminderTime?: string;
}

export async function readSettings(db: Executor, userId: string): Promise<Settings> {
  const [row] = await db.select().from(userSettings).where(liveSettingsWhere(userId));
  return toSettings(row);
}

/** Apply `patch` inside a sync transaction, creating the row on first change. */
export async function writeSettings(ops: SyncOps, tx: Tx, userId: string, patch: SettingsPatch): Promise<Settings> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETTINGS_LOCK}, hashtext(${userId}))`);
  const [existing] = await tx.select().from(userSettings).where(liveSettingsWhere(userId));
  const { viewOptions, ...rest } = patch;
  const columns = {
    ...rest,
    ...(viewOptions ? { viewOptions: mergeViewOptions(existing?.viewOptions ?? {}, viewOptions) } : {}),
  };
  if (!existing) return toSettings(await ops.insert(userSettings, { ...DEFAULT_SETTINGS, ...columns }));
  return toSettings((await ops.update(userSettings, existing.id, columns)) ?? undefined);
}
