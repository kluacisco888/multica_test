import { randomBytes, randomUUID } from 'node:crypto';
import {
  ATTACHMENT_MAX_BYTES,
  attachmentSchema,
  attachmentsResponseSchema,
  changesResponseSchema,
  taskSchema,
  type Attachment,
  type Task,
} from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* 附件 (spec 用户故事 38): 50MB limit, owner-only download, preview types, ADR-0004 sync. */

describe('附件 API', () => {
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

  async function createTask(user: TestUser, title = '交报销'): Promise<Task> {
    const res = await t.app.inject({ method: 'POST', url: '/api/tasks', headers: user.headers, payload: { title } });
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  function upload(user: TestUser, taskId: string, name: string, body: Buffer, contentType = 'application/octet-stream', extra = '') {
    return t.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/attachments?name=${encodeURIComponent(name)}${extra}`,
      headers: { ...user.headers, 'content-type': contentType },
      payload: body,
    });
  }

  async function uploaded(user: TestUser, taskId: string, name: string, body: Buffer, contentType?: string): Promise<Attachment> {
    const res = await upload(user, taskId, name, body, contentType);
    expect(res.statusCode, res.body).toBe(201);
    return attachmentSchema.parse(res.json());
  }

  function download(user: TestUser, id: string, query = '') {
    return t.app.inject({ method: 'GET', url: `/api/attachments/${id}/content${query}`, headers: user.headers });
  }

  async function listOf(user: TestUser, taskId: string): Promise<Attachment[]> {
    const res = await t.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/attachments`, headers: user.headers });
    expect(res.statusCode, res.body).toBe(200);
    return attachmentsResponseSchema.parse(res.json()).attachments;
  }

  it('uploads a file to a 任务 and downloads exactly the same bytes', async () => {
    const task = await createTask(alice);
    const bytes = randomBytes(300_000);
    const attachment = await uploaded(alice, task.id, '发票 2026-10.pdf', bytes, 'application/pdf');
    expect(attachment).toMatchObject({
      taskId: task.id,
      fileName: '发票 2026-10.pdf',
      mimeType: 'application/pdf',
      size: bytes.length,
      preview: 'pdf',
      createdAt: '2026-10-13T02:00:00.000Z',
    });

    const res = await download(alice, attachment.id);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Previewable types open in the browser; the UTF-8 name survives.
    expect(res.headers['content-disposition']).toBe(`inline; filename*=UTF-8''${encodeURIComponent('发票 2026-10.pdf')}`);

    const forced = await download(alice, attachment.id, '?download=1');
    expect(forced.headers['content-disposition']).toMatch(/^attachment; /);

    expect(await listOf(alice, task.id)).toEqual([attachment]);
  });

  it('accepts a file of exactly 50MB and rejects one byte more with 413', async () => {
    const task = await createTask(alice, '大文件');
    const limit = Buffer.alloc(ATTACHMENT_MAX_BYTES, 1);
    const ok = await uploaded(alice, task.id, 'limit.bin', limit);
    expect(ok.size).toBe(ATTACHMENT_MAX_BYTES);

    const tooBig = await upload(alice, task.id, 'too-big.bin', Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 1));
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json()).toEqual({ error: { code: 'file_too_large', message: '单个附件不能超过 50MB' } });
    expect((await listOf(alice, task.id)).map((a) => a.fileName)).toEqual(['limit.bin']);
  });

  it('rejects an oversized body even without a Content-Length header (chunked upload)', async () => {
    const task = await createTask(alice, '分块上传');
    const { Readable } = await import('node:stream');
    const chunk = Buffer.alloc(1024 * 1024, 2);
    let sent = 0;
    const body = new Readable({
      read() {
        if (sent > ATTACHMENT_MAX_BYTES) return this.push(null);
        sent += chunk.length;
        this.push(chunk);
      },
    });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/attachments?name=stream.bin`,
      headers: { ...alice.headers, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
      payload: body,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('file_too_large');
    expect(await listOf(alice, task.id)).toEqual([]);
  });

  it('answers 413 over a real HTTP connection too (the browser sees the error, not a reset)', async () => {
    const task = await createTask(alice, '真实连接');
    const address = await t.app.listen({ host: '127.0.0.1', port: 0 });
    for (const body of [new Uint8Array(ATTACHMENT_MAX_BYTES + 1), new Uint8Array(1024)]) {
      const res = await fetch(`${address}/api/tasks/${task.id}/attachments?name=net.bin`, {
        method: 'POST',
        headers: { ...alice.headers, 'content-type': 'application/octet-stream' },
        body,
      });
      expect(res.status).toBe(body.length > ATTACHMENT_MAX_BYTES ? 413 : 201);
      await res.arrayBuffer();
    }
    expect((await listOf(alice, task.id)).map((a) => a.size)).toEqual([1024]);
  });

  it("does not let another user download, list, upload to or delete someone's 附件 (404 like a missing id)", async () => {
    const task = await createTask(alice, '私密');
    const attachment = await uploaded(alice, task.id, 'secret.png', Buffer.from('png-bytes'), 'image/png');

    const foreign = await download(bob, attachment.id);
    const missing = await download(bob, randomUUID());
    const malformed = await download(bob, 'not-a-uuid');
    for (const res of [foreign, missing, malformed]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'not_found', message: '资源不存在' } });
    }
    const forcedForeign = await download(bob, attachment.id, '?download=1');
    expect(forcedForeign.statusCode).toBe(404);

    const list = await t.app.inject({ method: 'GET', url: `/api/tasks/${task.id}/attachments`, headers: bob.headers });
    expect(list.statusCode).toBe(404);
    expect((await upload(bob, task.id, 'x.txt', Buffer.from('x'))).statusCode).toBe(404);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/attachments/${attachment.id}`, headers: bob.headers });
    expect(del.statusCode).toBe(404);

    // Without a session at all: 401.
    const anonymous = await t.app.inject({ method: 'GET', url: `/api/attachments/${attachment.id}/content` });
    expect(anonymous.statusCode).toBe(401);

    // Still there for the owner.
    expect((await download(alice, attachment.id)).rawPayload.toString()).toBe('png-bytes');
  });

  it('only previews safe image types and PDF; everything else is a download served as octet-stream', async () => {
    const task = await createTask(alice, '类型');
    const png = await uploaded(alice, task.id, 'a.png', Buffer.from('p'), 'image/png');
    const svg = await uploaded(alice, task.id, 'b.svg', Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml');
    const html = await uploaded(alice, task.id, 'c.html', Buffer.from('<script>alert(1)</script>'), 'text/html; charset=utf-8');
    expect([png.preview, svg.preview, html.preview]).toEqual(['image', null, null]);
    expect(html.mimeType).toBe('text/html');

    const pngRes = await download(alice, png.id);
    expect(pngRes.headers['content-type']).toBe('image/png');
    expect(pngRes.headers['content-disposition']).toMatch(/^inline; /);
    for (const a of [svg, html]) {
      const res = await download(alice, a.id);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toMatch(/^attachment; /);
    }
  });

  it('validates the file name and refuses 附件 on a missing 任务', async () => {
    const task = await createTask(alice, '校验');
    for (const name of ['', '../etc/passwd', 'a\\b', 'x'.repeat(256)]) {
      const res = await upload(alice, task.id, name, Buffer.from('x'));
      expect(res.statusCode, name).toBe(400);
    }
    expect((await upload(alice, randomUUID(), 'a.txt', Buffer.from('x'))).statusCode).toBe(404);
    expect(await listOf(alice, task.id)).toEqual([]);
  });

  it('takes a client-generated id and answers 409 when it is already used', async () => {
    const task = await createTask(alice, '客户端 id');
    const id = randomUUID();
    const res = await upload(alice, task.id, 'a.txt', Buffer.from('a'), 'text/plain', `&id=${id}`);
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe(id);
    const again = await upload(alice, task.id, 'b.txt', Buffer.from('b'), 'text/plain', `&id=${id}`);
    expect(again.statusCode).toBe(409);
    expect((await download(alice, id)).rawPayload.toString()).toBe('a');
  });

  it('a deleted 任务 takes its 附件 with it: download and list answer 404', async () => {
    const list = await t.app.inject({ method: 'POST', url: '/api/lists', headers: alice.headers, payload: { name: '要删的清单' } });
    expect(list.statusCode, list.body).toBe(201);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: alice.headers,
      payload: { title: '随清单删除', listId: list.json().id },
    });
    const task = taskSchema.parse(res.json());
    const attachment = await uploaded(alice, task.id, 'gone.png', Buffer.from('png'), 'image/png');
    expect((await download(alice, attachment.id)).statusCode).toBe(200);

    // Deleting the 清单 soft-deletes its 任务 (the only way to delete a 任务 for now).
    const del = await t.app.inject({ method: 'DELETE', url: `/api/lists/${list.json().id}`, headers: alice.headers });
    expect(del.statusCode).toBe(204);
    for (const query of ['', '?download=1']) {
      const gone = await download(alice, attachment.id, query);
      expect(gone.statusCode).toBe(404);
      expect(gone.json()).toEqual({ error: { code: 'not_found', message: '资源不存在' } });
    }
    const listed = await t.app.inject({ method: 'GET', url: `/api/tasks/${task.id}/attachments`, headers: alice.headers });
    expect(listed.statusCode).toBe(404);
    expect((await upload(alice, task.id, 'late.txt', Buffer.from('x'))).statusCode).toBe(404);
  });

  it('deletes softly: the file is gone, a tombstone with a new revision stays in /api/changes', async () => {
    const task = await createTask(alice, '删除');
    const before = changesResponseSchema.parse(
      (await t.app.inject({ method: 'GET', url: '/api/changes?since=0', headers: alice.headers })).json(),
    ).revision;
    const attachment = await uploaded(alice, task.id, 'old.txt', Buffer.from('old'), 'text/plain');

    const changes = changesResponseSchema.parse(
      (await t.app.inject({ method: 'GET', url: `/api/changes?since=${before}`, headers: alice.headers })).json(),
    );
    expect(changes.entities.attachment?.upserts).toEqual([expect.objectContaining({ id: attachment.id, fileName: 'old.txt' })]);

    clock.advance(60_000);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/attachments/${attachment.id}`, headers: alice.headers });
    expect(del.statusCode).toBe(204);
    expect((await download(alice, attachment.id)).statusCode).toBe(404);
    expect(await listOf(alice, task.id)).toEqual([]);

    const after = changesResponseSchema.parse(
      (await t.app.inject({ method: 'GET', url: `/api/changes?since=${changes.revision}`, headers: alice.headers })).json(),
    );
    expect(after.entities.attachment?.upserts).toEqual([]);
    expect(after.entities.attachment?.tombstones).toEqual([
      { id: attachment.id, revision: after.revision, deletedAt: '2026-10-13T02:01:00.000Z' },
    ]);
    const again = await t.app.inject({ method: 'DELETE', url: `/api/attachments/${attachment.id}`, headers: alice.headers });
    expect(again.statusCode).toBe(404);
  });
});
