import { bigint, index, timestamp, uuid, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import { users } from '../db/schema/users.js';

/**
 * Columns every synced entity carries (ADR-0004). Spread into a table
 * definition and add `syncIndex` to its extra config:
 *
 *   export const lists = pgTable('lists', { ...syncColumns(), name: text().notNull() },
 *     (t) => [syncIndex('lists', t)]);
 */
export function syncColumns() {
  return {
    /** UUID primary key; clients may generate it. */
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull(),
    /** The owning user's revision at this record's last change. */
    revision: bigint({ mode: 'number' }).notNull(),
    /** Set on soft delete; the row stays as a tombstone. */
    deletedAt: timestamp({ withTimezone: true }),
  };
}

export function syncIndex(tableName: string, t: { userId: PgColumn; revision: PgColumn }) {
  return index(`${tableName}_user_revision_idx`).on(t.userId, t.revision);
}

export type SyncColumnName = keyof ReturnType<typeof syncColumns>;

/** A drizzle table built with `syncColumns()`. */
export type SyncTable = PgTable & Record<SyncColumnName, PgColumn>;

/** Registration of a synced entity type for `GET /api/changes`. */
export interface SyncEntity {
  /** Key in the changes response, e.g. "list", "task". */
  type: string;
  table: SyncTable;
}
