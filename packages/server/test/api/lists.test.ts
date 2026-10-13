import { randomUUID } from 'node:crypto';
import { changesResponseSchema, keyBetween, sidebarResponseSchema, type SidebarResponse } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* 收件箱、清单、文件夹 and sidebar order (spec 用户故事 12–15). */

describe('lists and folders API', () => {
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
  });
  afterAll(() => t.close());

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  async function sidebar(user: TestUser): Promise<SidebarResponse> {
    const res = await api(user, 'GET', '/api/lists');
    expect(res.statusCode).toBe(200);
    return sidebarResponseSchema.parse(res.json());
  }

  async function createList(user: TestUser, payload: object) {
    const res = await api(user, 'POST', '/api/lists', payload);
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  async function createFolder(user: TestUser, payload: object) {
    const res = await api(user, 'POST', '/api/folders', payload);
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  /** Sidebar as a readable outline: top level in order, folder children indented. */
  function outline(s: SidebarResponse): string[] {
    const top = [
      ...s.folders.map((f) => ({ key: f.sortOrder, label: `[${f.name}]`, folderId: f.id })),
      ...s.lists.filter((l) => !l.isInbox && !l.folderId).map((l) => ({ key: l.sortOrder, label: l.name, folderId: null })),
    ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return top.flatMap((item) => [
      item.label,
      ...(item.folderId
        ? s.lists
            .filter((l) => l.folderId === item.folderId)
            .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1))
            .map((l) => `  ${l.name}`)
        : []),
    ]);
  }

  describe('收件箱', () => {
    it('every user has exactly one, created automatically', async () => {
      const first = await sidebar(alice);
      const inboxes = first.lists.filter((l) => l.isInbox);
      expect(inboxes).toEqual([
        expect.objectContaining({ name: '收件箱', isInbox: true, folderId: null, color: null, icon: null }),
      ]);
      expect(first.lists[0]?.isInbox).toBe(true);

      // Concurrent first loads still end with one 收件箱.
      const carol = await t.createUser('carol');
      const loads = await Promise.all(Array.from({ length: 5 }, () => sidebar(carol)));
      const ids = new Set(loads.flatMap((s) => s.lists.filter((l) => l.isInbox).map((l) => l.id)));
      expect(ids.size).toBe(1);
      expect((await sidebar(alice)).lists.filter((l) => l.isInbox).map((l) => l.id)).toEqual([inboxes[0]?.id]);
    });

    it('cannot be deleted, renamed, recoloured or moved into a folder', async () => {
      const inbox = (await sidebar(alice)).lists.find((l) => l.isInbox)!;
      const folder = await createFolder(alice, { name: 'F' });
      for (const patch of [{ name: '改名' }, { color: '#ff6161' }, { folderId: folder.id }, { icon: '📋' }]) {
        const res = await api(alice, 'PATCH', `/api/lists/${inbox.id}`, patch);
        expect(res.statusCode, JSON.stringify(patch)).toBe(400);
        expect(res.json().error.code).toBe('inbox_protected');
      }
      const del = await api(alice, 'DELETE', `/api/lists/${inbox.id}`);
      expect(del.statusCode).toBe(400);
      expect(del.json().error.code).toBe('inbox_protected');
      expect((await sidebar(alice)).lists.find((l) => l.isInbox)).toEqual(inbox);
      await api(alice, 'DELETE', `/api/folders/${folder.id}`);
    });
  });

  describe('清单', () => {
    it('can be created with a colour and an icon, renamed, recoloured and deleted', async () => {
      const id = randomUUID();
      const created = await createList(alice, { id, name: '  工作  ', color: '#FF6161', icon: '💼' });
      expect(created).toMatchObject({ id, name: '工作', color: '#ff6161', icon: '💼', folderId: null, isInbox: false });

      const renamed = await api(alice, 'PATCH', `/api/lists/${id}`, { name: '工作项目', color: '#4ca1ff', icon: null });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ name: '工作项目', color: '#4ca1ff', icon: null });
      expect(renamed.json().revision).toBeGreaterThan(created.revision);

      const del = await api(alice, 'DELETE', `/api/lists/${id}`);
      expect(del.statusCode).toBe(204);
      expect((await sidebar(alice)).lists.map((l) => l.id)).not.toContain(id);
      expect((await api(alice, 'PATCH', `/api/lists/${id}`, { name: 'x' })).statusCode).toBe(404);
      expect((await api(alice, 'DELETE', `/api/lists/${id}`)).statusCode).toBe(404);
    });

    it('rejects invalid names, colours and icons', async () => {
      for (const payload of [{ name: '   ' }, { name: 'x'.repeat(65) }, { name: 'a', color: 'red' }, { name: 'a', icon: 'a b' }, {}]) {
        const res = await api(alice, 'POST', '/api/lists', payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json().error.code).toBe('invalid_request');
      }
      const list = await createList(alice, { name: 'valid' });
      for (const patch of [{ name: '' }, { sortOrder: 'a0' }, { isInbox: true }, { folderId: randomUUID() }]) {
        const res = await api(alice, 'PATCH', `/api/lists/${list.id}`, patch);
        expect(res.statusCode, JSON.stringify(patch)).toBe(400);
      }
      await api(alice, 'DELETE', `/api/lists/${list.id}`);
    });

    it('deleting a 清单 deletes its tasks too (tombstones for sync)', async () => {
      const list = await createList(alice, { name: 'temp' });
      const task = (await api(alice, 'POST', '/api/tasks', { listId: list.id, title: 'in temp' })).json();
      const before = changesResponseSchema.parse((await api(alice, 'GET', '/api/changes')).json()).revision;
      expect((await api(alice, 'DELETE', `/api/lists/${list.id}`)).statusCode).toBe(204);
      expect((await api(alice, 'GET', `/api/tasks/${task.id}`)).statusCode).toBe(404);
      const delta = changesResponseSchema.parse((await api(alice, 'GET', `/api/changes?since=${before}`)).json());
      expect(delta.entities.list?.tombstones.map((x) => x.id)).toEqual([list.id]);
      expect(delta.entities.task?.tombstones.map((x) => x.id)).toEqual([task.id]);
    });
  });

  describe('文件夹', () => {
    it('groups 清单 one level deep, can collapse, rename, and keeps its 清单 when deleted', async () => {
      const dave = await t.createUser('dave');
      const folder = await createFolder(dave, { name: '学习' });
      expect(folder).toMatchObject({ name: '学习', collapsed: false });
      const a = await createList(dave, { name: 'A', folderId: folder.id });
      const b = await createList(dave, { name: 'B', folderId: folder.id });
      const c = await createList(dave, { name: 'C' });
      expect(outline(await sidebar(dave))).toEqual(['[学习]', '  A', '  B', 'C']);

      const collapsed = await api(dave, 'PATCH', `/api/folders/${folder.id}`, { collapsed: true, name: '学习资料' });
      expect(collapsed.statusCode).toBe(200);
      expect((await sidebar(dave)).folders).toEqual([expect.objectContaining({ name: '学习资料', collapsed: true })]);

      // No nesting: folders have no parent field, and a folder id is not a 清单 id.
      expect((await api(dave, 'POST', '/api/folders', { name: 'x', folderId: folder.id })).statusCode).toBe(201);
      expect((await api(dave, 'POST', '/api/tasks', { listId: folder.id, title: 't' })).statusCode).toBe(400);

      const del = await api(dave, 'DELETE', `/api/folders/${folder.id}`);
      expect(del.statusCode).toBe(204);
      const after = await sidebar(dave);
      expect(after.folders.map((f) => f.name)).toEqual(['x']);
      // Its 清单 move to the top level where the folder was, in the same order.
      expect(outline(after)).toEqual(['A', 'B', 'C', '[x]']);
      expect(after.lists.filter((l) => [a.id, b.id, c.id].includes(l.id)).every((l) => l.folderId === null)).toBe(true);
    });
  });

  describe('sidebar order', () => {
    it('persists drag-and-drop moves: reorder, move into and out of a folder', async () => {
      const erin = await t.createUser('erin');
      const one = await createList(erin, { name: '1' });
      const two = await createList(erin, { name: '2' });
      const folder = await createFolder(erin, { name: 'F' });
      const three = await createList(erin, { name: '3' });
      expect(outline(await sidebar(erin))).toEqual(['1', '2', '[F]', '3']);

      // Drag "3" above "1".
      await api(erin, 'PATCH', `/api/lists/${three.id}`, { sortOrder: keyBetween(null, one.sortOrder) });
      // Drag the folder to the very top.
      await api(erin, 'PATCH', `/api/folders/${folder.id}`, { sortOrder: '1' });
      // Drop "2" into the folder.
      const moved = await api(erin, 'PATCH', `/api/lists/${two.id}`, { folderId: folder.id, sortOrder: 'V' });
      expect(moved.statusCode).toBe(200);
      expect(outline(await sidebar(erin))).toEqual(['[F]', '  2', '3', '1']);

      // Drag "1" into the folder above "2", then "2" back out to the end.
      await api(erin, 'PATCH', `/api/lists/${one.id}`, { folderId: folder.id, sortOrder: 'G' });
      await api(erin, 'PATCH', `/api/lists/${two.id}`, { folderId: null, sortOrder: 'z' });
      expect(outline(await sidebar(erin))).toEqual(['[F]', '  1', '3', '2']);
    });

    it('appends new 清单 and 文件夹 to the end of their level by default', async () => {
      const fred = await t.createUser('fred');
      const folder = await createFolder(fred, { name: 'F' });
      await createList(fred, { name: 'in', folderId: folder.id });
      await createList(fred, { name: 'in2', folderId: folder.id });
      await createList(fred, { name: 'top' });
      await createFolder(fred, { name: 'G' });
      expect(outline(await sidebar(fred))).toEqual(['[F]', '  in', '  in2', 'top', '[G]']);
    });
  });

  describe('isolation', () => {
    it("answers 404 for another user's 清单 and 文件夹 and never lists them", async () => {
      const list = await createList(bob, { name: "bob's list" });
      const folder = await createFolder(bob, { name: "bob's folder" });
      for (const [method, url, payload] of [
        ['PATCH', `/api/lists/${list.id}`, { name: 'hacked' }],
        ['DELETE', `/api/lists/${list.id}`, undefined],
        ['PATCH', `/api/folders/${folder.id}`, { name: 'hacked' }],
        ['DELETE', `/api/folders/${folder.id}`, undefined],
      ] as const) {
        const res = await api(alice, method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      // Nor can Alice file her 清单 into Bob's folder.
      expect((await api(alice, 'POST', '/api/lists', { name: 'x', folderId: folder.id })).statusCode).toBe(400);

      const aliceView = await sidebar(alice);
      expect(aliceView.lists.map((l) => l.id)).not.toContain(list.id);
      expect(aliceView.folders.map((f) => f.id)).not.toContain(folder.id);
      const bobView = await sidebar(bob);
      expect(bobView.lists.find((l) => l.id === list.id)?.name).toBe("bob's list");
      expect(bobView.folders.find((f) => f.id === folder.id)?.name).toBe("bob's folder");
    });

    it('refuses to reuse an existing id with 409', async () => {
      const list = await createList(bob, { name: 'mine' });
      const res = await api(alice, 'POST', '/api/lists', { id: list.id, name: 'stolen' });
      expect(res.statusCode).toBe(409);
      expect((await sidebar(bob)).lists.find((l) => l.id === list.id)?.name).toBe('mine');
    });
  });
});
