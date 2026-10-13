import { changesResponseSchema, tagSchema, taskSchema, type Tag, type Task } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* Review (EURO-8): data isolation and the sync semantics of deleting a 标签. */

describe('tags review', () => {
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
  async function createTag(user: TestUser, payload: object): Promise<Tag> {
    const res = await api(user, 'POST', '/api/tags', payload);
    expect(res.statusCode, res.body).toBe(201);
    return tagSchema.parse(res.json());
  }
  async function createTask(user: TestUser, payload: object): Promise<Task> {
    const res = await api(user, 'POST', '/api/tasks', payload);
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  it("cannot change another user's task priority or tags, nor nest under / take ids of their tags", async () => {
    const mine = await createTag(alice, { name: 'mine' });
    const task = await createTask(alice, { title: 'a', priority: 'low', tagIds: [mine.id] });
    for (const patch of [{ priority: 'high' }, { tagIds: [] }]) {
      expect((await api(bob, 'PATCH', `/api/tasks/${task.id}`, patch)).statusCode).toBe(404);
    }
    const bobs = await createTag(bob, { name: 'b' });
    expect((await api(bob, 'PATCH', `/api/tags/${bobs.id}`, { parentId: mine.id })).statusCode).toBe(400);
    // Reusing alice's tag id as bob's client-generated id must not touch alice's tag.
    expect((await api(bob, 'POST', '/api/tags', { id: mine.id, name: 'steal' })).statusCode).toBe(409);
    expect((await api(bob, 'GET', `/api/tasks?tagId=${mine.id}`)).statusCode).toBe(404);
    const after = taskSchema.parse((await api(alice, 'GET', `/api/tasks/${task.id}`)).json());
    expect(after).toMatchObject({ priority: 'low', tagIds: [mine.id] });
    const bobChanges = changesResponseSchema.parse((await api(bob, 'GET', '/api/changes?since=0')).json());
    expect(JSON.stringify(bobChanges)).not.toContain(mine.id);
    expect(JSON.stringify(bobChanges)).not.toContain(task.id);
  });

  it("deleting a tag does not touch another user's trashed tasks or revisions", async () => {
    const tag = await createTag(alice, { name: 'iso' });
    const list = (await api(alice, 'POST', '/api/lists', { name: 'L' })).json().id as string;
    await createTask(alice, { title: 'trashed', listId: list, tagIds: [tag.id] });
    expect((await api(alice, 'DELETE', `/api/lists/${list}`)).statusCode).toBe(204);
    const before = changesResponseSchema.parse((await api(alice, 'GET', '/api/changes?since=0')).json()).revision;
    expect((await api(alice, 'DELETE', `/api/tags/${tag.id}`)).statusCode).toBe(204);
    const delta = changesResponseSchema.parse((await api(alice, 'GET', `/api/changes?since=${before}`)).json());
    // Only the tag tombstone: the trashed task's cleanup is invisible to sync (its tombstone carries no tagIds).
    expect(delta.entities.tag?.tombstones.map((x) => x.id)).toEqual([tag.id]);
    expect(delta.entities.task?.upserts ?? []).toEqual([]);
    expect(delta.entities.task?.tombstones ?? []).toEqual([]);
  });

  it('tagging then deleting, or deleting then tagging, never leaves a deleted tag id on a task', async () => {
    const a = await createTag(alice, { name: 'seq-a' });
    const ta = await createTask(alice, { title: 'seq a' });
    expect((await api(alice, 'PATCH', `/api/tasks/${ta.id}`, { tagIds: [a.id] })).statusCode).toBe(200);
    expect((await api(alice, 'DELETE', `/api/tags/${a.id}`)).statusCode).toBe(204);
    expect(taskSchema.parse((await api(alice, 'GET', `/api/tasks/${ta.id}`)).json()).tagIds).toEqual([]);
    const b = await createTag(alice, { name: 'seq-b' });
    const tb = await createTask(alice, { title: 'seq b' });
    expect((await api(alice, 'DELETE', `/api/tags/${b.id}`)).statusCode).toBe(204);
    expect((await api(alice, 'PATCH', `/api/tasks/${tb.id}`, { tagIds: [b.id] })).statusCode).toBe(400);
  });
});
