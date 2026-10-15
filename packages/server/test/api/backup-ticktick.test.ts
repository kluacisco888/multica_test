import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { describeImportIssue, type ImportIssue } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { reminderDeliveries } from '../../src/db/schema/reminders.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 导入滴答清单备份 (spec 用户故事 113, EURO-30): the hand-written mock in the
 * format of a real 滴答 export goes in through the API; a bad row is named by
 * its line and nothing is imported.
 */

const MOCK = readFileSync(fileURLToPath(new URL('../fixtures/ticktick-backup.mock.csv', import.meta.url)), 'utf8');

interface Task {
  id: string;
  title: string;
  listId: string;
  parentId: string | null;
  kind: string;
  description: string;
  status: string;
  priority: string;
  tagIds: string[];
  dates: unknown;
  repeat: { freq: string; monthDay?: number; end: unknown } | null;
  reminders: unknown[];
  completedAt: string | null;
  abandonedAt: string | null;
  sortOrder: string;
}

describe('导入滴答清单备份', () => {
  const clock = fixedClock('2026-10-14T02:00:00.000Z');
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await createTestApp({ clock });
  });
  afterAll(() => t.close());

  const user = () => t.createUser(`tt${++n}`);
  const get = (u: TestUser, url: string) => t.app.inject({ method: 'GET', url, headers: u.headers });
  const importCsv = (u: TestUser, csv: string) =>
    t.app.inject({ method: 'POST', url: '/api/backup/import-ticktick', headers: { ...u.headers, 'content-type': 'text/csv' }, payload: csv });

  async function tasksOf(u: TestUser): Promise<Task[]> {
    const sidebar = (await get(u, '/api/lists')).json() as { lists: { id: string }[] };
    const all: Task[] = [];
    for (const l of sidebar.lists) all.push(...((await get(u, `/api/tasks?listId=${l.id}`)).json() as { tasks: Task[] }).tasks);
    // Completed and abandoned tasks are only listed under 已完成 / 回收站 views: read them from the sync feed.
    const changes = (await get(u, '/api/changes?since=0')).json() as { entities: { task: { upserts: Task[] } } };
    const seen = new Set(all.map((x) => x.id));
    for (const x of changes.entities.task.upserts) if (!seen.has(x.id)) all.push(x);
    return all;
  }

  it('imports 清单, 文件夹, 标签, 日期, 重复, 优先级, 子任务, 完成状态 and 检查项', async () => {
    const u = await user();
    await t.app.inject({ method: 'POST', url: '/api/tags', headers: u.headers, payload: { name: '生活' } });
    const res = await importCsv(u, MOCK);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().imported).toEqual({ folder: 1, list: 2, tag: 2, task: 10, checklistItem: 3 });

    const sidebar = (await get(u, '/api/lists')).json() as { lists: { id: string; name: string; isInbox: boolean; folderId: string | null }[]; folders: { id: string; name: string }[] };
    expect(sidebar.folders.map((f) => f.name)).toEqual(['示例文件夹']);
    const listA = sidebar.lists.find((l) => l.name === '示例清单A');
    const listB = sidebar.lists.find((l) => l.name === '示例清单B');
    const inbox = sidebar.lists.find((l) => l.isInbox);
    expect(listA?.folderId).toBe(sidebar.folders[0]?.id);
    expect(listB?.folderId).toBeNull();
    expect(sidebar.lists.filter((l) => l.isInbox)).toHaveLength(1);

    const tags = (await get(u, '/api/tags')).json() as { tags: { id: string; name: string }[] };
    expect(tags.tags.map((x) => x.name).sort()).toEqual(['周报', '生活', '示例标签']);
    const tagId = (name: string) => tags.tags.find((x) => x.name === name)?.id;

    const tasks = await tasksOf(u);
    const task = (title: string) => tasks.find((x) => x.title === title) as Task;
    expect(tasks).toHaveLength(10);
    expect(task('示例任务：买牛奶').listId).toBe(inbox?.id);

    const report = task('示例任务：写周报');
    expect(report).toMatchObject({
      listId: listA?.id,
      priority: 'high',
      status: 'open',
      description: '第一行\n第二行',
      dates: { allDay: false, dueAt: '2026-10-16T07:00:00.000Z', startAt: null, timeZone: 'Asia/Shanghai' },
      repeat: { freq: 'weekly', weekdays: [5] },
      reminders: [{ type: 'before', minutes: 30 }, { type: 'before', minutes: 0 }],
    });
    expect(report.tagIds.sort()).toEqual([tagId('示例标签'), tagId('周报')].sort());

    const sub = task('示例子任务：整理数据');
    expect(sub).toMatchObject({ parentId: report.id, listId: listA?.id, priority: 'medium', status: 'completed', completedAt: '2026-10-15T03:00:00.000Z' });
    expect(sub.dates).toEqual({ allDay: true, dueDate: '2026-10-16', startDate: null });

    const checklist = task('示例检查清单');
    expect(checklist).toMatchObject({ kind: 'checklist', priority: 'low', tagIds: [tagId('生活')] });
    const items = (await get(u, `/api/tasks/${checklist.id}/checklist-items`)).json() as { items: { title: string; completed: boolean }[] };
    expect(items.items.map((i) => [i.title, i.completed])).toEqual([
      ['示例项一', false],
      ['示例项二', true],
      ['示例项三', false],
    ]);

    expect(task('示例：每月最后一天').repeat).toMatchObject({ freq: 'monthly', monthDay: 31 });
    expect(task('示例：每月最后一天').reminders).toEqual([{ type: 'day', daysBefore: 1, time: '09:00' }]);
    expect(task('示例：每个工作日').repeat?.freq).toBe('workday');
    expect(task('示例：每年').repeat).toMatchObject({ freq: 'yearly', month: 12, monthDay: 31 });
    expect(task('示例：放弃的多日任务')).toMatchObject({ status: 'abandoned', abandonedAt: '2026-10-12T02:00:00.000Z', dates: { allDay: true, startDate: '2026-10-20', dueDate: '2026-10-22' } });
    expect(task('（无标题）')).toMatchObject({ status: 'completed', repeat: { freq: 'daily', end: { type: 'count', count: 8 } }, dates: { allDay: false, timeZone: 'Asia/Tokyo' } });
    expect(task('长'.repeat(512)).description).toBe(`${'长'.repeat(600)}\n\n示例内容`);

    // 滴答's order within the 清单, smaller Order first: 写周报 (-2000) before 检查清单 (-1000).
    const inA = tasks.filter((x) => x.listId === listA?.id && !x.parentId).sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1));
    expect(inA.map((x) => x.title)).toEqual(['示例任务：写周报', '示例检查清单']);

    // 提醒 are scheduled for the open task with a future time.
    const deliveries = await t.database.db.select().from(reminderDeliveries).where(eq(reminderDeliveries.userId, u.id));
    expect(deliveries.filter((d) => d.taskId === report.id && d.status === 'scheduled').map((d) => d.fireAt.toISOString()).sort()).toEqual([
      '2026-10-16T06:30:00.000Z',
      '2026-10-16T07:00:00.000Z',
    ]);
  });

  it('puts imported 收件箱 tasks after the ones already there', async () => {
    const u = await user();
    const mine = (await t.app.inject({ method: 'POST', url: '/api/tasks', headers: u.headers, payload: { title: '原有任务' } })).json() as Task;
    expect((await importCsv(u, MOCK)).statusCode).toBe(200);
    const inbox = ((await get(u, `/api/tasks?listId=${mine.listId}`)).json() as { tasks: Task[] }).tasks.sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1));
    expect(inbox[0]?.title).toBe('原有任务');
    expect(inbox).toHaveLength(3);
  });

  it('names the line of each bad row and imports nothing', async () => {
    const u = await user();
    const before = ((await get(u, '/api/changes?since=0')).json() as { revision: number }).revision;
    const lines = MOCK.split('\n');
    // Line 13 (示例：每月最后一天): Priority 7; line 16 (示例：每年): bad Due Date.
    lines[12] = (lines[12] as string).replace('"10","5"', '"10","5"').replace(/"0","0","2026-10-10T02:00:00\+0000"/, '"7","0","2026-10-10T02:00:00+0000"');
    lines[15] = (lines[15] as string).replace('"2026-12-30T16:00:00+0000","2026-12-30T16:00:00+0000"', '"2026-12-30T16:00:00+0000","2026/12/31"');
    const res = await importCsv(u, lines.join('\n'));
    expect(res.statusCode, res.body).toBe(400);
    const body = res.json() as { error: { code: string; message: string; issues: ImportIssue[] } };
    expect(body.error).toMatchObject({ code: 'import_failed', message: '滴答清单备份里有不能导入的行，没有导入任何内容' });
    expect(body.error.issues.map(describeImportIssue)).toEqual([
      '第 13 行：Priority「7」应为 0、1、3 或 5',
      '第 16 行：Due Date「2026/12/31」不是滴答的时间格式（例如 2026-10-15T00:00:00+0000）',
    ]);
    const after = (await get(u, '/api/changes?since=0')).json() as { revision: number; entities: Record<string, { upserts: unknown[] }> };
    expect(after.entities.task?.upserts).toEqual([]);
    expect(after.entities.folder?.upserts).toEqual([]);
    expect(after.entities.tag?.upserts).toEqual([]);
    // Only the 收件箱 (created before the file is read) may be new.
    expect(after.revision - before).toBeLessThanOrEqual(1);
  });

  it('a row the database refuses rolls everything back', async () => {
    const u = await user();
    await t.app.inject({ method: 'POST', url: '/api/tags', headers: u.headers, payload: { name: '示例标签' } });
    const original = t.app.reminders.reconcile;
    t.app.reminders.reconcile = async () => {
      throw new Error('boom');
    };
    try {
      expect((await importCsv(u, MOCK)).statusCode).toBe(500);
    } finally {
      t.app.reminders.reconcile = original;
    }
    const after = (await get(u, '/api/changes?since=0')).json() as { entities: Record<string, { upserts: unknown[] }> };
    expect(after.entities.task?.upserts).toEqual([]);
    expect(after.entities.list?.upserts.length).toBe(1); // the 收件箱
    expect(after.entities.tag?.upserts.length).toBe(1);
  });

  it('refuses files that are not a 滴答 backup, other content types, and needs a session', async () => {
    const u = await user();
    const res = await importCsv(u, 'title,due\n买菜,明天\n');
    expect(res.statusCode).toBe(400);
    expect(describeImportIssue(res.json().error.issues[0])).toContain('不是滴答清单的备份文件');
    const json = await t.app.inject({ method: 'POST', url: '/api/backup/import-ticktick', headers: u.headers, payload: { csv: MOCK } });
    expect(json.statusCode).toBe(415);
    const anonymous = await t.app.inject({ method: 'POST', url: '/api/backup/import-ticktick', headers: { 'content-type': 'text/csv' }, payload: MOCK });
    expect(anonymous.statusCode).toBe(401);
  });
});
