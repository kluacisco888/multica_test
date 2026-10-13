import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { changesResponseSchema, taskSchema, type Task } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { migrationsFolder, rollbackLastMigration } from '../../src/db/migrations.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * Edge cases for 子任务 and 检查清单 (EURO-9 review): whole-subtree depth
 * boundaries, concurrent re-parenting, per-user /api/changes tombstones, and
 * rolling back only migration 0006 with data in place.
 */

describe('子任务 / 检查项 edge cases', () => {
  const clock = fixedClock('2026-10-13T02:00:00.000Z');
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    t = await createTestApp({ clock });
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
  });
  afterAll(() => t.close());

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  async function createTask(user: TestUser, payload: object): Promise<Task> {
    const res = await api(user, 'POST', '/api/tasks', payload);
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  async function newList(user: TestUser, name: string): Promise<string> {
    const res = await api(user, 'POST', '/api/lists', { name });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  /** root > … chain of `levels` tasks, root first. */
  async function chain(user: TestUser, listId: string, levels: number, prefix: string): Promise<Task[]> {
    const out: Task[] = [];
    for (let i = 1; i <= levels; i++) {
      out.push(await createTask(user, { listId, title: `${prefix}${i}`, parentId: out.at(-1)?.id ?? null }));
    }
    return out;
  }

  async function revision(user: TestUser): Promise<number> {
    return changesResponseSchema.parse((await api(user, 'GET', '/api/changes')).json()).revision;
  }

  it('moving a subtree counts its full height: exactly 5 levels is allowed, 6 is rejected', async () => {
    const listId = await newList(alice, 'depth');
    const target = await chain(alice, listId, 3, 'T'); // T3 is level 3
    const moved = await chain(alice, listId, 3, 'M'); // M1 > M2 > M3: height 3

    // M2 (height 2) under T3 → M3 lands on level 5: allowed.
    const ok = await api(alice, 'PATCH', `/api/tasks/${moved[1]!.id}`, { parentId: target[2]!.id });
    expect(ok.statusCode, ok.body).toBe(200);
    // M1 now has height 1; moving T1 (height 5 incl. M2,M3) under M1 → 6 levels.
    const tooDeep = await api(alice, 'PATCH', `/api/tasks/${target[0]!.id}`, { parentId: moved[0]!.id });
    expect(tooDeep.statusCode).toBe(400);
    expect(tooDeep.json().error.code).toBe('depth_exceeded');
    expect(tooDeep.json().error.message).toBe('子任务最多 5 层');
    // Nothing moved on rejection.
    expect(taskSchema.parse((await api(alice, 'GET', `/api/tasks/${target[0]!.id}`)).json()).parentId).toBeNull();
  });

  it('checks depth against the target 清单 when re-parenting across 清单', async () => {
    const a = await newList(alice, 'A');
    const b = await newList(alice, 'B');
    const deep = await chain(alice, b, 4, 'B'); // B4 on level 4
    const pair = await chain(alice, a, 2, 'P'); // height 2
    const res = await api(alice, 'PATCH', `/api/tasks/${pair[0]!.id}`, { parentId: deep[3]!.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('depth_exceeded');
    const leaf = await api(alice, 'PATCH', `/api/tasks/${pair[1]!.id}`, { parentId: deep[3]!.id });
    expect(leaf.statusCode, leaf.body).toBe(200);
    expect(leaf.json()).toMatchObject({ listId: b, parentId: deep[3]!.id });
  });

  it('concurrent opposite re-parents cannot build a cycle', async () => {
    const listId = await newList(alice, 'race');
    const x = await createTask(alice, { listId, title: 'X' });
    const y = await createTask(alice, { listId, title: 'Y' });
    const [r1, r2] = await Promise.all([
      api(alice, 'PATCH', `/api/tasks/${x.id}`, { parentId: y.id }),
      api(alice, 'PATCH', `/api/tasks/${y.id}`, { parentId: x.id }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 400]);
    const rows = [x, y].map(async (task) => taskSchema.parse((await api(alice, 'GET', `/api/tasks/${task.id}`)).json()));
    const [xx, yy] = await Promise.all(rows);
    expect(xx!.parentId === y.id && yy!.parentId === x.id).toBe(false);
  });

  it('concurrent moves cannot together pass 5 levels', async () => {
    const listId = await newList(alice, 'race-depth');
    const top = await chain(alice, listId, 3, 'U'); // U3 on level 3
    const mid = await createTask(alice, { listId, title: 'mid' }); // height 1
    const low = await chain(alice, listId, 2, 'L'); // height 2
    // mid under U3 (level 4) and L1 under mid (levels 5, 6) are each fine alone.
    const [r1, r2] = await Promise.all([
      api(alice, 'PATCH', `/api/tasks/${mid.id}`, { parentId: top[2]!.id }),
      api(alice, 'PATCH', `/api/tasks/${low[0]!.id}`, { parentId: mid.id }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 400]);
  });

  it('another user never sees my 检查项 upserts or tombstones in /api/changes', async () => {
    const task = await createTask(alice, { title: 'private list' });
    expect((await api(alice, 'PATCH', `/api/tasks/${task.id}`, { kind: 'checklist' })).statusCode).toBe(200);
    const item = (await api(alice, 'POST', `/api/tasks/${task.id}/checklist-items`, { title: 'secret' })).json();
    expect((await api(alice, 'DELETE', `/api/checklist-items/${item.id}`)).statusCode).toBe(204);
    const bobChanges = changesResponseSchema.parse((await api(bob, 'GET', '/api/changes?since=0')).json());
    const items = bobChanges.entities.checklistItem ?? { upserts: [], tombstones: [] };
    expect([...items.upserts, ...items.tombstones].map((x) => x.id)).not.toContain(item.id);
    const aliceChanges = changesResponseSchema.parse((await api(alice, 'GET', '/api/changes?since=0')).json());
    expect(aliceChanges.entities.checklistItem!.tombstones.map((x) => x.id)).toContain(item.id);
    expect(aliceChanges.entities.checklistItem!.upserts.map((x) => x.id)).not.toContain(item.id);
  });

  it('a repeated 检查项 POST with the same id is 409 and creates nothing twice', async () => {
    const task = await createTask(alice, { title: 'dup' });
    await api(alice, 'PATCH', `/api/tasks/${task.id}`, { kind: 'checklist' });
    const id = '0190a8a4-5b8e-7c1a-9d3e-1f2a3b4c5d70';
    const [a, b] = await Promise.all([
      api(alice, 'POST', `/api/tasks/${task.id}/checklist-items`, { id, title: 'once' }),
      api(alice, 'POST', `/api/tasks/${task.id}/checklist-items`, { id, title: 'once' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect((await api(alice, 'GET', `/api/tasks/${task.id}/checklist-items`)).json().items).toHaveLength(1);
  });

  it('round-trips 描述 ⇄ 检查清单 with markers, blank lines and CRLF', async () => {
    const task = await createTask(alice, { title: 'convert', description: '- [x] 一\r\n\r\n  * 二  \n3) 三\n[ ] 四' });
    const since = await revision(alice);
    expect((await api(alice, 'PATCH', `/api/tasks/${task.id}`, { kind: 'checklist' })).json()).toMatchObject({ kind: 'checklist', description: '' });
    const items = (await api(alice, 'GET', `/api/tasks/${task.id}/checklist-items`)).json().items as { title: string; completed: boolean }[];
    expect(items.map((i) => [i.title, i.completed])).toEqual([['一', true], ['二', false], ['三', false], ['四', false]]);
    const back = (await api(alice, 'PATCH', `/api/tasks/${task.id}`, { kind: 'text' })).json();
    expect(back).toMatchObject({ kind: 'text', description: '一\n二\n三\n四' });
    const delta = changesResponseSchema.parse((await api(alice, 'GET', `/api/changes?since=${since}`)).json());
    expect(delta.entities.checklistItem!.tombstones).toHaveLength(4);
  });
});

const MIGRATION = '0006_subtasks_checklist';

describe('migration 0006 rollback', () => {
  let database: TestDatabase;
  let reference: TestDatabase;
  let upTo0006: string;
  let before0006: string;

  /** A copy of the migrations folder whose journal keeps only the entries `keep` selects. */
  async function migrationsCopy(keep: (idx: number, target: number) => boolean): Promise<string> {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'dida-mig-'));
    await cp(migrationsFolder, folder, { recursive: true });
    const journalPath = path.join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
    const target = journal.entries.find((e) => e.tag === MIGRATION)!.idx;
    journal.entries = journal.entries.filter((e) => keep(e.idx, target));
    await writeFile(journalPath, JSON.stringify(journal));
    return folder;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    reference = await createTestDatabase();
    // Up to and including 0006, so later migrations don't change what "last" is;
    // and without it: the schema main had.
    upTo0006 = await migrationsCopy((idx, target) => idx <= target);
    before0006 = await migrationsCopy((idx, target) => idx < target);
  });
  afterAll(async () => {
    await database.destroy();
    await reference.destroy();
    await rm(upTo0006, { recursive: true, force: true });
    await rm(before0006, { recursive: true, force: true });
  });

  async function schemaOf(db: TestDatabase): Promise<unknown> {
    const columns = await db.db.execute(sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`);
    const constraints = await db.db.execute(sql`
      SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY tbl, conname`);
    const indexes = await db.db.execute(sql`
      SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname`);
    return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows };
  }

  it('undoes only 0006, keeps existing tasks, and leaves the schema main had', async () => {
    await migrate(database.db, { migrationsFolder: upTo0006 });
    await migrate(reference.db, { migrationsFolder: before0006 });

    // Some data that uses the new columns and table.
    await database.db.execute(sql`INSERT INTO users (id, username, password_hash)
      VALUES ('00000000-0000-4000-8000-000000000001', 'u', 'x')`);
    const uid = '00000000-0000-4000-8000-000000000001';
    await database.db.execute(sql`INSERT INTO lists (id, user_id, name, sort_order, created_at, updated_at, revision)
      VALUES ('00000000-0000-4000-8000-000000000002', ${uid}, 'L', 'a0', now(), now(), 1)`);
    await database.db.execute(sql`INSERT INTO tasks (id, user_id, list_id, title, sort_order, created_at, updated_at, revision)
      VALUES ('00000000-0000-4000-8000-000000000003', ${uid}, '00000000-0000-4000-8000-000000000002', 'root', 'a0', now(), now(), 1)`);
    await database.db.execute(sql`INSERT INTO tasks (id, user_id, list_id, parent_id, kind, title, sort_order, created_at, updated_at, revision)
      VALUES ('00000000-0000-4000-8000-000000000004', ${uid}, '00000000-0000-4000-8000-000000000002',
              '00000000-0000-4000-8000-000000000003', 'checklist', 'child', 'a1', now(), now(), 2)`);
    await database.db.execute(sql`INSERT INTO checklist_items (id, user_id, task_id, title, sort_order, created_at, updated_at, revision)
      VALUES ('00000000-0000-4000-8000-000000000005', ${uid}, '00000000-0000-4000-8000-000000000004', 'i', 'a0', now(), now(), 3)`);

    expect(await rollbackLastMigration(database.pool, upTo0006)).toBe(MIGRATION);
    expect(await schemaOf(database)).toEqual(await schemaOf(reference));
    const kept = await database.db.execute<{ title: string }>(sql`SELECT title FROM tasks ORDER BY title`);
    expect(kept.rows.map((r) => r.title)).toEqual(['child', 'root']);

    // Migrating up again re-applies 0006 on the existing data.
    await migrate(database.db, { migrationsFolder: upTo0006 });
    const again = await database.db.execute<{ kind: string; parent_id: string | null }>(sql`SELECT kind, parent_id FROM tasks`);
    expect(again.rows.every((r) => r.kind === 'text' && r.parent_id === null)).toBe(true);
  });
});
