import { and, eq, isNull, sql } from 'drizzle-orm';
import { DEFAULT_SETTINGS, type Settings } from '@dida/shared';
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
  return row ? { timeZone: row.timeZone } : { ...DEFAULT_SETTINGS };
}

export async function readSettings(db: Executor, userId: string): Promise<Settings> {
  const [row] = await db.select().from(userSettings).where(liveSettingsWhere(userId));
  return toSettings(row);
}

/** Apply `patch` inside a sync transaction, creating the row on first change. */
export async function writeSettings(ops: SyncOps, tx: Tx, userId: string, patch: Partial<Settings>): Promise<Settings> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETTINGS_LOCK}, hashtext(${userId}))`);
  const [existing] = await tx.select().from(userSettings).where(liveSettingsWhere(userId));
  if (!existing) return toSettings(await ops.insert(userSettings, { ...DEFAULT_SETTINGS, ...patch }));
  return toSettings((await ops.update(userSettings, existing.id, patch)) ?? undefined);
}
