import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { attachmentSchema, commentSchema, taskSchema, type Task } from '@dida/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { attachments, comments } from '../../src/db/schema/attachments.js';
import { tasks } from '../../src/db/schema/tasks.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * Review cases for EURO-32: the startup cleanup only touches purged tasks,
 * the file sweep stays inside the owner's directory, and the new tree lock on
 * 评论 / 附件 creation neither deadlocks nor changes the answers.
 */

describe('回收站清理附件与评论（审查补充）', () => {
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

  function api(user: TestUser, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  async function createTask(user: TestUser, payload: object): Promise<Task> {
    const res = await api(user, 'POST', '/api/tasks', payload);
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  function uploadRaw(user: TestUser, taskId: string, name: string, body: string) {
    return t.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/attachments?name=${encodeURIComponent(name)}`,
      headers: { ...user.headers, 'content-type': 'text/plain' },
      payload: Buffer.from(body),
    });
  }

  async function upload(user: TestUser, taskId: string, name: string, body: string) {
    const res = await uploadRaw(user, taskId, name, body);
    expect(res.statusCode, res.body).toBe(201);
    return attachmentSchema.parse(res.json());
  }

  async function comment(user: TestUser, taskId: string, content: string) {
    const res = await api(user, 'POST', `/api/tasks/${taskId}/comments`, { content });
    expect(res.statusCode, res.body).toBe(201);
    return commentSchema.parse(res.json());
  }

  const attachmentsDir = () => path.join(t.config.dataDir, 'attachments');
  const fileOf = (user: TestUser, id: string) => path.join(attachmentsDir(), user.id, id);
  const exists = (file: string) =>
    access(file).then(
      () => true,
      () => false,
    );

  it('cleanUpPurged() leaves tasks that are only in the 回收站 (not purged) alone; 还原 still finds everything', async () => {
    const task = await createTask(alice, { title: '仅在回收站' });
    const file = await upload(alice, task.id, '回收站里的附件.txt', 'x');
    const note = await comment(alice, task.id, '回收站里的评论');
    expect((await api(alice, 'DELETE', `/api/tasks/${task.id}`)).statusCode).toBe(204);

    expect(await t.app.trash.cleanUpPurged()).toBe(0);
    await t.app.trash.purgeExpired();

    expect(await exists(fileOf(alice, file.id))).toBe(true);
    const [att] = await t.database.db.select().from(attachments).where(eq(attachments.id, file.id));
    expect(att?.deletedAt).toBeNull();
    expect(att?.fileName).toBe('回收站里的附件.txt');
    const [c] = await t.database.db.select().from(comments).where(eq(comments.id, note.id));
    expect(c?.deletedAt).toBeNull();
    expect(c?.content).toBe('回收站里的评论');

    expect((await api(alice, 'POST', `/api/trash/${task.id}/restore`)).statusCode).toBe(200);
    const content = await api(alice, 'GET', `/api/attachments/${file.id}/content`);
    expect(content.statusCode).toBe(200);
    expect(content.body).toBe('x');
  });

  it("the file sweep only deletes the owner's file: same id in another user's directory, non-UUID names and files outside stay", async () => {
    const task = await createTask(alice, { title: '隔离' });
    const file = await upload(alice, task.id, 'a.txt', 'a');
    // Planted files the sweep must not touch.
    const bobDir = path.join(attachmentsDir(), bob.id);
    await mkdir(bobDir, { recursive: true });
    const sameIdInBobDir = path.join(bobDir, file.id);
    await writeFile(sameIdInBobDir, 'bob');
    const nonUuid = path.join(attachmentsDir(), alice.id, 'notes.txt');
    await writeFile(nonUuid, 'keep');
    const outside = path.join(t.config.dataDir, file.id);
    await writeFile(outside, 'keep');

    await api(alice, 'DELETE', `/api/tasks/${task.id}`);
    expect((await api(alice, 'DELETE', `/api/trash/${task.id}`)).statusCode).toBe(204);
    await t.app.trash.purgeExpired();
    await t.app.trash.cleanUpPurged();

    expect(await exists(fileOf(alice, file.id))).toBe(false);
    expect(await exists(sameIdInBobDir)).toBe(true);
    expect(await exists(nonUuid)).toBe(true);
    expect(await exists(outside)).toBe(true);
  });

  it('评论 / 附件 on a task in the 回收站 still answer 404, and the upload leaves no file behind', async () => {
    const task = await createTask(alice, { title: '已删除' });
    await api(alice, 'DELETE', `/api/tasks/${task.id}`);
    expect((await api(alice, 'POST', `/api/tasks/${task.id}/comments`, { content: 'x' })).statusCode).toBe(404);
    const id = crypto.randomUUID();
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/attachments?name=a.txt&id=${id}`,
      headers: { ...alice.headers, 'content-type': 'text/plain' },
      payload: Buffer.from('a'),
    });
    expect(res.statusCode).toBe(404);
    expect(await exists(fileOf(alice, id))).toBe(false);
    // Another user's task: 404 too.
    const bobTask = await createTask(bob, { title: 'bob' });
    expect((await api(alice, 'POST', `/api/tasks/${bobTask.id}/comments`, { content: 'x' })).statusCode).toBe(404);
    expect((await uploadRaw(alice, bobTask.id, 'a.txt', 'a')).statusCode).toBe(404);
  });

  it('concurrent 评论 / 附件 creation and 彻底删除 neither deadlock nor leave live content on the purged task', async () => {
    for (let round = 0; round < 5; round += 1) {
      const task = await createTask(alice, { title: `并发${round}` });
      await comment(alice, task.id, `并发前${round}`);
      await api(alice, 'DELETE', `/api/tasks/${task.id}`);
      const restore = await api(alice, 'POST', `/api/trash/${task.id}/restore`);
      expect(restore.statusCode).toBe(200);
      // Delete + purge racing with creations; creations either land before (then get cleared) or answer 404.
      const writes = [
        ...Array.from({ length: 4 }, (_, i) => api(alice, 'POST', `/api/tasks/${task.id}/comments`, { content: `并发评论${round}-${i}` })),
        ...Array.from({ length: 3 }, (_, i) => uploadRaw(alice, task.id, `并发${round}-${i}.txt`, 'z')),
        (async () => {
          await api(alice, 'DELETE', `/api/tasks/${task.id}`);
          return api(alice, 'DELETE', `/api/trash/${task.id}`);
        })(),
      ];
      const results = await Promise.all(writes);
      for (const r of results) expect([201, 204, 404]).toContain(r.statusCode);
      // A creation that slipped in after the purge's commit would be live on a purged task; none may.
      const [row] = await t.database.db.select().from(tasks).where(eq(tasks.id, task.id));
      expect(row?.purgedAt).not.toBeNull();
      const liveComments = await t.database.db.select().from(comments).where(inArray(comments.taskId, [task.id]));
      expect(liveComments.filter((c) => c.deletedAt === null || c.content !== '')).toEqual([]);
      const liveFiles = await t.database.db.select().from(attachments).where(inArray(attachments.taskId, [task.id]));
      expect(liveFiles.filter((a) => a.deletedAt === null || a.fileName !== '')).toEqual([]);
      for (const a of liveFiles) expect(await exists(fileOf(alice, a.id))).toBe(false);
    }
  }, 30_000);
});
