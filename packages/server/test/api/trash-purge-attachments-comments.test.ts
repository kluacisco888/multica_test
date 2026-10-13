import { access } from 'node:fs/promises';
import path from 'node:path';
import { attachmentSchema, changesResponseSchema, commentSchema, taskSchema, type Task } from '@dida/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { attachments, comments } from '../../src/db/schema/attachments.js';
import { tasks } from '../../src/db/schema/tasks.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 彻底删除 and the 30-day cleanup also clear a 任务's 附件 and 评论 (EURO-32,
 * ADR-0004: only tombstones stay). Files go after the commit; a failed file
 * delete is retried by the next cleanup; leftovers of earlier purges are
 * cleaned up by `cleanUpPurged()` (run at startup).
 */

const DAY = 24 * 60 * 60 * 1000;

describe('回收站清理附件与评论', () => {
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

  async function upload(user: TestUser, taskId: string, name: string, body: string) {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/attachments?name=${encodeURIComponent(name)}`,
      headers: { ...user.headers, 'content-type': 'text/plain' },
      payload: Buffer.from(body),
    });
    expect(res.statusCode, res.body).toBe(201);
    return attachmentSchema.parse(res.json());
  }

  async function comment(user: TestUser, taskId: string, content: string) {
    const res = await api(user, 'POST', `/api/tasks/${taskId}/comments`, { content });
    expect(res.statusCode, res.body).toBe(201);
    return commentSchema.parse(res.json());
  }

  function fileOf(user: TestUser, attachmentId: string) {
    return path.join(t.config.dataDir, 'attachments', user.id, attachmentId);
  }

  async function exists(file: string) {
    return access(file).then(
      () => true,
      () => false,
    );
  }

  async function changes(user: TestUser) {
    const res = await api(user, 'GET', '/api/changes?since=0');
    expect(res.statusCode, res.body).toBe(200);
    return changesResponseSchema.parse(res.json());
  }

  /** A 任务 with a 子任务, each with a 附件 and a 评论, plus one 评论 / 附件 the user deleted earlier. */
  async function taskWithExtras(user: TestUser, tag: string) {
    const task = await createTask(user, { title: `${tag} 任务` });
    const child = await createTask(user, { title: `${tag} 子任务`, parentId: task.id });
    const files = [await upload(user, task.id, `${tag}-合同.txt`, 'a'), await upload(user, child.id, `${tag}-子附件.txt`, 'b')];
    const notes = [await comment(user, task.id, `${tag} 评论原文`), await comment(user, child.id, `${tag} 子任务评论`)];
    const earlierNote = await comment(user, task.id, `${tag} 早删的评论`);
    expect((await api(user, 'DELETE', `/api/comments/${earlierNote.id}`)).statusCode).toBe(204);
    const earlierFile = await upload(user, task.id, `${tag}-早删的附件.txt`, 'c');
    expect((await api(user, 'DELETE', `/api/attachments/${earlierFile.id}`)).statusCode).toBe(204);
    return {
      task,
      child,
      files,
      attachmentIds: [...files.map((f) => f.id), earlierFile.id],
      commentIds: [...notes.map((c) => c.id), earlierNote.id],
    };
  }

  async function expectCleared(user: TestUser, tag: string, data: { attachmentIds: string[]; commentIds: string[] }) {
    // Database: tombstones only, content cleared.
    const attRows = await t.database.db.select().from(attachments).where(inArray(attachments.id, data.attachmentIds));
    expect(attRows).toHaveLength(data.attachmentIds.length);
    expect(attRows.every((r) => r.deletedAt !== null && r.fileName === '')).toBe(true);
    const commentRows = await t.database.db.select().from(comments).where(inArray(comments.id, data.commentIds));
    expect(commentRows).toHaveLength(data.commentIds.length);
    expect(commentRows.every((r) => r.deletedAt !== null && r.content === '')).toBe(true);
    // Files: gone from DATA_DIR/attachments.
    for (const id of data.attachmentIds) expect(await exists(fileOf(user, id)), id).toBe(false);
    // Sync feed: tombstones only, no 评论 text, no file names.
    const feed = await changes(user);
    expect(feed.entities.attachment?.upserts.some((x) => data.attachmentIds.includes(x.id))).toBe(false);
    expect(feed.entities.attachment?.tombstones.map((x) => x.id)).toEqual(expect.arrayContaining(data.attachmentIds));
    expect(feed.entities.comment?.tombstones.map((x) => x.id)).toEqual(expect.arrayContaining(data.commentIds));
    expect(feed.entities.comment?.upserts.some((x) => data.commentIds.includes(x.id))).toBe(false);
    expect(JSON.stringify(feed)).not.toContain(tag);
  }

  it('彻底删除 tombstones the 附件 and 评论, clears their content and deletes the files', async () => {
    const data = await taskWithExtras(alice, '彻删A');
    // Before: the files are there and the live 评论 shows up in the feed.
    for (const f of data.files) expect(await exists(fileOf(alice, f.id))).toBe(true);
    await api(alice, 'DELETE', `/api/tasks/${data.task.id}`);
    expect(JSON.stringify(await changes(alice))).toContain('彻删A 评论原文');

    const res = await api(alice, 'DELETE', `/api/trash/${data.task.id}`);
    expect(res.statusCode, res.body).toBe(204);
    await expectCleared(alice, '彻删A', data);
  });

  it('清空回收站 does the same', async () => {
    const data = await taskWithExtras(alice, '清空B');
    await api(alice, 'DELETE', `/api/tasks/${data.task.id}`);
    expect((await api(alice, 'DELETE', '/api/trash')).statusCode).toBe(204);
    await expectCleared(alice, '清空B', data);
  });

  it("the 30-day cleanup (injected clock) does the same, and leaves other users' 附件 alone", async () => {
    const data = await taskWithExtras(alice, '过期C');
    const bobTask = await createTask(bob, { title: 'bob 的任务' });
    const bobFile = await upload(bob, bobTask.id, 'bob-文件.txt', 'bob');
    const bobNote = await comment(bob, bobTask.id, 'bob 的评论');
    await api(alice, 'DELETE', `/api/tasks/${data.task.id}`);

    clock.advance(30 * DAY - 1);
    expect(await t.app.trash.purgeExpired()).toBe(0);
    for (const f of data.files) expect(await exists(fileOf(alice, f.id))).toBe(true);

    clock.advance(1);
    expect(await t.app.trash.purgeExpired()).toBe(1);
    // 30 days unused also ended the sessions.
    for (const user of [alice, bob]) user.headers = (await t.login(user.username, user.password)).headers;
    await expectCleared(alice, '过期C', data);

    expect(await exists(fileOf(bob, bobFile.id))).toBe(true);
    const bobFeed = await changes(bob);
    expect(bobFeed.entities.attachment?.upserts.map((x) => x.id)).toEqual([bobFile.id]);
    expect(bobFeed.entities.comment?.upserts.map((x) => x.id)).toEqual([bobNote.id]);
  });

  it('还原 keeps the 附件 and 评论 (only purging clears them)', async () => {
    const data = await taskWithExtras(alice, '还原D');
    await api(alice, 'DELETE', `/api/tasks/${data.task.id}`);
    expect((await api(alice, 'POST', `/api/trash/${data.task.id}/restore`)).statusCode).toBe(200);
    for (const f of data.files) expect(await exists(fileOf(alice, f.id))).toBe(true);
    const list = await api(alice, 'GET', `/api/tasks/${data.task.id}/comments`);
    expect(list.json().comments.map((c: { content: string }) => c.content)).toEqual(['还原D 评论原文']);
  });

  it('a failed file delete does not roll back the purge; the next cleanup retries it', async () => {
    const data = await taskWithExtras(alice, '重试E');
    await api(alice, 'DELETE', `/api/tasks/${data.task.id}`);
    const remove = vi.spyOn(t.app.attachmentStore, 'remove').mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }));
    try {
      const res = await api(alice, 'DELETE', `/api/trash/${data.task.id}`);
      expect(res.statusCode, res.body).toBe(204);
      expect(remove).toHaveBeenCalled();
    } finally {
      remove.mockRestore();
    }
    // The purge is committed: task and extras are tombstones without content …
    const [taskRow] = await t.database.db.select().from(tasks).where(eq(tasks.id, data.task.id));
    expect(taskRow?.purgedAt).not.toBeNull();
    expect(JSON.stringify(await changes(alice))).not.toContain('重试E');
    // … but the files are still on disk, waiting for the next run.
    for (const f of data.files) expect(await exists(fileOf(alice, f.id))).toBe(true);

    // Next cleanup run (nothing expired): the leftover files go.
    expect(await t.app.trash.purgeExpired()).toBe(0);
    await expectCleared(alice, '重试E', data);
  });

  it('cleanUpPurged() clears 附件 and 评论 left behind by earlier purges, and is idempotent', async () => {
    const data = await taskWithExtras(alice, '历史F');
    const keep = await createTask(alice, { title: '活着的任务' });
    const keptFile = await upload(alice, keep.id, '保留.txt', 'keep');
    const keptNote = await comment(alice, keep.id, '保留的评论');
    // What a purge before EURO-32 left: tasks purged, 附件 / 评论 untouched.
    await t.database.db
      .update(tasks)
      .set({ title: '', description: '', deletedAt: clock.now(), purgedAt: clock.now(), trashRootId: null })
      .where(inArray(tasks.id, [data.task.id, data.child.id]));
    expect(JSON.stringify(await changes(alice))).toContain('历史F 评论原文');

    expect(await t.app.trash.cleanUpPurged()).toBe(data.attachmentIds.length + data.commentIds.length);
    await expectCleared(alice, '历史F', data);
    // Running again finds nothing; live data is untouched.
    expect(await t.app.trash.cleanUpPurged()).toBe(0);
    expect(await exists(fileOf(alice, keptFile.id))).toBe(true);
    const feed = await changes(alice);
    expect(feed.entities.attachment?.upserts.map((x) => x.id)).toContain(keptFile.id);
    expect(feed.entities.comment?.upserts.map((x) => x.id)).toContain(keptNote.id);
  });
});
