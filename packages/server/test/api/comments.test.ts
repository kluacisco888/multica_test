import { randomUUID } from 'node:crypto';
import { changesResponseSchema, commentSchema, commentsResponseSchema, taskSchema, type Comment, type Task } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* 评论 (spec 用户故事 39): create, edit, delete; ADR-0004 revision and soft delete. */

describe('评论 API', () => {
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

  async function createTask(user: TestUser, title = '写周报'): Promise<Task> {
    const res = await api(user, 'POST', '/api/tasks', { title });
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  async function addComment(user: TestUser, taskId: string, payload: object): Promise<Comment> {
    const res = await api(user, 'POST', `/api/tasks/${taskId}/comments`, payload);
    expect(res.statusCode, res.body).toBe(201);
    return commentSchema.parse(res.json());
  }

  async function commentsOf(user: TestUser, taskId: string): Promise<Comment[]> {
    const res = await api(user, 'GET', `/api/tasks/${taskId}/comments`);
    expect(res.statusCode, res.body).toBe(200);
    return commentsResponseSchema.parse(res.json()).comments;
  }

  async function revisionOf(user: TestUser): Promise<number> {
    return changesResponseSchema.parse((await api(user, 'GET', '/api/changes?since=0')).json()).revision;
  }

  it('writes 评论 oldest first, edits one (editedAt) and deletes one', async () => {
    const task = await createTask(alice);
    const first = await addComment(alice, task.id, { content: '  初稿写完了  ' });
    expect(first).toMatchObject({ taskId: task.id, content: '初稿写完了', editedAt: null, createdAt: '2026-10-13T02:00:00.000Z' });
    clock.advance(60_000);
    const second = await addComment(alice, task.id, { content: '第二行\n等老板看' });
    expect((await commentsOf(alice, task.id)).map((c) => c.content)).toEqual(['初稿写完了', '第二行\n等老板看']);

    clock.advance(60_000);
    const edited = await api(alice, 'PATCH', `/api/comments/${first.id}`, { content: '初稿改完了' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      content: '初稿改完了',
      editedAt: '2026-10-13T02:02:00.000Z',
      createdAt: '2026-10-13T02:00:00.000Z',
    });
    expect(edited.json().revision).toBeGreaterThan(first.revision);

    const deleted = await api(alice, 'DELETE', `/api/comments/${second.id}`);
    expect(deleted.statusCode).toBe(204);
    expect((await commentsOf(alice, task.id)).map((c) => c.content)).toEqual(['初稿改完了']);
    expect((await api(alice, 'PATCH', `/api/comments/${second.id}`, { content: 'x' })).statusCode).toBe(404);
    expect((await api(alice, 'DELETE', `/api/comments/${second.id}`)).statusCode).toBe(404);
  });

  it('rejects empty or too long 评论 and unknown fields', async () => {
    const task = await createTask(alice, '校验');
    for (const payload of [{ content: '' }, { content: '   ' }, { content: 'x'.repeat(5001) }, { content: 'ok', author: 'bob' }, {}]) {
      expect((await api(alice, 'POST', `/api/tasks/${task.id}/comments`, payload)).statusCode, JSON.stringify(payload).slice(0, 40)).toBe(400);
    }
    const ok = await addComment(alice, task.id, { content: 'x'.repeat(5000) });
    expect((await api(alice, 'PATCH', `/api/comments/${ok.id}`, { content: ' ' })).statusCode).toBe(400);
    expect((await api(alice, 'POST', `/api/tasks/${randomUUID()}/comments`, { content: 'hi' })).statusCode).toBe(404);
  });

  it("keeps 评论 private: another user gets 404 for reading, writing, editing and deleting", async () => {
    const task = await createTask(alice, '私密');
    const comment = await addComment(alice, task.id, { content: '只有我能看' });

    expect((await api(bob, 'GET', `/api/tasks/${task.id}/comments`)).statusCode).toBe(404);
    expect((await api(bob, 'POST', `/api/tasks/${task.id}/comments`, { content: '偷看' })).statusCode).toBe(404);
    expect((await api(bob, 'PATCH', `/api/comments/${comment.id}`, { content: '改掉' })).statusCode).toBe(404);
    expect((await api(bob, 'DELETE', `/api/comments/${comment.id}`)).statusCode).toBe(404);
    expect((await commentsOf(alice, task.id)).map((c) => c.content)).toEqual(['只有我能看']);
  });

  it('takes a client-generated id; 409 when taken', async () => {
    const task = await createTask(alice, '客户端 id');
    const id = randomUUID();
    expect((await addComment(alice, task.id, { id, content: 'a' })).id).toBe(id);
    expect((await api(alice, 'POST', `/api/tasks/${task.id}/comments`, { id, content: 'b' })).statusCode).toBe(409);
  });

  it('shows up in /api/changes: upserts with new revisions, then a tombstone after delete', async () => {
    const task = await createTask(alice, '同步');
    const since = await revisionOf(alice);
    const comment = await addComment(alice, task.id, { content: 'v1' });
    await api(alice, 'PATCH', `/api/comments/${comment.id}`, { content: 'v2' });

    const changes = changesResponseSchema.parse((await api(alice, 'GET', `/api/changes?since=${since}`)).json());
    expect(changes.entities.comment?.upserts).toEqual([expect.objectContaining({ id: comment.id, content: 'v2' })]);

    clock.advance(1000);
    await api(alice, 'DELETE', `/api/comments/${comment.id}`);
    const after = changesResponseSchema.parse((await api(alice, 'GET', `/api/changes?since=${changes.revision}`)).json());
    expect(after.entities.comment).toEqual({
      upserts: [],
      tombstones: [{ id: comment.id, revision: after.revision, deletedAt: clock.now().toISOString() }],
    });
    // Bob's feed never contains Alice's 评论.
    const bobs = changesResponseSchema.parse((await api(bob, 'GET', '/api/changes?since=0')).json());
    expect(bobs.entities.comment).toEqual({ upserts: [], tombstones: [] });
  });
});
