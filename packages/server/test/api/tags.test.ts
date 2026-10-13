import { randomUUID } from 'node:crypto';
import {
  changesResponseSchema,
  sidebarResponseSchema,
  tagSchema,
  tagsResponseSchema,
  taskSchema,
  tasksResponseSchema,
  type Tag,
  type Task,
} from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* 优先级 and 标签 (spec 用户故事 18、19、22). */

describe('priority and tags API', () => {
  const clock = fixedClock('2026-10-13T02:00:00.000Z');
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;
  let inboxId: string;

  beforeAll(async () => {
    t = await createTestApp({ clock });
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
    const sidebar = sidebarResponseSchema.parse((await api(alice, 'GET', '/api/lists')).json());
    inboxId = sidebar.lists.find((l) => l.isInbox)!.id;
  });
  afterAll(() => t.close());

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  async function createTag(user: TestUser, payload: object): Promise<Tag> {
    const res = await api(user, 'POST', '/api/tags', payload);
    expect(res.statusCode, res.body).toBe(201);
    return tagSchema.parse(res.json());
  }

  async function patchTag(user: TestUser, id: string, patch: object): Promise<Tag> {
    const res = await api(user, 'PATCH', `/api/tags/${id}`, patch);
    expect(res.statusCode, res.body).toBe(200);
    return tagSchema.parse(res.json());
  }

  async function tagsOf(user: TestUser): Promise<Tag[]> {
    const res = await api(user, 'GET', '/api/tags');
    expect(res.statusCode, res.body).toBe(200);
    return tagsResponseSchema.parse(res.json()).tags;
  }

  async function createTask(user: TestUser, payload: object): Promise<Task> {
    const res = await api(user, 'POST', '/api/tasks', payload);
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  async function patchTask(user: TestUser, id: string, patch: object): Promise<Task> {
    const res = await api(user, 'PATCH', `/api/tasks/${id}`, patch);
    expect(res.statusCode, res.body).toBe(200);
    return taskSchema.parse(res.json());
  }

  async function getTask(user: TestUser, id: string): Promise<Task> {
    const res = await api(user, 'GET', `/api/tasks/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return taskSchema.parse(res.json());
  }

  async function tagView(user: TestUser, tagId: string): Promise<string[]> {
    const res = await api(user, 'GET', `/api/tasks?tagId=${tagId}`);
    expect(res.statusCode, res.body).toBe(200);
    return tasksResponseSchema.parse(res.json()).tasks.map((x) => x.title);
  }

  describe('优先级', () => {
    it('defaults to none and can be set on create and changed', async () => {
      const plain = await createTask(alice, { title: '没优先级' });
      expect(plain).toMatchObject({ priority: 'none', tagIds: [] });
      const high = await createTask(alice, { title: '很急', priority: 'high' });
      expect(high.priority).toBe('high');
      for (const priority of ['medium', 'low', 'none', 'high'] as const) {
        const updated = await patchTask(alice, plain.id, { priority });
        expect(updated.priority).toBe(priority);
        expect((await getTask(alice, plain.id)).priority).toBe(priority);
      }
    });

    it('rejects unknown priorities', async () => {
      const task = await createTask(alice, { title: 'x' });
      for (const priority of ['urgent', 1, null]) {
        expect((await api(alice, 'PATCH', `/api/tasks/${task.id}`, { priority })).statusCode).toBe(400);
        expect((await api(alice, 'POST', '/api/tasks', { title: 'y', priority })).statusCode).toBe(400);
      }
    });
  });

  describe('标签', () => {
    it('creates, renames, recolours and lists tags with children after their parent', async () => {
      const carol = await t.createUser('carol');
      const id = randomUUID();
      const work = await createTag(carol, { id, name: ' 工作 ', color: '#FF6161' });
      expect(work).toMatchObject({ id, name: '工作', color: '#ff6161', parentId: null, createdAt: '2026-10-13T02:00:00.000Z' });
      const home = await createTag(carol, { name: '家' });
      const meeting = await createTag(carol, { name: '会议', parentId: work.id });
      const mail = await createTag(carol, { name: '邮件', parentId: work.id });
      expect((await tagsOf(carol)).map((x) => x.name)).toEqual(['工作', '会议', '邮件', '家']);

      const renamed = await patchTag(carol, home.id, { name: 'Home', color: null });
      expect(renamed).toMatchObject({ name: 'Home', color: null });
      expect(renamed.revision).toBeGreaterThan(home.revision);
      // Renaming only changes case of the same tag is fine.
      await patchTag(carol, home.id, { name: 'HOME' });

      // Moving a child out, then a top-level tag in.
      await patchTag(carol, mail.id, { parentId: null });
      await patchTag(carol, home.id, { parentId: work.id });
      expect((await tagsOf(carol)).map((x) => [x.name, x.parentId])).toEqual([
        ['工作', null],
        ['会议', work.id],
        ['HOME', work.id],
        ['邮件', null],
      ]);
      expect(meeting.parentId).toBe(work.id);
    });

    it('keeps nesting one level deep', async () => {
      const dave = await t.createUser('dave');
      const parent = await createTag(dave, { name: 'p' });
      const child = await createTag(dave, { name: 'c', parentId: parent.id });
      const other = await createTag(dave, { name: 'o' });
      const cases: [string, 'POST' | 'PATCH', object][] = [
        ['/api/tags', 'POST', { name: 'grandchild', parentId: child.id }],
        ['/api/tags', 'POST', { name: 'nope', parentId: randomUUID() }],
        [`/api/tags/${parent.id}`, 'PATCH', { parentId: other.id }], // has children
        [`/api/tags/${other.id}`, 'PATCH', { parentId: child.id }], // child cannot be a parent
        [`/api/tags/${other.id}`, 'PATCH', { parentId: other.id }],
      ];
      for (const [url, method, payload] of cases) {
        const res = await api(dave, method, url, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json().error.code).toBe('invalid_parent');
      }
    });

    it('rejects duplicate (case-insensitive) and malformed names', async () => {
      const erin = await t.createUser('erin');
      const a = await createTag(erin, { name: 'Read' });
      const b = await createTag(erin, { name: 'write' });
      for (const res of [
        await api(erin, 'POST', '/api/tags', { name: 'read' }),
        await api(erin, 'PATCH', `/api/tags/${b.id}`, { name: 'READ' }),
      ]) {
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('tag_name_taken');
      }
      for (const name of ['', 'a b', '#x', 'x'.repeat(65)]) {
        expect((await api(erin, 'POST', '/api/tags', { name })).statusCode, name).toBe(400);
      }
      expect((await api(erin, 'POST', '/api/tags', { name: 'ok', color: 'red' })).statusCode).toBe(400);
      expect((await api(erin, 'PATCH', `/api/tags/${a.id}`, { bogus: 1 })).statusCode).toBe(400);
      // Another user may use the same name.
      await createTag(bob, { name: 'read' });
    });

    it('gives a task several tags, de-duplicated, and replaces them on update', async () => {
      const x = await createTag(alice, { name: 'x' });
      const y = await createTag(alice, { name: 'y' });
      const task = await createTask(alice, { title: '多标签', tagIds: [x.id, y.id, x.id] });
      expect(task.tagIds).toEqual([x.id, y.id]);
      expect((await patchTask(alice, task.id, { tagIds: [y.id] })).tagIds).toEqual([y.id]);
      expect((await patchTask(alice, task.id, { tagIds: [] })).tagIds).toEqual([]);
    });

    it("refuses another user's or unknown tag ids on a task", async () => {
      const bobsTag = await createTag(bob, { name: 'bobs' });
      const task = await createTask(alice, { title: 'mine' });
      for (const tagIds of [[bobsTag.id], [randomUUID()]]) {
        const patched = await api(alice, 'PATCH', `/api/tasks/${task.id}`, { tagIds });
        expect(patched.statusCode).toBe(400);
        expect(patched.json().error.code).toBe('invalid_tags');
        expect((await api(alice, 'POST', '/api/tasks', { title: 'z', tagIds })).statusCode).toBe(400);
      }
      expect((await getTask(alice, task.id)).tagIds).toEqual([]);
    });

    it('sets 优先级 and 标签 when creating a 子任务, with the same tag checks', async () => {
      const tag = await createTag(alice, { name: 'sub' });
      const parent = await createTask(alice, { title: '父任务' });
      const child = await createTask(alice, { parentId: parent.id, title: '子任务', priority: 'high', tagIds: [tag.id] });
      expect(child).toMatchObject({ parentId: parent.id, priority: 'high', tagIds: [tag.id] });
      const bobsTag = await createTag(bob, { name: 'bobs-sub' });
      const refused = await api(alice, 'POST', '/api/tasks', { parentId: parent.id, title: 'z', tagIds: [bobsTag.id] });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe('invalid_tags');
    });

    it('shows a tag across 清单; a parent tag includes its children’s tasks', async () => {
      const list = (await api(alice, 'POST', '/api/lists', { name: '工作清单' })).json().id as string;
      const parent = await createTag(alice, { name: '项目' });
      const child = await createTag(alice, { name: '设计', parentId: parent.id });
      const sibling = await createTag(alice, { name: '开发', parentId: parent.id });
      await createTask(alice, { title: '父标签任务', tagIds: [parent.id] });
      await createTask(alice, { title: '子标签任务', listId: list, tagIds: [child.id] });
      await createTask(alice, { title: '另一个子标签', tagIds: [sibling.id] });
      await createTask(alice, { title: '两个都有', listId: list, tagIds: [child.id, parent.id] });
      await createTask(alice, { title: '没标签' });
      const done = await createTask(alice, { title: '完成了', tagIds: [child.id] });
      await patchTask(alice, done.id, { status: 'completed' });

      // Sort keys are per 清单, so only the open/completed split is ordered across 清单.
      const parentView = await tagView(alice, parent.id);
      expect(parentView.slice(0, 4).sort()).toEqual(['两个都有', '另一个子标签', '子标签任务', '父标签任务'].sort());
      expect(parentView[4]).toBe('完成了');
      const childView = await tagView(alice, child.id);
      expect(childView.slice(0, 2).sort()).toEqual(['两个都有', '子标签任务'].sort());
      expect(childView[2]).toBe('完成了');
      expect(await tagView(alice, sibling.id)).toEqual(['另一个子标签']);
    });

    it('validates the tasks query and hides other users’ tags', async () => {
      const bobsTag = await createTag(bob, { name: 'secret' });
      expect((await api(alice, 'GET', `/api/tasks?tagId=${bobsTag.id}`)).statusCode).toBe(404);
      expect((await api(alice, 'GET', `/api/tasks?tagId=${randomUUID()}`)).statusCode).toBe(404);
      expect((await api(alice, 'GET', '/api/tasks?tagId=nope')).statusCode).toBe(400);
      expect((await api(alice, 'GET', `/api/tasks?tagId=${bobsTag.id}&listId=${inboxId}`)).statusCode).toBe(400);
      expect((await api(alice, 'GET', '/api/tasks')).statusCode).toBe(400);
      expect((await api(alice, 'PATCH', `/api/tags/${bobsTag.id}`, { name: 'mine' })).statusCode).toBe(404);
      expect((await api(alice, 'DELETE', `/api/tags/${bobsTag.id}`)).statusCode).toBe(404);
      expect((await tagsOf(alice)).map((x) => x.id)).not.toContain(bobsTag.id);
      expect((await api(alice, 'POST', '/api/tags', { name: 'kid', parentId: bobsTag.id })).statusCode).toBe(400);
    });
  });

  describe('deleting a 标签', () => {
    it('removes it from its tasks, leaves the tasks otherwise untouched, and promotes its children', async () => {
      const frank = await t.createUser('frank');
      const list = (await api(frank, 'POST', '/api/lists', { name: '清单A' })).json().id as string;
      const gone = await createTag(frank, { name: 'gone', color: '#35d870' });
      const kid = await createTag(frank, { name: 'kid', parentId: gone.id });
      const keep = await createTag(frank, { name: 'keep' });
      const later = await createTag(frank, { name: 'later' });
      const both = await createTask(frank, { title: '两个标签', listId: list, priority: 'medium', tagIds: [gone.id, keep.id] });
      await patchTask(frank, both.id, { description: '**说明**' });
      const only = await createTask(frank, { title: '只有它', tagIds: [gone.id] });
      const done = await createTask(frank, { title: '完成的', tagIds: [gone.id, kid.id] });
      await patchTask(frank, done.id, { status: 'completed' });
      const inList = await createTask(frank, { title: '清单里的', listId: list, tagIds: [gone.id] });
      const untouched = await createTask(frank, { title: '无关', tagIds: [keep.id] });
      const before = await Promise.all([both, only, done, untouched].map((x) => getTask(frank, x.id)));
      void inList;
      const sinceBefore = changesResponseSchema.parse((await api(frank, 'GET', '/api/changes?since=0')).json()).revision;

      const res = await api(frank, 'DELETE', `/api/tags/${gone.id}`);
      expect(res.statusCode, res.body).toBe(204);

      const bothAfter = await getTask(frank, both.id);
      const onlyAfter = await getTask(frank, only.id);
      const doneAfter = await getTask(frank, done.id);
      const untouchedAfter = await getTask(frank, untouched.id);
      // The tag is gone from the tasks …
      expect(bothAfter.tagIds).toEqual([keep.id]);
      expect(onlyAfter.tagIds).toEqual([]);
      expect(doneAfter.tagIds).toEqual([kid.id]);
      // … and nothing else about them changed.
      const content = (x: Task) => ({ ...x, tagIds: undefined, revision: undefined, updatedAt: undefined });
      expect(content(bothAfter)).toEqual(content(before[0]!));
      expect(bothAfter).toMatchObject({ title: '两个标签', listId: list, priority: 'medium', description: '**说明**', status: 'open' });
      expect(doneAfter.status).toBe('completed');
      expect(onlyAfter.title).toBe('只有它');
      expect(untouchedAfter).toEqual(before[3]);

      // The tag itself: gone from the list, its view 404s, a new tag may take its name.
      const remaining = await tagsOf(frank);
      expect(remaining.map((x) => [x.name, x.parentId])).toEqual([
        ['kid', null], // promoted to where its parent was
        ['keep', null],
        ['later', null],
      ]);
      expect((await api(frank, 'GET', `/api/tasks?tagId=${gone.id}`)).statusCode).toBe(404);
      expect((await api(frank, 'DELETE', `/api/tags/${gone.id}`)).statusCode).toBe(404);
      expect((await api(frank, 'PATCH', `/api/tasks/${only.id}`, { tagIds: [gone.id] })).statusCode).toBe(400);
      await createTag(frank, { name: 'gone' });
      void later;

      // Sync clients see the tombstone and the changed tasks.
      const delta = changesResponseSchema.parse((await api(frank, 'GET', `/api/changes?since=${sinceBefore}`)).json());
      expect(delta.entities.tag?.tombstones.map((x) => x.id)).toEqual([gone.id]);
      expect(delta.entities.task?.upserts.map((x) => x.id).sort()).toEqual([both.id, only.id, done.id, inList.id].sort());
    });

    it('also strips the tag from tasks already in the trash', async () => {
      const gina = await t.createUser('gina');
      const list = (await api(gina, 'POST', '/api/lists', { name: 'L' })).json().id as string;
      const tag = await createTag(gina, { name: 't' });
      await createTask(gina, { title: 'in deleted list', listId: list, tagIds: [tag.id] });
      expect((await api(gina, 'DELETE', `/api/lists/${list}`)).statusCode).toBe(204);
      expect((await api(gina, 'DELETE', `/api/tags/${tag.id}`)).statusCode).toBe(204);
      const rows = await t.database.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM tasks WHERE $1::uuid = ANY(tag_ids)`,
        [tag.id],
      );
      expect(rows.rows[0]?.n).toBe(0);
    });
  });
});
