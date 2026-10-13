import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { ChangesResponse, EntityChanges } from '@dida/shared';
import type { Clock } from '../clock.js';
import type { Db, Executor, Tx } from '../db/client.js';
import { userRevisions } from '../db/schema/users.js';
import type { SyncColumnName, SyncEntity, SyncTable } from './columns.js';

/*
 * The sync layer (ADR-0004). All writes to synced entities go through
 * `SyncWriter` so that every change gets a fresh per-user revision,
 * `updated_at` from the injected clock, and deletes become tombstones.
 * Revisions are strictly increasing per user but may skip numbers.
 */

type Row<T extends SyncTable> = T['$inferSelect'];
/** Insert values: sync bookkeeping is filled in; `id` may be client-generated. */
export type SyncInsert<T extends SyncTable> = Omit<T['$inferInsert'], Exclude<SyncColumnName, 'id'>>;
export type SyncPatch<T extends SyncTable> = Partial<Omit<T['$inferInsert'], SyncColumnName>>;

export interface SyncOps {
  insert<T extends SyncTable>(table: T, values: SyncInsert<T>): Promise<Row<T>>;
  /** Update a live record of this user; null when missing, deleted or owned by someone else. */
  update<T extends SyncTable>(table: T, id: string, patch: SyncPatch<T>): Promise<Row<T> | null>;
  /** Soft delete; null when missing, already deleted or owned by someone else. */
  softDelete<T extends SyncTable>(table: T, id: string): Promise<Row<T> | null>;
}

export interface SyncWriter {
  /** Run `fn` in one transaction whose writes are attributed to `userId`. */
  transaction<R>(userId: string, fn: (ops: SyncOps, tx: Tx) => Promise<R>): Promise<R>;
}

/** Bump and return the user's revision. Holds the counter row lock until commit. */
export async function nextRevision(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .insert(userRevisions)
    .values({ userId, revision: 1 })
    .onConflictDoUpdate({
      target: userRevisions.userId,
      set: { revision: sql`${userRevisions.revision} + 1` },
    })
    .returning({ revision: userRevisions.revision });
  if (!row) throw new Error('revision counter upsert returned no row');
  return row.revision;
}

function liveRecord(table: SyncTable, userId: string, id: string) {
  return and(eq(table.id, id), eq(table.userId, userId), isNull(table.deletedAt));
}

function createOps(tx: Tx, userId: string, clock: Clock): SyncOps {
  return {
    async insert(table, values) {
      const revision = await nextRevision(tx, userId);
      const now = clock.now();
      const rows = await tx
        .insert(table)
        .values({ ...values, userId, createdAt: now, updatedAt: now, revision, deletedAt: null } as never)
        .returning();
      return rows[0] as Row<typeof table>;
    },
    async update(table, id, patch) {
      const revision = await nextRevision(tx, userId);
      const rows = (await tx
        .update(table)
        .set({ ...patch, updatedAt: clock.now(), revision } as never)
        .where(liveRecord(table, userId, id))
        .returning()) as unknown as Row<typeof table>[];
      return rows[0] ?? null;
    },
    async softDelete(table, id) {
      const revision = await nextRevision(tx, userId);
      const now = clock.now();
      const rows = (await tx
        .update(table)
        .set({ deletedAt: now, updatedAt: now, revision } as never)
        .where(liveRecord(table, userId, id))
        .returning()) as unknown as Row<typeof table>[];
      return rows[0] ?? null;
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A live record of `userId`, or null when it does not exist, is deleted, or
 * belongs to another user. Resource routes answer null with 404, so another
 * user's ids are indistinguishable from ids that never existed.
 */
export async function findOwned<T extends SyncTable>(
  db: Executor,
  table: T,
  userId: string,
  id: string,
): Promise<Row<T> | null> {
  if (!UUID.test(id)) return null;
  const rows = (await db.select().from(table as SyncTable).where(liveRecord(table, userId, id))) as Row<T>[];
  return rows[0] ?? null;
}

export function createSyncWriter(db: Db, clock: Clock): SyncWriter {
  return {
    transaction(userId, fn) {
      return db.transaction((tx) => fn(createOps(tx, userId, clock), tx));
    },
  };
}

function toJson(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'userId') continue;
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/**
 * Everything of `userId` changed after revision `since`, read from one
 * consistent snapshot so the returned `revision` covers exactly these rows.
 */
export async function readChanges(
  db: Db,
  entities: readonly SyncEntity[],
  userId: string,
  since: number,
): Promise<ChangesResponse> {
  return db.transaction(
    async (tx) => {
      const [counter] = await tx
        .select({ revision: userRevisions.revision })
        .from(userRevisions)
        .where(eq(userRevisions.userId, userId));
      const result: ChangesResponse = { revision: counter?.revision ?? 0, entities: {} };
      for (const { type, table } of entities) {
        const rows = (await tx
          .select()
          .from(table)
          .where(and(eq(table.userId, userId), gt(table.revision, since)))
          .orderBy(asc(table.revision))) as Record<string, unknown>[];
        const changes: EntityChanges = { upserts: [], tombstones: [] };
        for (const row of rows) {
          const json = toJson(row) as EntityChanges['upserts'][number];
          if (row.deletedAt) {
            changes.tombstones.push({
              id: json.id,
              revision: json.revision,
              deletedAt: json.deletedAt as string,
            });
          } else {
            changes.upserts.push(json);
          }
        }
        result.entities[type] = changes;
      }
      return result;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
