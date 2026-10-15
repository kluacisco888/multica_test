import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseCsv,
  parseDuration,
  parseTickTickBackup,
  parseTickTickReminder,
  parseTickTickRepeat,
  UNTITLED_TASK,
} from './ticktick-csv.js';

/* 导入滴答清单备份: the hand-written mock has the format of a real 滴答 export (EURO-30, ADR-0010). */

const MOCK = readFileSync(fileURLToPath(new URL('../../server/test/fixtures/ticktick-backup.mock.csv', import.meta.url)), 'utf8');

describe('parseCsv', () => {
  it('reads quoted fields with commas, quotes and line breaks, and the line each record starts on', () => {
    expect(parseCsv('\uFEFF"a","b, c"\n"x ""y""","1\n2"\n"z",""\n')).toEqual([
      { fields: ['a', 'b, c'], line: 1 },
      { fields: ['x "y"', '1\n2'], line: 2 },
      { fields: ['z', ''], line: 4 },
    ]);
  });
});

describe('parseDuration / parseTickTickReminder', () => {
  it.each([
    ['PT0S', 0],
    ['-PT0S', -0],
    ['-PT30M', -1800],
    ['P0DT9H0M0S', 32_400],
    ['-P1DT15H0M0S', -140_400],
    ['P1W', 604_800],
    ['soon', null],
    ['P', null],
  ])('%s → %s', (value, seconds) => {
    expect(parseDuration(value)).toBe(seconds);
  });

  it.each([
    ['PT0S', false, { type: 'before', minutes: 0 }],
    ['-PT30M', false, { type: 'before', minutes: 30 }],
    ['-PT1H', false, { type: 'before', minutes: 60 }],
    ['P0DT9H0M0S', true, { type: 'day', daysBefore: 0, time: '09:00' }],
    ['-P0DT15H0M0S', true, { type: 'day', daysBefore: 1, time: '09:00' }],
    ['-P1DT15H0M0S', true, { type: 'day', daysBefore: 2, time: '09:00' }],
    ['PT0S', true, { type: 'day', daysBefore: 0, time: '00:00' }],
    ['P0DT13H5M0S', true, { type: 'day', daysBefore: 0, time: '13:05' }],
  ] as const)('%s (全天 %s)', (value, allDay, reminder) => {
    expect(parseTickTickReminder(value, allDay)).toEqual(reminder);
  });

  it.each([
    ['PT30M', false, '在截止时间之后'],
    ['P1DT0H0M0S', true, '在截止日之后'],
    ['-PT30S', false, '精确到秒'],
    ['tomorrow', false, '不是滴答的提醒格式'],
  ])('refuses %s', (value, allDay, message) => {
    expect(() => parseTickTickReminder(value, allDay)).toThrow(message);
  });
});

describe('parseTickTickRepeat', () => {
  const base = { interval: 1, weekdays: [], basis: 'due', skipHolidays: false, end: { type: 'never' } };
  it.each([
    ['FREQ=DAILY', { ...base, freq: 'daily' }],
    ['RRULE:FREQ=DAILY;INTERVAL=3', { ...base, freq: 'daily', interval: 3 }],
    ['FREQ=WEEKLY;INTERVAL=1;BYDAY=FR,MO', { ...base, freq: 'weekly', weekdays: [1, 5] }],
    ['FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1', { ...base, freq: 'monthly', monthDay: 31 }],
    ['FREQ=MONTHLY;COUNT=8;INTERVAL=1;BYMONTHDAY=14', { ...base, freq: 'monthly', monthDay: 14, end: { type: 'count', count: 8 } }],
    ['FREQ=YEARLY;INTERVAL=1;BYMONTH=12;BYMONTHDAY=31', { ...base, freq: 'yearly', month: 12, monthDay: 31 }],
    ['FREQ=DAILY;UNTIL=20261231T160000Z', { ...base, freq: 'daily', end: { type: 'until', date: '2026-12-31' } }],
    ['FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY,WEEKEND', { ...base, freq: 'workday' }],
    ['FREQ=DAILY;TT_SKIP=WEEKEND', { ...base, freq: 'weekly', weekdays: [1, 2, 3, 4, 5] }],
    ['FREQ=WEEKLY;BYDAY=MO;TT_SKIP=HOLIDAY', { ...base, freq: 'weekly', weekdays: [1], skipHolidays: true }],
  ])('%s', (value, rule) => {
    expect(parseTickTickRepeat(value)).toEqual(rule);
  });

  it.each([
    ['FREQ=DAILY;INTERVAL=364', '重复间隔最多 99'],
    ['FREQ=HOURLY', 'FREQ 不支持'],
    ['FREQ=MONTHLY;BYDAY=2MO', 'BYDAY 不支持'],
    ['FREQ=MONTHLY;BYSETPOS=1', '不支持的部分：BYSETPOS'],
    ['FREQ=WEEKLY;TT_SKIP=WEEKEND', '只支持每天重复'],
  ])('refuses %s', (value, message) => {
    expect(() => parseTickTickRepeat(value)).toThrow(message);
  });
});

describe('parseTickTickBackup (mock)', () => {
  const { tasks, issues } = parseTickTickBackup(MOCK, 'Asia/Shanghai');
  const byId = (id: string) => tasks.find((t) => t.sourceId === id);

  it('reads every row of the mock without problems', () => {
    expect(issues).toEqual([]);
    expect(tasks.map((t) => t.sourceId)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    // Lines: preamble 1–6, header 7; row 2 has a two-line Reminder, so row 3 starts on line 11.
    expect(tasks.map((t) => t.line)).toEqual([8, 9, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it('maps 清单, 文件夹 and the 收件箱', () => {
    expect([byId('1')?.list, byId('1')?.folder]).toEqual([null, null]);
    expect([byId('2')?.list, byId('2')?.folder]).toEqual(['示例清单A', '示例文件夹']);
    expect([byId('5')?.list, byId('5')?.folder]).toEqual(['示例清单B', null]);
  });

  it('maps 标签, 优先级, 完成状态 and 子任务', () => {
    expect(byId('2')?.tags).toEqual(['示例标签', '周报']);
    expect(['1', '4', '3', '2'].map((id) => byId(id)?.priority)).toEqual(['none', 'low', 'medium', 'high']);
    expect(['1', '3', '7', '9'].map((id) => [byId(id)?.status, byId(id)?.closedAt])).toEqual([
      ['open', null],
      ['completed', '2026-10-15T03:00:00.000Z'],
      ['abandoned', '2026-10-12T02:00:00.000Z'],
      ['completed', '2026-10-14T01:00:00.000Z'],
    ]);
    expect(byId('3')?.sourceParentId).toBe('2');
  });

  it('maps dates: timed in the row’s time zone, 全天 as local dates, ranges', () => {
    expect(byId('2')?.dates).toEqual({ allDay: false, dueAt: '2026-10-16T07:00:00.000Z', startAt: null, timeZone: 'Asia/Shanghai' });
    expect(byId('3')?.dates).toEqual({ allDay: true, dueDate: '2026-10-16', startDate: null });
    expect(byId('7')?.dates).toEqual({ allDay: true, startDate: '2026-10-20', dueDate: '2026-10-22' });
    // No Is All Day: local midnight is 全天, another time is timed.
    expect(byId('9')?.dates).toEqual({ allDay: false, dueAt: '2026-10-17T01:30:00.000Z', startAt: null, timeZone: 'Asia/Tokyo' });
    expect(byId('10')?.dates).toEqual({ allDay: true, dueDate: '2026-10-20', startDate: null });
    expect(byId('1')?.dates).toBeNull();
  });

  it('maps 重复规则 and 提醒', () => {
    expect(['2', '5', '6', '8', '9'].map((id) => byId(id)?.repeat?.freq)).toEqual(['weekly', 'monthly', 'workday', 'yearly', 'daily']);
    expect(byId('9')?.repeat?.end).toEqual({ type: 'count', count: 8 });
    // Earliest first, like every 提醒 list of the app.
    expect(byId('2')?.reminders).toEqual([
      { type: 'before', minutes: 30 },
      { type: 'before', minutes: 0 },
    ]);
    expect(byId('5')?.reminders).toEqual([{ type: 'day', daysBefore: 1, time: '09:00' }]);
  });

  it('maps 检查项, 内容 line breaks, empty and over-long titles', () => {
    expect(byId('4')?.kind).toBe('checklist');
    expect(byId('4')?.checklist).toEqual([
      { title: '示例项一', completed: false },
      { title: '示例项二', completed: true },
      { title: '示例项三', completed: false },
    ]);
    expect(byId('2')?.description).toBe('第一行\n第二行');
    expect(byId('9')?.title).toBe(UNTITLED_TASK);
    expect(byId('10')?.title).toHaveLength(512);
    expect(byId('10')?.description).toBe(`${'长'.repeat(600)}\n\n示例内容`);
  });
});

describe('parseTickTickBackup (errors)', () => {
  /** The mock with the row of `taskId` changed. */
  function edited(taskId: string, column: string, value: string): string {
    const records = parseCsv(MOCK);
    const header = records[3]?.fields as string[];
    const row = records.find((r) => r.fields[header.indexOf('taskId')] === taskId) as { fields: string[] };
    row.fields[header.indexOf(column)] = value;
    const q = (f: string) => `"${f.replaceAll('"', '""')}"`;
    return '\uFEFF' + records.map((r) => r.fields.map(q).join(',')).join('\n') + '\n';
  }

  it.each([
    ['5', 'Priority', '7', 13, 'Priority「7」应为 0、1、3 或 5'],
    ['6', 'Due Date', '2026/10/15', 14, 'Due Date「2026/10/15」不是滴答的时间格式'],
    ['6', 'Repeat', 'FREQ=DAILY;INTERVAL=364', 14, '重复间隔最多 99'],
    ['8', 'Tags', '有 空格', 16, '标签「有 空格」：标签名称不能包含空格或 #'],
    ['3', 'parentId', '99', 11, '父任务 99 不在文件里'],
    ['3', 'List Name', '示例清单B', 11, '子任务和父任务不在同一个清单'],
    ['1', 'Reminder', 'PT0S', 8, '有提醒但没有日期'],
    ['7', 'Status', '3', 15, 'Status「3」应为 0、2 或 -1'],
    ['7', 'taskId', '1', 15, 'taskId 1 和第 8 行重复'],
  ])('row %s, %s = %s → line %i', (taskId, column, value, line, message) => {
    const { issues } = parseTickTickBackup(edited(taskId, column, value), 'Asia/Shanghai');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.line).toBe(line);
    expect(issues[0]?.message).toContain(message);
  });

  it('refuses a file that is not a 滴答 backup, or misses columns', () => {
    expect(parseTickTickBackup('a,b\n1,2\n', 'Asia/Shanghai').issues[0]?.message).toContain('不是滴答清单的备份文件');
    expect(parseTickTickBackup('"Folder Name","List Name"\n', 'Asia/Shanghai').issues[0]?.message).toMatch(/^表头缺少列：Title/);
  });

  it('finds 子任务 loops', () => {
    const loop = edited('2', 'parentId', '3');
    expect(parseTickTickBackup(loop, 'Asia/Shanghai').issues.map((i) => i.message)).toEqual(['父子关系形成了循环', '父子关系形成了循环']);
  });
});
