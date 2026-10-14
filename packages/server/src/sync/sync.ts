import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
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
  /** Soft delete (with `patch` written in the same step); null when missing, already deleted or owned by someone else. */
  softDelete<T extends SyncTable>(table: T, id: string, patch?: SyncPatch<T>): Promise<Row<T> | null>;
  /** Bring a tombstone of this user back to life (回收站 还原); null when it is not a tombstone of this user. */
  restore<T extends SyncTable>(table: T, id: string, patch: SyncPatch<T>): Promise<Row<T> | null>;
  /**
   * Change a tombstone of this user without reviving it (回收站 彻底删除 clears
   * its content). It gets a new revision, so sync clients see the tombstone again.
   */
  updateTombstone<T extends SyncTable>(table: T, id: string, patch: SyncPatch<T>): Promise<Row<T> | null>;
}

/**
 * Runs at the end of a transaction that wrote rows of the table it was
 * registered for, before commit, in the same transaction. `ids` are the rows
 * written (inserted, updated, deleted, restored). Writes the hook makes to
 * other tables do not trigger their hooks again.
 */
export type WriteHook = (ctx: { ops: SyncOps; tx: Tx; userId: string; ids: string[] }) => Promise<void>;

export interface SyncWriter {
  /** Run `fn` in one transaction whose writes are attributed to `userId`. */
  transaction<R>(userId: string, fn: (ops: SyncOps, tx: Tx) => Promise<R>): Promise<R>;
  /** Keep derived data in step with a table (e.g. 提醒投递记录 with 任务), whatever route wrote it. */
  onWrite(table: SyncTable, hook: WriteHook): void;
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

/**
 * Take the user's revision counter row lock (held until commit) without
 * bumping the revision. Every sync transaction takes it first, so all writes
 * of one user run one after another and always in the same lock order
 * (revision row, then advisory / row locks). Checks made after it (does this
 * 标签 / 清单 still exist?) therefore see every write committed before, and
 * a concurrent 删除 cannot slip in between the check and the write.
 */
export async function lockRevision(tx: Tx, userId: string): Promise<void> {
  await tx
    .insert(userRevisions)
    .values({ userId, revision: 0 })
    .onConflictDoUpdate({
      target: userRevisions.userId,
      set: { revision: sql`${userRevisions.revision}` },
    });
}

function liveRecord(table: SyncTable, userId: string, id: string) {
  return and(eq(table.id, id), eq(table.userId, userId), isNull(table.deletedAt));
}

function tombstoneRecord(table: SyncTable, userId: string, id: string) {
  return and(eq(table.id, id), eq(table.userId, userId), isNotNull(table.deletedAt));
}

type Touched = Map<SyncTable, Set<string>>;

function createOps(tx: Tx, userId: string, clock: Clock, touched?: Touched): SyncOps {
  const touch = <T>(table: SyncTable, row: T): T => {
    if (touched && row) {
      let ids = touched.get(table);
      if (!ids) touched.set(table, (ids = new Set()));
      ids.add((row as unknown as { id: string }).id);
    }
    return row;
  };
  const ops = createRawOps(tx, userId, clock);
  return {
    insert: async (table, values) => touch(table, await ops.insert(table, values)),
    update: async (table, id, patch) => touch(table, await ops.update(table, id, patch)),
    softDelete: async (table, id, patch) => touch(table, await ops.softDelete(table, id, patch)),
    restore: async (table, id, patch) => touch(table, await ops.restore(table, id, patch)),
    updateTombstone: async (table, id, patch) => touch(table, await ops.updateTombstone(table, id, patch)),
  };
}

function createRawOps(tx: Tx, userId: string, clock: Clock): SyncOps {
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
    async softDelete(table, id, patch = {}) {
      const revision = await nextRevision(tx, userId);
      const now = clock.now();
      const rows = (await tx
        .update(table)
        .set({ ...patch, deletedAt: now, updatedAt: now, revision } as never)
        .where(liveRecord(table, userId, id))
        .returning()) as unknown as Row<typeof table>[];
      return rows[0] ?? null;
    },
    async restore(table, id, patch) {
      const revision = await nextRevision(tx, userId);
      const rows = (await tx
        .update(table)
        .set({ ...patch, deletedAt: null, updatedAt: clock.now(), revision } as never)
        .where(tombstoneRecord(table, userId, id))
        .returning()) as unknown as Row<typeof table>[];
      return rows[0] ?? null;
    },
    async updateTombstone(table, id, patch) {
      const revision = await nextRevision(tx, userId);
      const rows = (await tx
        .update(table)
        .set({ ...patch, updatedAt: clock.now(), revision } as never)
        .where(tombstoneRecord(table, userId, id))
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
  const hooks = new Map<SyncTable, WriteHook[]>();
  return {
    transaction(userId, fn) {
      return db.transaction(async (tx) => {
        await lockRevision(tx, userId);
        const touched: Touched = new Map();
        const result = await fn(createOps(tx, userId, clock, touched), tx);
        if (hooks.size > 0) {
          // Hooks write through ops that do not record, so they never re-trigger.
          const plain = createOps(tx, userId, clock);
          for (const [table, list] of hooks) {
            const ids = touched.get(table);
            if (!ids || ids.size === 0) continue;
            for (const hook of list) await hook({ ops: plain, tx, userId, ids: [...ids] });
          }
        }
        return result;
      });
    },
    onWrite(table, hook) {
      hooks.set(table, [...(hooks.get(table) ?? []), hook]);
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
      for (const { type, table, serialize } of entities) {
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
            changes.upserts.push(serialize ? (toJson(serialize(row as never) as Record<string, unknown>) as typeof json) : json);
          }
        }
        result.entities[type] = changes;
      }
      return result;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
