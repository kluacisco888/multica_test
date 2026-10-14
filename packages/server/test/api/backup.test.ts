import { randomUUID } from 'node:crypto';
import { describeImportIssue, importIssueSchema, type BackupDocument, type BackupRecord, type ImportIssue } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 导入导出 (spec 用户故事 110–112, EURO-30): the JSON backup holds the whole
 * account and restores it into a new user record by record; an import that
 * fails names the record and leaves nothing behind; 任务 export as CSV.
 */

describe('导入导出', () => {
  const clock = fixedClock('2026-10-14T02:00:00.000Z');
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await createTestApp({ clock });
  });
  afterAll(() => t.close());

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  async function ok<T = { id: string }>(user: TestUser, method: 'POST' | 'PATCH' | 'PUT', url: string, payload: object): Promise<T> {
    const res = await api(user, method, url, payload);
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
    return res.json() as T;
  }

  async function user(prefix: string): Promise<TestUser> {
    n += 1;
    return t.createUser(`${prefix}${n}`);
  }

  async function exportOf(u: TestUser): Promise<BackupDocument> {
    const res = await api(u, 'GET', '/api/backup/export');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="dida-clone-backup-\d{8}\.json"/);
    return res.json() as BackupDocument;
  }

  function importInto(u: TestUser, doc: unknown) {
    return t.app.inject({ method: 'POST', url: '/api/backup/import', headers: u.headers, payload: doc as object });
  }

  /** An account using every kind of data the app has. */
  async function richAccount(): Promise<TestUser> {
    const u = await user('rich');
    await api(u, 'GET', '/api/lists'); // creates the 收件箱
    const channel = await ok(u, 'POST', '/api/notification-channels', {
      type: 'feishu',
      name: '飞书',
      isDefault: true,
      config: { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc-secret-token', secret: 'sign-secret-123456' },
    });
    const folder = await ok(u, 'POST', '/api/folders', { name: '工作' });
    const list = await ok(u, 'POST', '/api/lists', { name: '项目', color: '#ff6161', icon: '📁', folderId: folder.id });
    const archived = await ok(u, 'POST', '/api/lists', { name: '旧项目' });
    await ok(u, 'PATCH', `/api/lists/${archived.id}`, { archived: true });
    const parentTag = await ok(u, 'POST', '/api/tags', { name: '生活', color: '#35c5a6' });
    const childTag = await ok(u, 'POST', '/api/tags', { name: '家务', parentId: parentTag.id });
    const column = await ok(u, 'POST', '/api/kanban-columns', { listId: list.id, name: '进行中' });

    const task = await ok(u, 'POST', '/api/tasks', {
      listId: list.id,
      title: '写周报',
      description: '**本周**进展',
      priority: 'high',
      tagIds: [childTag.id],
      dates: { allDay: false, dueAt: '2026-10-15T07:00:00.000Z', startAt: null },
      repeat: { freq: 'weekly', weekdays: [4] },
      reminders: [{ type: 'before', minutes: 30 }],
      reminderChannelIds: [channel.id],
      columnId: column.id,
    });
    const sub = await ok(u, 'POST', '/api/tasks', { parentId: task.id, title: '汇总数据', dates: { allDay: true, dueDate: '2026-10-15' } });
    await ok(u, 'POST', '/api/tasks', { parentId: sub.id, title: '导出表格' });
    await ok(u, 'PATCH', `/api/tasks/${sub.id}`, { status: 'completed' });
    await ok(u, 'PATCH', `/api/tasks/${task.id}`, { pinned: true });

    // A completed 重复任务 instance and the next one it generated.
    const daily = await ok(u, 'POST', '/api/tasks', { title: '背单词', dates: { allDay: true, dueDate: '2026-10-14' }, repeat: { freq: 'daily' } });
    await ok(u, 'PATCH', `/api/tasks/${daily.id}`, { status: 'completed' });

    const checklist = await ok(u, 'POST', '/api/tasks', { title: '出差清单', tagIds: [parentTag.id] });
    await ok(u, 'PATCH', `/api/tasks/${checklist.id}`, { kind: 'checklist' });
    const item = await ok(u, 'POST', `/api/tasks/${checklist.id}/checklist-items`, { title: '充电器' });
    await ok(u, 'POST', `/api/tasks/${checklist.id}/checklist-items`, { title: '身份证' });
    await ok(u, 'PATCH', `/api/checklist-items/${item.id}`, { completed: true });

    await ok(u, 'POST', `/api/tasks/${task.id}/comments`, { content: '周四前发出' });
    const upload = await t.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/attachments?name=${encodeURIComponent('数据.csv')}`,
      headers: { ...u.headers, 'content-type': 'text/csv' },
      payload: Buffer.from('a,b\n1,2\n'),
    });
    expect(upload.statusCode, upload.body).toBe(201);

    const abandoned = await ok(u, 'POST', '/api/tasks', { listId: archived.id, title: '不做了' });
    await ok(u, 'PATCH', `/api/tasks/${abandoned.id}`, { status: 'abandoned' });
    const trashed = await ok(u, 'POST', '/api/tasks', { title: '删掉的任务' });
    expect((await api(u, 'DELETE', `/api/tasks/${trashed.id}`)).statusCode).toBe(204);

    await ok(u, 'POST', '/api/filters', { name: '高优先级', rules: { listIds: [list.id], tagIds: [parentTag.id], priorities: ['high'] } });
    await ok(u, 'PATCH', '/api/settings', { themeMode: 'dark', timeZone: 'Asia/Tokyo', hiddenSmartLists: ['tomorrow'] });
    await ok(u, 'POST', '/api/countdowns', { name: '生日', date: '2026-12-01', calendar: 'lunar', repeat: 'yearly', reminders: [{ type: 'day', daysBefore: 1, time: null }] });
    const habit = await ok(u, 'POST', '/api/habits', { name: '喝水', goal: { type: 'count', target: 8, unit: '杯' }, reminders: ['09:00'] });
    await ok(u, 'PUT', `/api/habits/${habit.id}/checkins/2026-10-14`, { count: 3 });
    await ok(u, 'POST', '/api/focus/start', { mode: 'stopwatch', taskId: task.id });
    clock.advance(25 * 60_000);
    await ok(u, 'POST', '/api/focus/current/finish', {});
    clock.set('2026-10-14T02:00:00.000Z');
    return u;
  }

  /** Ids replaced by `<type>#<position>`, revisions dropped: what must survive a round trip. */
  function canonical(doc: BackupDocument) {
    const labels = new Map<string, string>();
    for (const [type, records] of Object.entries(doc.entities)) {
      records.forEach((r, i) => labels.set(String(r.id), `${type}#${i}`));
    }
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') return labels.get(value) ?? value;
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'revision').map(([k, v]) => [k, walk(v)]));
      }
      return value;
    };
    return walk(doc.entities);
  }

  function records(doc: BackupDocument, type: keyof BackupDocument['entities']): BackupRecord[] {
    return doc.entities[type] ?? [];
  }

  function issuesOf(res: { statusCode: number; json(): unknown; body: string }): ImportIssue[] {
    expect(res.statusCode, res.body).toBe(400);
    const body = res.json() as { error: { code: string; issues: unknown[] } };
    expect(body.error.code).toBe('import_failed');
    return body.error.issues.map((i) => importIssueSchema.parse(i));
  }

  describe('JSON 往返', () => {
    let source: TestUser;
    let exported: BackupDocument;

    beforeAll(async () => {
      source = await richAccount();
      exported = await exportOf(source);
    });

    it('holds every kind of record, tombstones included, without user ids or secrets in the clear on the server', () => {
      expect(exported.format).toBe('dida-clone-backup');
      expect(exported.version).toBe(1);
      for (const type of ['folder', 'list', 'kanbanColumn', 'tag', 'notificationChannel', 'task', 'checklistItem', 'attachment', 'comment', 'filter', 'settings', 'countdown', 'reminderDelivery', 'focusSession', 'habit', 'habitCheckin'] as const) {
        expect(records(exported, type).length, type).toBeGreaterThan(0);
      }
      expect(records(exported, 'task').some((r) => r.deletedAt !== null && r.title === '删掉的任务')).toBe(true);
      expect(records(exported, 'task').some((r) => r.title === '背单词' && r.repeatIndex === 2 && r.repeatPrevId !== null)).toBe(true);
      expect(JSON.stringify(exported)).not.toContain(source.id);
      const [attachment] = records(exported, 'attachment');
      expect(Buffer.from(String(attachment?.content), 'base64').toString()).toBe('a,b\n1,2\n');
      const [channel] = records(exported, 'notificationChannel');
      expect(channel?.credentials).toEqual({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc-secret-token', secret: 'sign-secret-123456' });
    });

    it('imported into a new user, exports again identically record by record', async () => {
      const target = await user('new');
      await api(target, 'GET', '/api/lists'); // a user who has signed in already has a 收件箱
      const res = await importInto(target, exported);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().imported.task).toBe(records(exported, 'task').length);

      const again = await exportOf(target);
      expect(canonical(again)).toEqual(canonical(exported));
      // New ids: nothing of the source account is shared.
      const sourceIds = new Set(Object.values(exported.entities).flatMap((rs) => rs.map((r) => r.id)));
      for (const rs of Object.values(again.entities)) for (const r of rs) expect(sourceIds.has(r.id)).toBe(false);
    });

    it('the imported account works through the API: tasks, 子任务, 附件 file and the 通知渠道', async () => {
      const target = await user('use');
      expect((await importInto(target, exported)).statusCode).toBe(200);

      const sidebar = (await api(target, 'GET', '/api/lists')).json() as { lists: { id: string; name: string; isInbox: boolean }[] };
      expect(sidebar.lists.filter((l) => l.isInbox)).toHaveLength(1);
      const list = sidebar.lists.find((l) => l.name === '项目');
      expect(list).toBeDefined();
      const tasks = (await api(target, 'GET', `/api/tasks?listId=${list?.id}`)).json() as { tasks: { id: string; title: string; parentId: string | null; priority: string }[] };
      const report = tasks.tasks.find((x) => x.title === '写周报');
      expect(report?.priority).toBe('high');
      expect(tasks.tasks.find((x) => x.title === '汇总数据')?.parentId).toBe(report?.id);

      const attachments = (await api(target, 'GET', `/api/tasks/${report?.id}/attachments`)).json() as { attachments: { id: string }[] };
      const file = await api(target, 'GET', `/api/attachments/${attachments.attachments[0]?.id}/content`);
      expect(file.statusCode).toBe(200);
      expect(file.body).toBe('a,b\n1,2\n');

      const channels = (await api(target, 'GET', '/api/notification-channels')).json() as { channels: { name: string; config: Record<string, unknown> }[] };
      expect(channels.channels[0]?.config.webhookUrl).toBe('https://open.feishu.cn/****oken');
    });

    it('imports into an account that already has data, next to it', async () => {
      const target = await user('busy');
      await ok(target, 'POST', '/api/tasks', { title: '原有任务' });
      expect((await importInto(target, exported)).statusCode).toBe(200);
      const again = await exportOf(target);
      expect(records(again, 'task').length).toBe(records(exported, 'task').length + 1);
      expect(records(again, 'list').filter((l) => l.isInbox && l.deletedAt === null)).toHaveLength(1);
    });
  });

  describe('导入出错', () => {
    let exported: BackupDocument;

    beforeAll(async () => {
      exported = await exportOf(await richAccount());
    });

    function edited(fn: (doc: BackupDocument) => void): BackupDocument {
      const doc = structuredClone(exported);
      fn(doc);
      return doc;
    }

    async function expectNothingImported(u: TestUser) {
      const doc = await exportOf(u);
      for (const [type, rs] of Object.entries(doc.entities)) {
        expect(rs.filter((r) => !(type === 'list' && r.isInbox)), type).toEqual([]);
      }
    }

    it('lists every malformed record with its position and imports nothing', async () => {
      const target = await user('bad');
      const doc = edited((d) => {
        const tasks = records(d, 'task');
        (tasks[1] as BackupRecord).priority = 'urgent';
        (tasks[2] as BackupRecord).title = 42;
        delete (records(d, 'tag')[0] as BackupRecord).name;
      });
      const issues = issuesOf(await importInto(target, doc));
      const where = issues.map((i) => `${i.entity}#${i.index}`);
      expect(where).toEqual(expect.arrayContaining(['task#2', 'task#3', 'tag#1']));
      expect(issues.find((i) => i.entity === 'task' && i.index === 2)?.id).toBe(records(exported, 'task')[1]?.id);
      expect(describeImportIssue(issues.find((i) => i.entity === 'task' && i.index === 2) as ImportIssue)).toMatch(/^任务 第 2 条（id .+）：priority/);
      await expectNothingImported(target);
    });

    it('a record the database refuses rolls back everything written before it', async () => {
      const target = await user('db');
      const doc = edited((d) => {
        // Passes the column checks, breaks the 任务 dates constraint (全天 without a 截止日期).
        const last = records(d, 'task').at(-1) as BackupRecord;
        Object.assign(last, { allDay: true, dueDate: null, startDate: null, startAt: null, dueAt: null, timeZone: null, repeat: null });
      });
      const issues = issuesOf(await importInto(target, doc));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ entity: 'task', index: records(exported, 'task').length });
      await expectNothingImported(target);
    });

    it('refuses references to records outside the file (another user’s 清单)', async () => {
      const other = await user('other');
      const foreign = await ok(other, 'POST', '/api/lists', { name: '别人的清单' });
      const target = await user('ref');
      const doc = edited((d) => {
        (records(d, 'task')[0] as BackupRecord).listId = foreign.id;
        (records(d, 'task')[1] as BackupRecord).tagIds = [randomUUID()];
      });
      const issues = issuesOf(await importInto(target, doc));
      expect(issues.map((i) => [i.entity, i.index])).toEqual(expect.arrayContaining([['task', 1], ['task', 2]]));
      expect(issues.find((i) => i.index === 1)?.message).toContain('清单');
      await expectNothingImported(target);
    });

    it('refuses 子任务 that are each other’s parent', async () => {
      const target = await user('loop');
      const doc = edited((d) => {
        const [a, b] = records(d, 'task').filter((r) => r.title === '写周报' || r.title === '汇总数据') as [BackupRecord, BackupRecord];
        a.parentId = b.id;
        b.parentId = a.id;
      });
      const [a, b] = records(doc, 'task').filter((r) => r.title === '写周报' || r.title === '汇总数据') as [BackupRecord, BackupRecord];
      const issues = issuesOf(await importInto(target, doc));
      expect(issues[0]?.message).toBe('父子关系形成了循环');
      expect([a.id, b.id, records(exported, 'task').find((r) => r.title === '导出表格')?.id]).toContain(issues[0]?.id);
      await expectNothingImported(target);
    });

    it('refuses duplicate ids, unknown entity types and unknown fields', async () => {
      const target = await user('dup');
      const doc = edited((d) => {
        const tasks = records(d, 'task');
        (tasks[1] as BackupRecord).id = (tasks[0] as BackupRecord).id;
        (tasks[2] as BackupRecord).userId = randomUUID();
        (d.entities as Record<string, unknown[]>).gadget = [{}];
      });
      const issues = issuesOf(await importInto(target, doc));
      expect(issues.map((i) => `${i.entity}#${i.index}`)).toEqual(expect.arrayContaining(['task#2', 'task#3', 'gadget#0']));
      await expectNothingImported(target);
    });

    it('refuses files that are not a backup of this app', async () => {
      const target = await user('fmt');
      const res = await importInto(target, { format: 'ticktick', version: 1, exportedAt: '', entities: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('不是本应用导出的备份文件');
    });
  });

  describe('任务 CSV', () => {
    it('exports live 任务 with their 清单, 文件夹, 标签, dates, 重复, 优先级 and 状态', async () => {
      const u = await richAccount();
      const res = await api(u, 'GET', '/api/backup/tasks.csv');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="dida-clone-tasks-\d{8}\.csv"/);
      expect(res.body.startsWith('\uFEFF')).toBe(true);
      const lines = res.body.slice(1).split('\r\n');
      expect(lines[0]).toBe('清单,文件夹,标题,内容,标签,优先级,状态,开始,截止,全天,时区,重复,提醒,任务 ID,父任务 ID,置顶,完成时间,创建时间');
      const row = (title: string) => lines.find((l) => l.split(',')[2] === title)?.split(',');
      expect(row('写周报')).toEqual([
        '项目', '工作', '写周报', '**本周**进展', '家务', '高', '未完成', '', '2026-10-15 15:00', '否', 'Asia/Shanghai', '每周四', '提前30分钟',
        expect.any(String), '', '是', '', expect.stringMatching(/^2026-10-14 /),
      ]);
      expect(row('汇总数据')?.slice(5, 10)).toEqual(['无', '已完成', '', '2026-10-15', '是']);
      expect(row('汇总数据')?.[14]).toBe(row('写周报')?.[13]);
      expect(lines.find((l) => l.includes('出差清单'))).toContain('"[x] 充电器\n[ ] 身份证"');
      expect(row('不做了')?.[6]).toBe('已放弃');
      expect(lines.some((l) => l.includes('删掉的任务'))).toBe(false);
    });

    it('only has the session user’s tasks; needs a session', async () => {
      const a = await richAccount();
      const b = await user('empty');
      const res = await api(b, 'GET', '/api/backup/tasks.csv');
      expect(res.body.slice(1).split('\r\n').filter(Boolean)).toHaveLength(1);
      expect((await t.app.inject({ method: 'GET', url: '/api/backup/tasks.csv' })).statusCode).toBe(401);
      expect((await t.app.inject({ method: 'GET', url: '/api/backup/export' })).statusCode).toBe(401);
      expect((await t.app.inject({ method: 'POST', url: '/api/backup/import', payload: {} })).statusCode).toBe(401);
      void a;
    });
  });
});
