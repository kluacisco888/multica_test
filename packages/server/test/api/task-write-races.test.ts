import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { batchResponseSchema, tagSchema, taskSchema, type Tag, type Task } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * EURO-35: a task write racing the deletion of the 标签 / 清单 it points at.
 * Every task write and every 删除 of a 标签 / 清单 takes the user's revision
 * row lock first, so one of the two always sees the other's result.
 */

const ROUNDS = 50;

describe('task writes racing 标签 / 清单 deletion', () => {
  let t: TestApp;
  let alice: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    alice = await t.createUser('alice');
  });
  afterAll(() => t.close());

  function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: alice.headers, ...(payload ? { payload } : {}) });
  }
  async function createTag(name: string): Promise<Tag> {
    const res = await api('POST', '/api/tags', { name });
    expect(res.statusCode, res.body).toBe(201);
    return tagSchema.parse(res.json());
  }
  async function createTask(payload: object): Promise<Task> {
    const res = await api('POST', '/api/tasks', payload);
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }
  async function createList(name: string): Promise<string> {
    const res = await api('POST', '/api/lists', { name });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }
  async function liveTagIds(): Promise<Set<string>> {
    return new Set(((await api('GET', '/api/tags')).json().tags as Tag[]).map((tag) => tag.id));
  }
  async function liveListIds(): Promise<Set<string>> {
    return new Set(((await api('GET', '/api/lists')).json().lists as { id: string }[]).map((list) => list.id));
  }
  /** The live task, or null when it is gone (in the 回收站). */
  async function readTask(id: string): Promise<Task | null> {
    const res = await api('GET', `/api/tasks/${id}`);
    if (res.statusCode === 404) return null;
    expect(res.statusCode, res.body).toBe(200);
    return taskSchema.parse(res.json());
  }
  const tally = (counts: Record<string, number>, key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  it(`打标签 (PATCH) + 删标签, ${ROUNDS} rounds: no task keeps a deleted 标签 id`, async () => {
    const outcomes: Record<string, number> = {};
    const tagsBefore = (await liveTagIds()).size;
    for (let i = 0; i < ROUNDS; i++) {
      const keep = await createTag(`keep-${i}`);
      const doomed = await createTag(`doomed-${i}`);
      const task = await createTask({ title: `patch ${i}`, tagIds: [keep.id] });
      const [patch, del] = await Promise.all([
        api('PATCH', `/api/tasks/${task.id}`, { tagIds: [keep.id, doomed.id] }),
        api('DELETE', `/api/tags/${doomed.id}`),
      ]);
      expect(del.statusCode, del.body).toBe(204);
      expect([200, 400], patch.body).toContain(patch.statusCode);
      if (patch.statusCode === 400) expect(patch.json().error.code).toBe('invalid_tags');
      tally(outcomes, `PATCH ${patch.statusCode}`);
      const after = await readTask(task.id);
      expect(after?.tagIds).toEqual([keep.id]);
    }
    console.info(`[EURO-35] 打标签 + 删标签 × ${ROUNDS}:`, outcomes);
    // Only the 标签 kept each round are left.
    expect((await liveTagIds()).size).toBe(tagsBefore + ROUNDS);
  });

  it(`新建带标签的任务 (POST) + 删标签, ${ROUNDS} rounds: no task keeps a deleted 标签 id`, async () => {
    const outcomes: Record<string, number> = {};
    for (let i = 0; i < ROUNDS; i++) {
      const doomed = await createTag(`post-doomed-${i}`);
      const id = randomUUID();
      const [post, del] = await Promise.all([
        api('POST', '/api/tasks', { id, title: `post ${i}`, tagIds: [doomed.id] }),
        api('DELETE', `/api/tags/${doomed.id}`),
      ]);
      expect(del.statusCode, del.body).toBe(204);
      expect([201, 400], post.body).toContain(post.statusCode);
      tally(outcomes, `POST ${post.statusCode}`);
      const after = await readTask(id);
      if (post.statusCode === 201) expect(after?.tagIds).toEqual([]);
      else expect(after).toBeNull();
    }
    console.info(`[EURO-35] 新建带标签 + 删标签 × ${ROUNDS}:`, outcomes);
  });

  it(`批量打标签 + 删标签, ${ROUNDS} rounds: no task keeps a deleted 标签 id`, async () => {
    const outcomes: Record<string, number> = {};
    for (let i = 0; i < ROUNDS; i++) {
      const doomed = await createTag(`batch-doomed-${i}`);
      const a = await createTask({ title: `batch a ${i}` });
      const b = await createTask({ title: `batch b ${i}` });
      const [batch, del] = await Promise.all([
        api('POST', '/api/tasks/batch', { ids: [a.id, b.id], action: { op: 'tags', add: [doomed.id] } }),
        api('DELETE', `/api/tags/${doomed.id}`),
      ]);
      expect(del.statusCode, del.body).toBe(204);
      expect([200, 400], batch.body).toContain(batch.statusCode);
      tally(outcomes, `batch ${batch.statusCode}`);
      for (const task of [a, b]) expect((await readTask(task.id))?.tagIds).toEqual([]);
    }
    console.info(`[EURO-35] 批量打标签 + 删标签 × ${ROUNDS}:`, outcomes);
  });

  it(`移动任务到清单 + 删除该清单, ${ROUNDS} rounds: no live task points at a deleted 清单`, async () => {
    const outcomes: Record<string, number> = {};
    const home = await createList('home');
    for (let i = 0; i < ROUNDS; i++) {
      const doomed = await createList(`move-doomed-${i}`);
      const task = await createTask({ title: `move ${i}`, listId: home });
      const [patch, del] = await Promise.all([
        api('PATCH', `/api/tasks/${task.id}`, { listId: doomed }),
        api('DELETE', `/api/lists/${doomed}`),
      ]);
      expect(del.statusCode, del.body).toBe(204);
      expect([200, 400], patch.body).toContain(patch.statusCode);
      if (patch.statusCode === 400) expect(patch.json().error.code).toBe('invalid_list');
      tally(outcomes, `PATCH ${patch.statusCode}`);
      const after = await readTask(task.id);
      // Moved first: it went into the 回收站 with the 清单. Deleted first: the move was refused.
      if (patch.statusCode === 200) expect(after).toBeNull();
      else expect(after?.listId).toBe(home);
    }
    console.info(`[EURO-35] 移动到清单 + 删除清单 × ${ROUNDS}:`, outcomes);
    const lists = await liveListIds();
    const tasks = ((await api('GET', `/api/tasks?listId=${home}`)).json().tasks as Task[]).map((task) => task.listId);
    expect(tasks.every((listId) => lists.has(listId))).toBe(true);
  });

  it(`新建任务到清单 (POST) / 批量移动 + 删除该清单, ${ROUNDS} rounds: no live task points at a deleted 清单`, async () => {
    const outcomes: Record<string, number> = {};
    const home = await createList('home-2');
    for (let i = 0; i < ROUNDS; i++) {
      const doomed = await createList(`post-doomed-list-${i}`);
      const moved = await createTask({ title: `batch move ${i}`, listId: home });
      const id = randomUUID();
      const [post, batch, del] = await Promise.all([
        api('POST', '/api/tasks', { id, title: `into ${i}`, listId: doomed }),
        api('POST', '/api/tasks/batch', { ids: [moved.id], action: { op: 'move', listId: doomed } }),
        api('DELETE', `/api/lists/${doomed}`),
      ]);
      expect(del.statusCode, del.body).toBe(204);
      expect([201, 400], post.body).toContain(post.statusCode);
      expect([200, 400], batch.body).toContain(batch.statusCode);
      tally(outcomes, `POST ${post.statusCode} / batch ${batch.statusCode}`);
      const lists = await liveListIds();
      for (const taskId of [id, moved.id]) {
        const after = await readTask(taskId);
        if (after) expect(lists.has(after.listId), `${taskId} points at deleted 清单 ${after.listId}`).toBe(true);
      }
    }
    console.info(`[EURO-35] 新建到清单 / 批量移动 + 删除清单 × ${ROUNDS}:`, outcomes);
  });

  describe('a task that already carries a deleted 标签 id (left by the old race)', () => {
    /** Leave `tagId` on the task while the 标签 itself is deleted, as the race used to. */
    async function staleTask(title: string): Promise<{ task: Task; stale: string; keep: Tag }> {
      const keep = await createTag(`${title}-keep`);
      const gone = await createTag(`${title}-gone`);
      const task = await createTask({ title, tagIds: [gone.id, keep.id] });
      await t.database.db.execute(sql`UPDATE tags SET deleted_at = now() WHERE id = ${gone.id}`);
      return { task, stale: gone.id, keep };
    }

    it('批量打标签 / 去标签 still works and drops the stale id', async () => {
      const { task, stale, keep } = await staleTask('stale-batch');
      const extra = await createTag('stale-batch-extra');
      const add = await api('POST', '/api/tasks/batch', { ids: [task.id], action: { op: 'tags', add: [extra.id] } });
      expect(add.statusCode, add.body).toBe(200);
      expect(batchResponseSchema.parse(add.json()).tasks[0]?.tagIds).toEqual([keep.id, extra.id]);
      const remove = await api('POST', '/api/tasks/batch', { ids: [task.id], action: { op: 'tags', remove: [keep.id] } });
      expect(remove.statusCode, remove.body).toBe(200);
      expect((await readTask(task.id))?.tagIds).toEqual([extra.id]);
      expect((await readTask(task.id))?.tagIds).not.toContain(stale);
    });

    it('PATCH with the live 标签 only (what the web app now sends) succeeds', async () => {
      const { task, keep } = await staleTask('stale-patch');
      const extra = await createTag('stale-patch-extra');
      const res = await api('PATCH', `/api/tasks/${task.id}`, { tagIds: [keep.id, extra.id] });
      expect(res.statusCode, res.body).toBe(200);
      expect(taskSchema.parse(res.json()).tagIds).toEqual([keep.id, extra.id]);
    });
  });
});
