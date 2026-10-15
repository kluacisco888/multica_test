import type { z } from 'zod';
import { entityNameSchema } from './lists.js';
import { remindersSchema, type Reminder } from './reminders.js';
import { repeatRuleSchema, type RepeatRule } from './repeat-rule.js';
import { tagNameSchema } from './tags.js';
import { TASK_DESCRIPTION_MAX_LENGTH, TASK_MAX_TAGS, TASK_TITLE_MAX_LENGTH, type Priority } from './tasks.js';
import { isValidTimeZone, zonedDateTime } from './task-dates.js';
import { CHECKLIST_ITEM_TITLE_MAX_LENGTH, MAX_TASK_DEPTH } from './task-tree.js';

/*
 * 导入滴答清单官方备份 (spec 用户故事 113). The format is the one the 滴答
 * web app's 生成备份 produces (EURO-30, read from a real export under
 * ADR-0010; tests use a hand-written mock of it):
 *
 * - UTF-8 with BOM. A preamble of quoted lines (`Date: …`, `Version: …`, a
 *   multi-line `Status:` legend), then a header row and one row per 任务.
 *   Records end with LF; line breaks inside a field are CR.
 * - Dates are UTC instants `2026-10-15T00:00:00+0000`. For 全天 tasks they are
 *   local midnight in the row's `Timezone`; a single day has Start = Due.
 * - `Priority` 0 / 1 / 3 / 5; `Status` 0 open, 2 completed, -1 abandoned
 *   (1 also occurs, with a completed time: read as completed).
 * - `Reminder`: one ISO 8601 duration per line, relative to the due time
 *   (全天: to local midnight of the due day), negative = before.
 * - `Repeat`: an RRULE without the `RRULE:` prefix; `TT_SKIP=HOLIDAY` (and
 *   `HOLIDAY,WEEKEND`) are 滴答's own parts.
 * - `Tags`: names separated by `, `. `CHECKLIST` rows hold their 检查项 in
 *   `Content`, one per line, `▫` open / `▪` done.
 * - `taskId` / `parentId`: numbers local to the file (子任务).
 *
 * This module only reads and checks the file; the server writes it.
 */

export const TICKTICK_COLUMNS = [
  'Folder Name',
  'List Name',
  'Title',
  'Kind',
  'Tags',
  'Content',
  'Is Check list',
  'Start Date',
  'Due Date',
  'Reminder',
  'Repeat',
  'Priority',
  'Status',
  'Created Time',
  'Completed Time',
  'Order',
  'Timezone',
  'Is All Day',
  'Is Floating',
  'Column Name',
  'Column Order',
  'View Mode',
  'taskId',
  'parentId',
  'projectKind',
] as const;

/** Columns the import needs; the others (看板分栏, View Mode, …) are read past. */
const REQUIRED_COLUMNS = ['Folder Name', 'List Name', 'Title', 'Kind', 'Tags', 'Content', 'Start Date', 'Due Date', 'Reminder', 'Repeat', 'Priority', 'Status', 'Completed Time', 'Order', 'Timezone', 'Is All Day', 'taskId', 'parentId'] as const;

/** The 滴答 list that is the 收件箱. */
export const TICKTICK_INBOX = 'Inbox';
/** Title for 滴答 tasks without one (本应用的任务必须有标题). */
export const UNTITLED_TASK = '（无标题）';

export interface CsvRecord {
  fields: string[];
  /** 1-based line of the file where the record starts. */
  line: number;
}

/** RFC 4180 records (quoted fields may hold commas, quotes and line breaks), with the line each starts on. */
export function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let i = text.startsWith('\uFEFF') ? 1 : 0;
  const endRecord = () => {
    fields.push(field);
    if (!(fields.length === 1 && fields[0] === '')) records.push({ fields, line: start });
    fields = [];
    field = '';
  };
  for (; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      fields.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      start = line;
    } else field += c;
  }
  if (field !== '' || fields.length > 0) endRecord();
  return records;
}

export interface TickTickTask {
  line: number;
  /** `taskId` of the file. */
  sourceId: string;
  sourceParentId: string | null;
  folder: string | null;
  /** null: the 收件箱. */
  list: string | null;
  title: string;
  kind: 'text' | 'checklist';
  description: string;
  checklist: { title: string; completed: boolean }[];
  tags: string[];
  priority: Priority;
  status: 'open' | 'completed' | 'abandoned';
  /** ISO instant; the completed or abandoned time. */
  closedAt: string | null;
  createdAt: string | null;
  dates:
    | null
    | { allDay: true; startDate: string | null; dueDate: string }
    | { allDay: false; startAt: string | null; dueAt: string; timeZone: string };
  repeat: RepeatRule | null;
  reminders: Reminder[];
  /** 滴答's `Order` (smaller first within its 清单 / parent). */
  order: bigint;
}

export interface TickTickIssue {
  line: number;
  message: string;
}

export class TickTickRowError extends Error {}

const fail = (message: string): never => {
  throw new TickTickRowError(message);
};

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2})(\d{2})$/;

/** `2026-10-15T00:00:00+0000` → ISO instant. */
export function parseTickTickInstant(value: string, column: string): string {
  const m = INSTANT.exec(value);
  const date = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}:${m[8]}`) : null;
  if (!date || Number.isNaN(date.getTime())) return fail(`${column}「${value}」不是滴答的时间格式（例如 2026-10-15T00:00:00+0000）`);
  return date.toISOString();
}

const DURATION = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** Seconds of an ISO 8601 duration (`-PT30M` → -1800), or null when it is not one. */
export function parseDuration(value: string): number | null {
  const m = DURATION.exec(value.trim());
  if (!m || value.trim() === 'P' || value.trim() === '-P' || /T$/.test(value.trim())) return null;
  const [, sign, w, d, h, min, s] = m;
  const total = (Number(w ?? 0) * 7 + Number(d ?? 0)) * 86_400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
  return sign ? -total : total;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** One 滴答 reminder as one of ours: timed → 提前 N 分钟, 全天 → 提前 N 天的某个钟点. */
export function parseTickTickReminder(value: string, allDay: boolean): Reminder {
  const seconds = parseDuration(value);
  if (seconds === null) return fail(`提醒「${value}」不是滴答的提醒格式`);
  if (seconds % 60 !== 0) return fail(`提醒「${value}」精确到秒，本应用只支持到分钟`);
  if (!allDay) {
    if (seconds > 0) return fail(`提醒「${value}」在截止时间之后，本应用不支持`);
    return { type: 'before', minutes: (0 - seconds) / 60 };
  }
  if (seconds >= 86_400) return fail(`提醒「${value}」在截止日之后，本应用不支持`);
  const daysBefore = seconds < 0 ? Math.ceil(-seconds / 86_400) : 0;
  const ofDay = seconds + daysBefore * 86_400;
  return { type: 'day', daysBefore, time: `${pad(Math.floor(ofDay / 3600))}:${pad((ofDay % 3600) / 60)}` };
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const FREQ: Record<string, 'daily' | 'weekly' | 'monthly' | 'yearly'> = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' };

/** First Chinese message of a zod error, else `fallback`. */
function chinese(error: z.ZodError, fallback: string): string {
  return error.issues.find((i) => /[\u4e00-\u9fff]/.test(i.message))?.message ?? fallback;
}

/** A 滴答 RRULE as our 重复规则; parts this app cannot do are refused. */
export function parseTickTickRepeat(value: string): RepeatRule {
  const raw = value.trim().replace(/^RRULE:/i, '');
  const parts = new Map<string, string>();
  for (const part of raw.split(';')) {
    if (!part) continue;
    const [key, v] = part.split('=') as [string, string | undefined];
    if (!key || v === undefined) return fail(`重复规则「${value}」格式不对`);
    parts.set(key.toUpperCase(), v);
  }
  const unknown = [...parts.keys()].filter((k) => !['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL', 'WKST', 'TT_SKIP'].includes(k));
  if (unknown.length > 0) return fail(`重复规则「${value}」里有本应用不支持的部分：${unknown.join('、')}`);
  let freq: RepeatRule['freq'] | undefined = FREQ[parts.get('FREQ') ?? ''];
  if (!freq) return fail(`重复规则「${value}」的 FREQ 不支持`);
  const rule: Record<string, unknown> = {};
  const interval = parts.get('INTERVAL');
  if (interval !== undefined) {
    if (!/^\d+$/.test(interval)) return fail(`重复规则「${value}」的 INTERVAL 不是数字`);
    rule.interval = Number(interval);
  }
  const byDay = parts.get('BYDAY');
  if (byDay !== undefined) {
    const days = byDay.split(',').map((d) => WEEKDAYS[d]);
    if (freq !== 'weekly' || days.some((d) => d === undefined)) return fail(`重复规则「${value}」的 BYDAY 不支持（只支持每周的某几天）`);
    rule.weekdays = days;
  }
  const monthDay = parts.get('BYMONTHDAY');
  if (monthDay !== undefined) {
    if ((freq !== 'monthly' && freq !== 'yearly') || !/^-?\d+$/.test(monthDay)) return fail(`重复规则「${value}」的 BYMONTHDAY 不支持`);
    // -1 (the last day): 31 clamps to the end of every month.
    const day = Number(monthDay);
    if (day === -1) rule.monthDay = 31;
    else if (day >= 1) rule.monthDay = day;
    else return fail(`重复规则「${value}」的 BYMONTHDAY 只支持某一天或最后一天`);
  }
  const month = parts.get('BYMONTH');
  if (month !== undefined) {
    if (freq !== 'yearly' || !/^\d+$/.test(month)) return fail(`重复规则「${value}」的 BYMONTH 不支持`);
    rule.month = Number(month);
  }
  const count = parts.get('COUNT');
  const until = parts.get('UNTIL');
  if (count !== undefined && until !== undefined) return fail(`重复规则「${value}」同时有 COUNT 和 UNTIL`);
  if (count !== undefined) {
    if (!/^\d+$/.test(count)) return fail(`重复规则「${value}」的 COUNT 不是数字`);
    rule.end = { type: 'count', count: Number(count) };
  }
  if (until !== undefined) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(until);
    if (!m) return fail(`重复规则「${value}」的 UNTIL 不是日期`);
    rule.end = { type: 'until', date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  const skip = parts.get('TT_SKIP');
  if (skip !== undefined) {
    const kinds = new Set(skip.split(','));
    if ([...kinds].some((k) => k !== 'HOLIDAY' && k !== 'WEEKEND')) return fail(`重复规则「${value}」的 TT_SKIP 不支持`);
    if (kinds.has('WEEKEND')) {
      // 每天、跳过周末（和节假日）: 每个工作日 / 每周一到周五.
      if (freq !== 'daily' || (rule.interval ?? 1) !== 1) return fail(`重复规则「${value}」的「跳过周末」只支持每天重复`);
      if (kinds.has('HOLIDAY')) freq = 'workday';
      else {
        freq = 'weekly';
        rule.weekdays = [1, 2, 3, 4, 5];
      }
      delete rule.interval;
    } else rule.skipHolidays = true;
  }
  const parsed = repeatRuleSchema.safeParse({ freq, ...rule });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path[0] === 'interval' ? '重复间隔最多 99' : chinese(parsed.error, '本应用不支持这个重复规则');
    return fail(`重复规则「${value}」：${where}`);
  }
  return parsed.data;
}

const PRIORITY: Record<string, Priority> = { '0': 'none', '1': 'low', '3': 'medium', '5': 'high' };

/** CR / CRLF inside a field are line breaks. */
const lines = (value: string) => value.replace(/\r\n?/g, '\n');

function parseRow(get: (column: string) => string, line: number, defaultTimeZone: string): TickTickTask {
  const sourceId = get('taskId').trim();
  if (!sourceId) return fail('缺少 taskId');
  const listName = get('List Name').trim();
  const folderName = get('Folder Name').trim();
  if (!listName) return fail('缺少清单名称（List Name）');
  const inbox = listName === TICKTICK_INBOX && !folderName;
  if (!inbox) {
    const list = entityNameSchema.safeParse(listName);
    if (!list.success) return fail(`清单名称「${listName.slice(0, 20)}」：${chinese(list.error, '不合法')}`);
  }
  if (folderName) {
    const folder = entityNameSchema.safeParse(folderName);
    if (!folder.success) return fail(`文件夹名称「${folderName.slice(0, 20)}」：${chinese(folder.error, '不合法')}`);
  }

  // Titles: one line, at most 512 characters; a longer one keeps its full text at the top of the 描述.
  const fullTitle = lines(get('Title')).replace(/\n+/g, ' ').trim();
  const title = fullTitle === '' ? UNTITLED_TASK : [...fullTitle].slice(0, TASK_TITLE_MAX_LENGTH).join('');

  const kindValue = get('Kind').trim().toUpperCase();
  if (kindValue !== 'TEXT' && kindValue !== 'CHECKLIST') return fail(`Kind「${get('Kind')}」应为 TEXT 或 CHECKLIST`);
  const kind = kindValue === 'CHECKLIST' ? 'checklist' : 'text';
  const content = lines(get('Content'));
  const checklist: TickTickTask['checklist'] = [];
  let description = '';
  if (kind === 'checklist') {
    for (const raw of content.split('\n')) {
      const done = raw.startsWith('▪');
      const text = raw.replace(/^[▫▪]/, '').trim();
      if (!text) continue;
      if ([...text].length > CHECKLIST_ITEM_TITLE_MAX_LENGTH) return fail(`检查项最多 ${CHECKLIST_ITEM_TITLE_MAX_LENGTH} 个字符`);
      checklist.push({ title: text, completed: done });
    }
  } else {
    description = title === fullTitle || fullTitle === '' ? content : content ? `${fullTitle}\n\n${content}` : fullTitle;
    if (description.length > TASK_DESCRIPTION_MAX_LENGTH) return fail('内容太长');
  }

  const tags = [...new Set(get('Tags').split(',').map((t) => t.trim()).filter(Boolean))];
  if (tags.length > TASK_MAX_TAGS) return fail(`每个任务最多 ${TASK_MAX_TAGS} 个标签`);
  for (const tag of tags) {
    const parsed = tagNameSchema.safeParse(tag);
    if (!parsed.success) return fail(`标签「${tag.slice(0, 20)}」：${chinese(parsed.error, '不合法')}`);
  }

  const priority = PRIORITY[get('Priority').trim() || '0'];
  if (!priority) return fail(`Priority「${get('Priority')}」应为 0、1、3 或 5`);

  const statusValue = get('Status').trim() || '0';
  const status = statusValue === '0' ? 'open' : statusValue === '1' || statusValue === '2' ? 'completed' : statusValue === '-1' ? 'abandoned' : null;
  if (!status) return fail(`Status「${get('Status')}」应为 0、2 或 -1`);
  const completed = get('Completed Time').trim();
  const closedAt = status === 'open' || !completed ? null : parseTickTickInstant(completed, 'Completed Time');
  const created = get('Created Time').trim();
  const createdAt = created ? parseTickTickInstant(created, 'Created Time') : null;

  const timeZone = get('Timezone').trim() || defaultTimeZone;
  if (!isValidTimeZone(timeZone)) return fail(`Timezone「${timeZone}」不是有效的时区`);
  const startValue = get('Start Date').trim();
  const dueValue = get('Due Date').trim() || startValue;
  let dates: TickTickTask['dates'] = null;
  if (dueValue) {
    const dueAt = parseTickTickInstant(dueValue, 'Due Date');
    const startAt = startValue ? parseTickTickInstant(startValue, 'Start Date') : dueAt;
    if (Date.parse(startAt) > Date.parse(dueAt)) return fail('开始时间晚于截止时间');
    const allDayValue = get('Is All Day').trim();
    // Rows without the flag: 全天 when the due time is local midnight.
    const allDay = allDayValue === 'true' || (allDayValue === '' && zonedDateTime(dueAt, timeZone).time === '00:00');
    if (allDayValue !== '' && allDayValue !== 'true' && allDayValue !== 'false') return fail(`Is All Day「${allDayValue}」应为 true 或 false`);
    if (allDay) {
      const dueDate = zonedDateTime(dueAt, timeZone).date;
      const startDate = zonedDateTime(startAt, timeZone).date;
      dates = { allDay: true, dueDate, startDate: startDate === dueDate ? null : startDate };
    } else {
      dates = { allDay: false, dueAt, startAt: startAt === dueAt ? null : startAt, timeZone };
    }
  }

  const repeatValue = get('Repeat').trim();
  const repeat = repeatValue ? parseTickTickRepeat(repeatValue) : null;
  if (repeat && !dates) return fail('有重复规则但没有日期');

  const reminderValues = lines(get('Reminder')).split('\n').map((r) => r.trim()).filter(Boolean);
  if (reminderValues.length > 0 && !dates) return fail('有提醒但没有日期');
  const parsedReminders = remindersSchema.safeParse(reminderValues.map((r) => parseTickTickReminder(r, dates?.allDay === true)));
  if (!parsedReminders.success) return fail(`提醒：${chinese(parsedReminders.error, '不合法')}`);

  const orderValue = get('Order').trim() || '0';
  if (!/^-?\d+$/.test(orderValue)) return fail(`Order「${orderValue}」不是整数`);
  const parent = get('parentId').trim();

  return {
    line,
    sourceId,
    sourceParentId: parent || null,
    folder: inbox ? null : folderName || null,
    list: inbox ? null : listName,
    title,
    kind,
    description,
    checklist,
    tags,
    priority,
    status,
    closedAt,
    createdAt,
    dates,
    repeat,
    reminders: parsedReminders.data,
    order: BigInt(orderValue),
  };
}

/**
 * Read a 滴答 backup: every row checked, every problem listed with its line.
 * 子任务 must name a parent of the file in the same 清单, at most 5 levels deep.
 */
export function parseTickTickBackup(text: string, defaultTimeZone: string): { tasks: TickTickTask[]; issues: TickTickIssue[] } {
  const records = parseCsv(text);
  const headerAt = records.findIndex((r) => r.fields[0] === 'Folder Name');
  if (headerAt < 0) return { tasks: [], issues: [{ line: 0, message: '这不是滴答清单的备份文件（没有找到 Folder Name 开头的表头）' }] };
  const header = (records[headerAt] as CsvRecord).fields;
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) return { tasks: [], issues: [{ line: (records[headerAt] as CsvRecord).line, message: `表头缺少列：${missing.join('、')}` }] };
  const index = new Map(header.map((h, i) => [h, i]));

  const tasks: TickTickTask[] = [];
  const issues: TickTickIssue[] = [];
  const seen = new Map<string, number>();
  for (const record of records.slice(headerAt + 1)) {
    if (record.fields.length !== header.length) {
      issues.push({ line: record.line, message: `有 ${record.fields.length} 列，表头有 ${header.length} 列` });
      continue;
    }
    const get = (column: string) => record.fields[index.get(column) as number] ?? '';
    try {
      const task = parseRow(get, record.line, defaultTimeZone);
      const first = seen.get(task.sourceId);
      if (first !== undefined) {
        issues.push({ line: record.line, message: `taskId ${task.sourceId} 和第 ${first} 行重复` });
        continue;
      }
      seen.set(task.sourceId, record.line);
      tasks.push(task);
    } catch (error) {
      if (!(error instanceof TickTickRowError)) throw error;
      issues.push({ line: record.line, message: error.message });
    }
  }

  // 子任务: a parent of the file, same 清单, no cycles, at most MAX_TASK_DEPTH levels.
  const byId = new Map(tasks.map((t) => [t.sourceId, t]));
  for (const task of tasks) {
    if (!task.sourceParentId) continue;
    const parent = byId.get(task.sourceParentId);
    if (!parent) {
      if (!seen.has(task.sourceParentId)) issues.push({ line: task.line, message: `父任务 ${task.sourceParentId} 不在文件里` });
      continue;
    }
    if (parent.list !== task.list || parent.folder !== task.folder) {
      issues.push({ line: task.line, message: '子任务和父任务不在同一个清单' });
      continue;
    }
    // Level of the task, the root being 1; a cycle never reaches a root.
    let level = 2;
    let up: TickTickTask | undefined = parent;
    const visited = new Set([task.sourceId, parent.sourceId]);
    let cycle = false;
    while (up?.sourceParentId) {
      up = byId.get(up.sourceParentId);
      if (!up) break;
      if (visited.has(up.sourceId)) {
        cycle = true;
        break;
      }
      visited.add(up.sourceId);
      level += 1;
    }
    if (cycle) issues.push({ line: task.line, message: '父子关系形成了循环' });
    else if (level > MAX_TASK_DEPTH) issues.push({ line: task.line, message: `子任务最多 ${MAX_TASK_DEPTH} 层` });
  }
  issues.sort((a, b) => a.line - b.line);
  return { tasks, issues };
}
