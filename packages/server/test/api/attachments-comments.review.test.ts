import { randomBytes, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  attachmentSchema,
  attachmentsResponseSchema,
  commentSchema,
  COMMENT_MAX_LENGTH,
  taskSchema,
  type Task,
} from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* EURO-16 review: edge cases of 附件 and 评论 beyond the implementation's own tests. */

describe('附件 / 评论 review edge cases', () => {
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
  });
  afterAll(() => t.close());

  async function createTask(user: TestUser, title = '审查'): Promise<Task> {
    const res = await t.app.inject({ method: 'POST', url: '/api/tasks', headers: user.headers, payload: { title } });
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  function upload(user: TestUser, taskId: string, name: string, body: Buffer | Readable, extra = '', headers: Record<string, string> = {}) {
    return t.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/attachments?name=${encodeURIComponent(name)}${extra}`,
      headers: { ...user.headers, 'content-type': 'application/octet-stream', ...headers },
      payload: body,
    });
  }

  const download = (user: TestUser, id: string) =>
    t.app.inject({ method: 'GET', url: `/api/attachments/${id}/content`, headers: user.headers });

  // KNOWN BUG (EURO-16 review): the loser's rename overwrites the winner's file, then its rollback
  // deletes it, so the 201 attachment is gone (404). Change `it.fails` back to `it` once fixed.
  it.fails('two concurrent uploads with the same client id: the one that wins keeps its own bytes on disk', async () => {
    const task = await createTask(alice, '并发同 id');
    const id = randomUUID();
    const a = randomBytes(2_000_000);
    const b = randomBytes(2_000_000);
    const [ra, rb] = await Promise.all([upload(alice, task.id, 'a.bin', a, `&id=${id}`), upload(alice, task.id, 'b.bin', b, `&id=${id}`)]);
    const codes = [ra.statusCode, rb.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const winner = ra.statusCode === 201 ? a : b;
    const res = await download(alice, id);
    // Owner's 201 attachment must still be downloadable with the bytes that were accepted.
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(winner)).toBe(true);
  });

  it('a chunked body between 50MB and 100MB is rejected and leaves no partial file behind', async () => {
    const task = await createTask(alice, '分块 60MB');
    const chunk = Buffer.alloc(1024 * 1024, 7);
    let sent = 0;
    const body = new Readable({
      read() {
        if (sent >= 60) return this.push(null);
        sent += 1;
        this.push(chunk);
      },
    });
    const res = await upload(alice, task.id, 'big.bin', body, '', { 'transfer-encoding': 'chunked' });
    expect(res.statusCode).toBe(413);
    const incoming = await readdir(path.join(t.config.dataDir, 'attachments', '.incoming')).catch(() => []);
    expect(incoming).toEqual([]);
  });

  it('an empty file is accepted with size 0; a non-UUID client id is a 400', async () => {
    const task = await createTask(alice, '空文件');
    const res = await upload(alice, task.id, 'empty.txt', Buffer.alloc(0));
    expect(res.statusCode, res.body).toBe(201);
    expect(attachmentSchema.parse(res.json()).size).toBe(0);
    expect((await upload(alice, task.id, 'x.txt', Buffer.from('x'), '&id=not-a-uuid')).statusCode).toBe(400);
    expect((await upload(alice, task.id, 'x.txt', Buffer.from('x'), '&evil=1')).statusCode).toBe(400);
  });

  it('a file claiming image/png but holding HTML is served as image/png with nosniff (never text/html)', async () => {
    const task = await createTask(alice, '伪装类型');
    const res = await upload(alice, task.id, 'x.png', Buffer.from('<script>alert(1)</script>'), '', { 'content-type': 'image/png' });
    const att = attachmentSchema.parse(res.json());
    const got = await download(alice, att.id);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    // A malformed Content-Type is refused by Fastify (415); an unknown but valid one is download-only.
    const malformed = await upload(alice, task.id, 'y', Buffer.from('y'), '', { 'content-type': 'not a type' });
    expect(malformed.statusCode).toBe(415);
    const weirdRes = await upload(alice, task.id, 'y', Buffer.from('y'), '', { 'content-type': 'application/x-made-up' });
    expect(weirdRes.statusCode, weirdRes.body).toBe(201);
    const weird = attachmentSchema.parse(weirdRes.json());
    expect(weird.mimeType).toBe('application/x-made-up');
    expect(weird.preview).toBeNull();
  });

  it("bob cannot upload into alice's 任务 even with a client id, and alice's id stays usable", async () => {
    const task = await createTask(alice, '跨用户 id');
    const id = randomUUID();
    expect((await upload(bob, task.id, 'x', Buffer.from('x'), `&id=${id}`)).statusCode).toBe(404);
    expect((await upload(alice, task.id, 'x', Buffer.from('x'), `&id=${id}`)).statusCode).toBe(201);
    const list = await t.app.inject({ method: 'GET', url: `/api/tasks/${task.id}/attachments`, headers: alice.headers });
    expect(attachmentsResponseSchema.parse(list.json()).attachments.map((a) => a.id)).toEqual([id]);
  });

  it('评论: whitespace-only and over-limit are 400; exactly the limit is OK; edit of a deleted one is 404', async () => {
    const task = await createTask(alice, '评论边界');
    const url = `/api/tasks/${task.id}/comments`;
    for (const content of ['   ', '\n\t', 'x'.repeat(COMMENT_MAX_LENGTH + 1)]) {
      const res = await t.app.inject({ method: 'POST', url, headers: alice.headers, payload: { content } });
      expect(res.statusCode, JSON.stringify(content).slice(0, 20)).toBe(400);
    }
    const ok = await t.app.inject({ method: 'POST', url, headers: alice.headers, payload: { content: 'x'.repeat(COMMENT_MAX_LENGTH) } });
    expect(ok.statusCode).toBe(201);
    const comment = commentSchema.parse(ok.json());
    expect((await t.app.inject({ method: 'DELETE', url: `/api/comments/${comment.id}`, headers: alice.headers })).statusCode).toBe(204);
    const edit = await t.app.inject({ method: 'PATCH', url: `/api/comments/${comment.id}`, headers: alice.headers, payload: { content: '复活' } });
    expect(edit.statusCode).toBe(404);
    // Anonymous: 401 on every comment route.
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url, payload: { content: 'x' } })).statusCode).toBe(401);
  });

  it('评论: concurrent edits each get their own, increasing revision', async () => {
    const task = await createTask(alice, '并发编辑');
    const created = commentSchema.parse(
      (await t.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/comments`, headers: alice.headers, payload: { content: 'v0' } })).json(),
    );
    const edits = await Promise.all(
      ['v1', 'v2', 'v3'].map((content) =>
        t.app.inject({ method: 'PATCH', url: `/api/comments/${created.id}`, headers: alice.headers, payload: { content } }),
      ),
    );
    const revisions = edits.map((r) => commentSchema.parse(r.json()).revision);
    expect(new Set(revisions).size).toBe(3);
    for (const r of revisions) expect(r).toBeGreaterThan(created.revision);
  });
});
