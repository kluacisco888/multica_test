import { and, eq, isNull } from 'drizzle-orm';
import {
  compareSortKeys,
  describeReminder,
  describeRepeatRule,
  toCsv,
  zonedDateTime,
} from '@dida/shared';
import type { Db } from '../db/client.js';
import { tags } from '../db/schema/tags.js';
import { checklistItems, folders, lists, tasks } from '../db/schema/tasks.js';
import { readSettings } from '../settings.js';

/* 任务导出为 CSV (spec 用户故事 111): one row per live 任务, for spreadsheets. */

export const TASK_CSV_HEADER = [
  '清单',
  '文件夹',
  '标题',
  '内容',
  '标签',
  '优先级',
  '状态',
  '开始',
  '截止',
  '全天',
  '时区',
  '重复',
  '提醒',
  '任务 ID',
  '父任务 ID',
  '置顶',
  '完成时间',
  '创建时间',
] as const;

const PRIORITY = { high: '高', medium: '中', low: '低', none: '无' } as const;
const STATUS = { open: '未完成', completed: '已完成', abandoned: '已放弃' } as const;

type TaskRow = typeof tasks.$inferSelect;

/**
 * Live 任务 of the user, 清单 in sidebar order (收件箱 first), each 子任务
 * right below its parent. Times are shown in the task's time zone (dates)
 * or the user's (完成时间, 创建时间).
 */
export async function exportTasksCsv(db: Db, userId: string): Promise<string> {
  const live = <T extends typeof tasks | typeof lists | typeof folders | typeof tags | typeof checklistItems>(table: T) =>
    and(eq(table.userId, userId), isNull(table.deletedAt));
  const [taskRows, listRows, folderRows, tagRows, itemRows, settings] = await Promise.all([
    db.select().from(tasks).where(live(tasks)),
    db.select().from(lists).where(live(lists)),
    db.select().from(folders).where(live(folders)),
    db.select().from(tags).where(live(tags)),
    db.select().from(checklistItems).where(live(checklistItems)),
    readSettings(db, userId),
  ]);
  const zone = settings.timeZone;
  const folderName = new Map(folderRows.map((f) => [f.id, f.name]));
  const tagName = new Map(tagRows.map((t) => [t.id, t.name]));
  const instant = (at: Date | null, timeZone: string) => {
    if (!at) return '';
    const { date, time } = zonedDateTime(at, timeZone);
    return `${date} ${time}`;
  };
  const bySort = (a: { sortOrder: string }, b: { sortOrder: string }) => compareSortKeys(a.sortOrder, b.sortOrder);

  const content = (task: TaskRow) =>
    task.kind === 'checklist'
      ? itemRows
          .filter((i) => i.taskId === task.id)
          .sort(bySort)
          .map((i) => `[${i.completed ? 'x' : ' '}] ${i.title}`)
          .join('\n')
      : task.description;

  const row = (task: TaskRow, listName: string, folder: string): string[] => {
    const timed = task.allDay === false;
    const tz = task.timeZone ?? zone;
    const anchor = task.allDay ? task.dueDate : task.dueAt ? zonedDateTime(task.dueAt, tz).date : null;
    return [
      listName,
      folder,
      task.title,
      content(task),
      task.tagIds.flatMap((id) => tagName.get(id) ?? []).join('、'),
      PRIORITY[task.priority],
      STATUS[task.status],
      timed ? instant(task.startAt, tz) : (task.startDate ?? ''),
      timed ? instant(task.dueAt, tz) : (task.dueDate ?? ''),
      task.allDay === null ? '' : task.allDay ? '是' : '否',
      timed ? tz : '',
      task.repeat && anchor ? describeRepeatRule(task.repeat, anchor) : '',
      task.reminders.map((r) => describeReminder(r, settings.allDayReminderTime)).join('、'),
      task.id,
      task.parentId ?? '',
      task.pinOrder ? '是' : '否',
      instant(task.completedAt, zone),
      instant(task.createdAt, zone),
    ];
  };

  const children = new Map<string | null, TaskRow[]>();
  for (const task of taskRows) {
    const key = task.parentId;
    children.set(key, [...(children.get(key) ?? []), task]);
  }
  const lines: string[][] = [[...TASK_CSV_HEADER]];
  const sortedLists = [...listRows].sort((a, b) => Number(b.isInbox) - Number(a.isInbox) || bySort(a, b));
  for (const list of sortedLists) {
    const folder = list.folderId ? (folderName.get(list.folderId) ?? '') : '';
    const visit = (task: TaskRow) => {
      lines.push(row(task, list.name, folder));
      for (const child of (children.get(task.id) ?? []).sort(bySort)) visit(child);
    };
    for (const top of (children.get(null) ?? []).filter((t) => t.listId === list.id).sort(bySort)) visit(top);
  }
  return toCsv(lines);
}
