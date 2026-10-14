import { randomUUID } from 'node:crypto';
import type { BackupDocument, BackupRecord } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 审查补充 (EURO-30 review): edge cases of the JSON import that the PR's own
 * tests do not cover — data that only passes the column-type checks, foreign
 * ids hidden in JSON columns, concurrent imports, and unusual id spellings.
 */

describe('导入导出（审查补充）', () => {
  const clock = fixedClock('2026-10-14T02:00:00.000Z');
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await createTestApp({ clock });
  });
  afterAll(() => t.close());

  const api = (u: TestUser, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: u.headers, ...(payload ? { payload } : {}) });
  const user = async (p: string) => t.createUser(`${p}${++n}`);
  const exportOf = async (u: TestUser) => (await api(u, 'GET', '/api/backup/export')).json() as BackupDocument;
  const importInto = (u: TestUser, doc: unknown) => api(u, 'POST', '/api/backup/import', doc as object);
  const recs = (d: BackupDocument, type: keyof BackupDocument['entities']) => (d.entities[type] ??= []) as BackupRecord[];

  /** A small account: 收件箱, one 清单, one 任务 with a reminder (one scheduled delivery). */
  async function small(): Promise<{ u: TestUser; doc: BackupDocument; listId: string }> {
    const u = await user('small');
    await api(u, 'GET', '/api/lists');
    const list = (await api(u, 'POST', '/api/lists', { name: '项目' })).json() as { id: string };
    const res = await api(u, 'POST', '/api/tasks', {
      listId: list.id,
      title: '提醒我',
      dates: { allDay: false, dueAt: '2026-10-15T07:00:00.000Z', startAt: null },
      reminders: [{ type: 'before', minutes: 30 }],
    });
    expect(res.statusCode, res.body).toBe(201);
    await api(u, 'POST', '/api/filters', { name: 'f', rules: { listIds: [list.id] } });
    await api(u, 'PATCH', '/api/settings', { themeMode: 'dark' });
    return { u, doc: await exportOf(u), listId: list.id };
  }

  it('foreign ids inside a JSON column (过滤器 rules) do not reveal another user’s tasks', async () => {
    const other = await user('victim');
    const theirs = (await api(other, 'POST', '/api/lists', { name: '机密清单' })).json() as { id: string };
    await api(other, 'POST', '/api/tasks', { listId: theirs.id, title: '别人的机密任务' });

    const { doc } = await small();
    (recs(doc, 'filter')[0] as BackupRecord).rules = { listIds: [theirs.id] };
    const target = await user('attacker');
    const res = await importInto(target, doc);
    // Either refused, or imported without access to the other user's data.
    if (res.statusCode === 200) {
      const filters = (await api(target, 'GET', '/api/filters')).json() as { filters: { id: string }[] };
      const tasks = await api(target, 'GET', `/api/tasks?filterId=${filters.filters[0]?.id}`);
      expect(tasks.body).not.toContain('别人的机密任务');
    } else {
      expect(res.statusCode).toBe(400);
    }
  });

  it('upper-case ids in the file are remapped like lower-case ones', async () => {
    const { doc } = await small();
    for (const records of Object.values(doc.entities)) {
      for (const r of records) for (const [k, v] of Object.entries(r)) if (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v)) r[k] = v.toUpperCase();
    }
    const target = await user('upper');
    const res = await importInto(target, doc);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('two concurrent imports into a user without a 收件箱 leave one live 收件箱', async () => {
    const { doc } = await small();
    const target = await user('race'); // never opened the app: no 收件箱 yet
    const [a, b] = await Promise.all([importInto(target, doc), importInto(target, doc)]);
    const lists = (await api(target, 'GET', '/api/lists')).json() as { lists: { isInbox: boolean }[] };
    expect({ a: a.statusCode, b: b.statusCode, inboxes: lists.lists.filter((l) => l.isInbox).length }).toMatchObject({ inboxes: 1 });
  });

  it('server-owned rows with a malformed JSON column (提醒投递记录 channels) are refused or do not stall the reminder job', async () => {
    const victim = await user('bystander');
    await api(victim, 'POST', '/api/notification-channels', { type: 'feishu', name: 'v', isDefault: true, config: { webhookUrl: 'http://127.0.0.1:9/hook' } });
    const due = await api(victim, 'POST', '/api/tasks', { title: '别人的提醒', dates: { allDay: false, dueAt: '2026-10-14T02:05:00.000Z', startAt: null }, reminders: [{ type: 'before', minutes: 0 }] });
    expect(due.statusCode, due.body).toBe(201);
    const { doc } = await small();
    // Exports no longer carry 提醒投递记录; a file that does (hand-made here) must not poison the job.
    const task = recs(doc, 'task')[0] as BackupRecord;
    const now = clock.now();
    (doc.entities as Record<string, unknown[]>).reminderDelivery = Array.from({ length: 120 }, () => ({
      id: randomUUID(),
      taskId: task.id,
      countdownId: null,
      source: 'rule',
      reminderKey: 'before:30',
      fireAt: new Date(now.getTime() - 60_000).toISOString(),
      status: 'delivering',
      firedAt: null,
      nextAttemptAt: new Date(now.getTime() - 60_000).toISOString(), // also '1970-01-01T00:00:00Z' works: it always sorts first
      channels: { not: 'an array' },
      alertDismissedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      deletedAt: null,
    }));
    const target = await user('poison');
    const res = await importInto(target, doc);
    if (res.statusCode !== 200) return; // refused: fine
    clock.advance(10 * 60_000); // the bystander's reminder is due now
    const outcome = await Promise.race([
      t.app.reminders.tick().then(() => 'finished'),
      new Promise((resolve) => setTimeout(() => resolve('still running after 10s'), 10_000)),
    ]);
    clock.set('2026-10-14T02:00:00.000Z');
    expect(outcome).toBe('finished');
  }, 20_000);

  it('a 设置 time zone that is not a time zone is refused or leaves the account usable', async () => {
    const { doc } = await small();
    (recs(doc, 'settings')[0] as BackupRecord).timeZone = 'Not/A_Zone';
    const target = await user('tz');
    const res = await importInto(target, doc);
    if (res.statusCode !== 200) return;
    const statuses = {
      export: (await api(target, 'GET', '/api/backup/export')).statusCode,
      csv: (await api(target, 'GET', '/api/backup/tasks.csv')).statusCode,
      tasks: (await api(target, 'GET', '/api/tasks?smart=today')).statusCode,
      settings: (await api(target, 'GET', '/api/settings')).statusCode,
    };
    expect(statuses).toEqual({ export: 200, csv: 200, tasks: 200, settings: 200 });
  });

  it('a 任务 repeat rule the API would refuse is refused or leaves the account usable', async () => {
    const { doc } = await small();
    Object.assign(recs(doc, 'task')[0] as BackupRecord, { repeat: { freq: 'bogus' }, reminders: [{ type: 'nonsense' }] });
    const target = await user('rule');
    const res = await importInto(target, doc);
    if (res.statusCode !== 200) return;
    const statuses = {
      csv: (await api(target, 'GET', '/api/backup/tasks.csv')).statusCode,
      lists: (await api(target, 'GET', '/api/lists')).statusCode,
      tasks: (await api(target, 'GET', '/api/tasks?smart=week')).statusCode,
    };
    expect(statuses).toEqual({ csv: 200, lists: 200, tasks: 200 });
  });

  it('empty and huge edge inputs', async () => {
    const target = await user('edge');
    expect((await importInto(target, {})).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/backup/import', headers: { ...target.headers, 'content-type': 'application/json' }, payload: 'not json' })).statusCode).toBe(400);
    const empty = await importInto(target, { format: 'dida-clone-backup', version: 1, exportedAt: '', entities: {} });
    expect(empty.statusCode, empty.body).toBe(200);
    const title = 'x'.repeat(2_000_000);
    const { doc } = await small();
    (recs(doc, 'task')[0] as BackupRecord).title = title;
    const res = await importInto(target, doc);
    // The API caps titles; the import should too.
    expect(res.statusCode, 'a 2MB title is imported as is').toBe(400);
  });
});

describe('导出大小估算（审查补充，第 2 轮）', () => {
  it('a deleted 附件 (file removed) no longer counts towards the export size', async () => {
    const t = await createTestApp({ backupMaxBytes: 64 * 1024 });
    try {
      const u = await t.createUser('est1');
      const task = (await t.app.inject({ method: 'POST', url: '/api/tasks', headers: u.headers, payload: { title: 'f' } })).json() as { id: string };
      const upload = async () =>
        (
          await t.app.inject({
            method: 'POST',
            url: `/api/tasks/${task.id}/attachments?name=a.bin`,
            headers: { ...u.headers, 'content-type': 'application/octet-stream' },
            payload: Buffer.alloc(40 * 1024, 1),
          })
        ).json() as { id: string };
      const first = await upload();
      await upload();
      expect((await t.app.inject({ method: 'GET', url: '/api/backup/export', headers: u.headers })).statusCode).toBe(413);
      // The error message says to delete some 附件; doing so must make the export possible.
      expect((await t.app.inject({ method: 'DELETE', url: `/api/attachments/${first.id}`, headers: u.headers })).statusCode).toBe(204);
      const res = await t.app.inject({ method: 'GET', url: '/api/backup/export', headers: u.headers });
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await t.close();
    }
  });
});
