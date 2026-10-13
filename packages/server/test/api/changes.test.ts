import { randomUUID } from 'node:crypto';
import { changesResponseSchema } from '@dida/shared';
import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { syncColumns, syncIndex } from '../../src/sync/columns.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

// No feature table exists yet, so the sync layer is exercised through a
// fixture entity built exactly the way feature tables will be.
const notes = pgTable('sync_fixture_notes', { ...syncColumns(), title: text().notNull() }, (t) => [
  syncIndex('sync_fixture_notes', t),
]);

describe('GET /api/changes', () => {
  const clock = fixedClock('2026-03-01T08:00:00.000Z');
  let t: TestApp;
  let alice: Awaited<ReturnType<TestApp['createUser']>>;
  let bob: Awaited<ReturnType<TestApp['createUser']>>;

  async function changes(headers: Record<string, string>, since?: number | string) {
    const url = since === undefined ? '/api/changes' : `/api/changes?since=${since}`;
    return t.app.inject({ method: 'GET', url, headers });
  }

  async function changesOk(headers: Record<string, string>, since?: number) {
    const res = await changes(headers, since);
    expect(res.statusCode).toBe(200);
    return changesResponseSchema.parse(res.json());
  }

  beforeAll(async () => {
    t = await createTestApp({
      clock,
      syncEntities: [{ type: 'note', table: notes }],
      prepare: async ({ db }) => {
        await db.execute(sql`
          CREATE TABLE sync_fixture_notes (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL,
            revision bigint NOT NULL,
            deleted_at timestamptz,
            title text NOT NULL
          )`);
      },
    });
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
  });
  afterAll(() => t.close());

  it('requires a session user', async () => {
    const res = await changes({});
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it.each(['-1', 'abc', '1.5', ''])('rejects since=%j with 400', async (since) => {
    const res = await changes(alice.headers, since);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('starts at revision 0 with nothing to sync', async () => {
    const body = await changesOk(alice.headers);
    expect(body).toEqual({ revision: 0, entities: { note: { upserts: [], tombstones: [] } } });
  });

  it('returns created, updated and deleted records since a revision', async () => {
    const clientId = randomUUID();
    const first = await t.app.sync.transaction(alice.id, (ops) =>
      ops.insert(notes, { id: clientId, title: 'buy milk' }),
    );
    expect(first).toMatchObject({ id: clientId, revision: 1, deletedAt: null });
    expect(first.createdAt.toISOString()).toBe('2026-03-01T08:00:00.000Z');

    const second = await t.app.sync.transaction(alice.id, (ops) => ops.insert(notes, { title: 'call mom' }));

    const full = await changesOk(alice.headers, 0);
    expect(full.revision).toBe(2);
    expect(full.entities.note?.upserts.map((n) => n.title)).toEqual(['buy milk', 'call mom']);
    expect(full.entities.note?.upserts[0]).toEqual({
      id: clientId,
      title: 'buy milk',
      revision: 1,
      createdAt: '2026-03-01T08:00:00.000Z',
      updatedAt: '2026-03-01T08:00:00.000Z',
      deletedAt: null,
    });

    // Nothing new since the latest revision.
    expect((await changesOk(alice.headers, full.revision)).entities.note).toEqual({
      upserts: [],
      tombstones: [],
    });

    clock.advance(60_000);
    const updated = await t.app.sync.transaction(alice.id, (ops) =>
      ops.update(notes, clientId, { title: 'buy oat milk' }),
    );
    expect(updated).toMatchObject({ revision: 3, title: 'buy oat milk' });

    clock.advance(60_000);
    const deleted = await t.app.sync.transaction(alice.id, (ops) => ops.softDelete(notes, second.id));
    expect(deleted?.deletedAt?.toISOString()).toBe('2026-03-01T08:02:00.000Z');

    const delta = await changesOk(alice.headers, full.revision);
    expect(delta.revision).toBe(4);
    expect(delta.entities.note?.upserts).toEqual([
      expect.objectContaining({ id: clientId, title: 'buy oat milk', revision: 3, updatedAt: '2026-03-01T08:01:00.000Z' }),
    ]);
    // A tombstone carries no content, only what a client needs to delete its copy.
    expect(delta.entities.note?.tombstones).toEqual([
      { id: second.id, revision: 4, deletedAt: '2026-03-01T08:02:00.000Z' },
    ]);
  });

  it('keeps soft-deleted rows as tombstones and refuses to touch them again', async () => {
    const note = await t.app.sync.transaction(alice.id, (ops) => ops.insert(notes, { title: 'temp' }));
    await t.app.sync.transaction(alice.id, (ops) => ops.softDelete(notes, note.id));

    expect(await t.app.sync.transaction(alice.id, (ops) => ops.softDelete(notes, note.id))).toBeNull();
    expect(await t.app.sync.transaction(alice.id, (ops) => ops.update(notes, note.id, { title: 'x' }))).toBeNull();

    const rows = await t.database.db.select().from(notes).where(sql`${notes.id} = ${note.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('temp');
  });

  it('isolates users: separate revisions, no cross-user reads or writes', async () => {
    const before = await changesOk(alice.headers, 0);
    const bobNote = await t.app.sync.transaction(bob.id, (ops) => ops.insert(notes, { title: "bob's" }));
    expect(bobNote.revision).toBe(1);

    const bobView = await changesOk(bob.headers, 0);
    expect(bobView.revision).toBe(1);
    expect(bobView.entities.note?.upserts.map((n) => n.title)).toEqual(["bob's"]);

    const aliceView = await changesOk(alice.headers, 0);
    expect(aliceView.revision).toBe(before.revision);
    expect(aliceView.entities.note?.upserts.map((n) => n.id)).not.toContain(bobNote.id);

    // Alice cannot modify Bob's record.
    expect(await t.app.sync.transaction(alice.id, (ops) => ops.update(notes, bobNote.id, { title: 'hacked' }))).toBeNull();
    expect(await t.app.sync.transaction(alice.id, (ops) => ops.softDelete(notes, bobNote.id))).toBeNull();
    const bobAfter = await changesOk(bob.headers, 0);
    expect(bobAfter.entities.note?.upserts).toEqual([expect.objectContaining({ id: bobNote.id, title: "bob's" })]);
  });

  it('assigns strictly increasing revisions under concurrent writes', async () => {
    const carol = await t.createUser('carol');
    const written = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        t.app.sync.transaction(carol.id, (ops) => ops.insert(notes, { title: `n${i}` })),
      ),
    );
    const revisions = written.map((n) => n.revision).sort((a, b) => a - b);
    expect(new Set(revisions).size).toBe(20);

    const view = await changesOk(carol.headers, 0);
    expect(view.revision).toBe(revisions.at(-1));
    const listed = view.entities.note?.upserts.map((n) => n.revision);
    expect(listed).toEqual(revisions);
  });

  it.each(['1234567890123456', '0x10', '1e3', ' 1'])('rejects out-of-range or non-decimal since=%j with 400', async (since) => {
    const res = await changes(alice.headers, encodeURIComponent(since));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('rejects a repeated since parameter with 400', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/changes?since=1&since=2', headers: alice.headers });
    expect(res.statusCode).toBe(400);
  });

  it('returns nothing but the current revision when since is ahead of it', async () => {
    const erin = await t.createUser('erin');
    await t.app.sync.transaction(erin.id, (ops) => ops.insert(notes, { title: 'e1' }));
    expect(await changesOk(erin.headers, 999)).toEqual({
      revision: 1,
      entities: { note: { upserts: [], tombstones: [] } },
    });
  });

  it('reports a record updated and then deleted within one delta only as a tombstone', async () => {
    const frank = await t.createUser('frank');
    const note = await t.app.sync.transaction(frank.id, (ops) => ops.insert(notes, { title: 'f1' }));
    const base = (await changesOk(frank.headers, 0)).revision;
    await t.app.sync.transaction(frank.id, async (ops) => {
      await ops.update(notes, note.id, { title: 'f1 edited' });
      await ops.softDelete(notes, note.id);
    });
    const delta = await changesOk(frank.headers, base);
    expect(delta.entities.note?.upserts).toEqual([]);
    expect(delta.entities.note?.tombstones.map((x) => x.id)).toEqual([note.id]);
  });

  it("cannot take over another user's record by reusing its client-generated id", async () => {
    const gina = await t.createUser('gina');
    const hank = await t.createUser('hank');
    const ginaNote = await t.app.sync.transaction(gina.id, (ops) => ops.insert(notes, { title: "gina's" }));
    await expect(
      t.app.sync.transaction(hank.id, (ops) => ops.insert(notes, { id: ginaNote.id, title: 'stolen' })),
    ).rejects.toThrow();
    const ginaView = await changesOk(gina.headers, 0);
    expect(ginaView.entities.note?.upserts).toEqual([expect.objectContaining({ id: ginaNote.id, title: "gina's" })]);
    expect((await changesOk(hank.headers, 0)).entities.note?.upserts).toEqual([]);
  });

  it('rolls back the revision together with a failed transaction', async () => {
    const dave = await t.createUser('dave');
    await expect(
      t.app.sync.transaction(dave.id, async (ops) => {
        await ops.insert(notes, { title: 'never committed' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await changesOk(dave.headers, 0)).toEqual({
      revision: 0,
      entities: { note: { upserts: [], tombstones: [] } },
    });
  });
});
