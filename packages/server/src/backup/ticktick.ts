import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  compareSortKeys,
  parseTickTickBackup,
  sortKeysBetween,
  spreadSortKeys,
  type ImportIssue,
  type TickTickTask,
} from '@dida/shared';
import type { Tx } from '../db/client.js';
import { tags } from '../db/schema/tags.js';
import { checklistItems, folders, lists, tasks } from '../db/schema/tasks.js';
import { endOfSidebarLevel, ensureInbox } from '../organize.js';
import { readSettings } from '../settings.js';
import type { BackupDeps } from './export.js';
import { batches, ImportFailed, reserveRevisions } from './import.js';

/*
 * 导入滴答清单官方备份 CSV (spec 用户故事 113). The file is read and checked
 * by @dida/shared `parseTickTickBackup`; every problem is reported with its
 * line and nothing is written. Then, in one transaction: 文件夹 and 清单 are
 * created (滴答's Inbox goes into the user's 收件箱), 标签 are matched by
 * name (ignoring case) or created, then 任务 (子任务 under their parent, in
 * 滴答's order), their 检查项, and the 提醒 are scheduled.
 */

/** Entity name of CSV issues: `index` is the line of the file. */
export const TICKTICK_ISSUE_ENTITY = 'ticktickCsv';

const INVALID = '滴答清单备份里有不能导入的行，没有导入任何内容';

export interface TickTickImportResult {
  folder: number;
  list: number;
  tag: number;
  task: number;
  checklistItem: number;
}

type Rec = Record<string, unknown>;

export async function importTickTick(deps: BackupDeps, userId: string, text: string): Promise<TickTickImportResult> {
  const { timeZone } = await readSettings(deps.db, userId);
  const { tasks: rows, issues } = parseTickTickBackup(text, timeZone);
  if (issues.length > 0) {
    const out: ImportIssue[] = issues.map((i) => ({ entity: TICKTICK_ISSUE_ENTITY, index: i.line, id: null, ...(i.title ? { title: i.title } : {}), message: i.message }));
    throw new ImportFailed(INVALID, out);
  }
  const inbox = await ensureInbox(deps.db, deps.sync, userId);

  return deps.sync.transaction(userId, async (ops, tx) => {
    const now = deps.clock.now();
    const items = rows.reduce((n, r) => n + r.checklist.length, 0);
    const listKeys = [...new Map(rows.filter((r) => r.list !== null).map((r) => [`${r.folder ?? ''}\u0000${r.list}`, r])).values()];
    const folderNames = [...new Set(listKeys.map((r) => r.folder).filter((f): f is string => f !== null))];
    const tagNames = [...new Map(rows.flatMap((r) => r.tags).map((t) => [t.toLowerCase(), t])).values()];

    // 标签 already there are reused (names are unique per user, ignoring case).
    const existingTags = await tx.select().from(tags).where(and(eq(tags.userId, userId), isNull(tags.deletedAt)));
    const tagIds = new Map(existingTags.map((t) => [t.name.toLowerCase(), t.id]));
    const newTags = tagNames.filter((t) => !tagIds.has(t.toLowerCase()));

    let revision = await reserveRevisions(tx, userId, folderNames.length + listKeys.length + newTags.length + rows.length + items);
    const base = (createdAt: Date = now) => ({ id: randomUUID(), userId, createdAt, updatedAt: now, revision: ++revision, deletedAt: null });
    const insert = async (table: typeof folders | typeof lists | typeof tags | typeof tasks | typeof checklistItems, values: Rec[]) => {
      for (const chunk of batches(values, 500)) if (chunk.length > 0) await tx.insert(table).values(chunk as never);
    };

    // 文件夹 and 清单 outside folders, at the end of the sidebar.
    const topLevel = folderNames.length + listKeys.filter((r) => r.folder === null).length;
    const topKeys = sortKeysBetween(await endOfSidebarLevel(tx, userId, null), null, topLevel);
    const folderIds = new Map<string, string>();
    const folderRows = folderNames.map((name) => {
      const row = { ...base(), name, sortOrder: topKeys.shift() as string, collapsed: false };
      folderIds.set(name, row.id);
      return row;
    });
    await insert(folders, folderRows);
    const listIds = new Map<string, string>();
    const inFolder = new Map<string, number>();
    const listRows = listKeys.map((r) => {
      const folderId = r.folder ? (folderIds.get(r.folder) as string) : null;
      let sortOrder: string;
      if (folderId) {
        const n = (inFolder.get(folderId) ?? 0) + 1;
        inFolder.set(folderId, n);
        sortOrder = (spreadSortKeys(listKeys.filter((l) => l.folder === r.folder).length)[n - 1]) as string;
      } else sortOrder = topKeys.shift() as string;
      const row = { ...base(), name: r.list, color: null, icon: null, folderId, sortOrder, isInbox: false, archivedAt: null, excludeFromSmartLists: false };
      listIds.set(`${r.folder ?? ''}\u0000${r.list}`, row.id);
      return row;
    });
    await insert(lists, listRows);

    const tagKeys = sortKeysBetween(await lastTopLevelTagKey(tx, userId), null, newTags.length);
    await insert(
      tags,
      newTags.map((name, i) => {
        const row = { ...base(), name, color: null, parentId: null, sortOrder: tagKeys[i] };
        tagIds.set(name.toLowerCase(), row.id);
        return row;
      }),
    );

    // 任务: parents first, each group (清单 or parent) in 滴答's order, after what is already there.
    const listOf = (r: TickTickTask) => (r.list === null ? inbox.id : (listIds.get(`${r.folder ?? ''}\u0000${r.list}`) as string));
    const ids = new Map(rows.map((r) => [r.sourceId, randomUUID()]));
    const groups = new Map<string, TickTickTask[]>();
    for (const r of rows) {
      const key = r.sourceParentId ? `p:${r.sourceParentId}` : `l:${listOf(r)}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const sortOrder = new Map<string, string>();
    for (const [key, group] of groups) {
      group.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.line - b.line));
      // Imported tasks go after the 收件箱's own: prefixing the last key keeps them after it.
      const prefix = key === `l:${inbox.id}` ? await lastTaskKey(tx, userId, inbox.id) : '';
      spreadSortKeys(group.length).forEach((k, i) => sortOrder.set((group[i] as TickTickTask).sourceId, prefix + k));
    }
    const depthOf = (r: TickTickTask): number => (r.sourceParentId ? 1 + depthOf(rows.find((x) => x.sourceId === r.sourceParentId) as TickTickTask) : 0);
    const ordered = [...rows].sort((a, b) => depthOf(a) - depthOf(b));
    const taskRows = ordered.map((r) => {
      const d = r.dates;
      return {
        ...base(r.createdAt ? new Date(r.createdAt) : now),
        id: ids.get(r.sourceId),
        listId: listOf(r),
        parentId: r.sourceParentId ? ids.get(r.sourceParentId) : null,
        title: r.title,
        kind: r.kind,
        description: r.description,
        status: r.status,
        completedAt: r.status === 'completed' ? new Date(r.closedAt ?? now) : null,
        abandonedAt: r.status === 'abandoned' ? new Date(r.closedAt ?? now) : null,
        sortOrder: sortOrder.get(r.sourceId),
        allDay: d ? d.allDay : null,
        startDate: d?.allDay ? d.startDate : null,
        dueDate: d?.allDay ? d.dueDate : null,
        startAt: d && !d.allDay && d.startAt ? new Date(d.startAt) : null,
        dueAt: d && !d.allDay ? new Date(d.dueAt) : null,
        timeZone: d && !d.allDay ? d.timeZone : null,
        priority: r.priority,
        tagIds: r.tags.map((t) => tagIds.get(t.toLowerCase()) as string),
        repeat: r.repeat,
        reminders: r.reminders,
        reminderChannelIds: null,
      };
    });
    await insert(tasks, taskRows);
    await insert(
      checklistItems,
      rows.flatMap((r) => {
        const keys = spreadSortKeys(r.checklist.length);
        return r.checklist.map((item, i) => ({ ...base(), taskId: ids.get(r.sourceId), title: item.title, completed: item.completed, sortOrder: keys[i], trashRootId: null }));
      }),
    );

    for (const batch of batches([...ids.values()])) await deps.reminders.reconcile(ops, tx, userId, batch);
    return { folder: folderRows.length, list: listRows.length, tag: newTags.length, task: rows.length, checklistItem: items };
  });
}

async function lastTopLevelTagKey(tx: Tx, userId: string): Promise<string | null> {
  const rows = await tx.select({ key: tags.sortOrder }).from(tags).where(and(eq(tags.userId, userId), isNull(tags.parentId), isNull(tags.deletedAt)));
  return rows.map((r) => r.key).sort(compareSortKeys).at(-1) ?? null;
}

async function lastTaskKey(tx: Tx, userId: string, listId: string): Promise<string> {
  const [row] = await tx
    .select({ key: sql<string | null>`max(${tasks.sortOrder} COLLATE "C")` })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.listId, listId), isNull(tasks.parentId), isNull(tasks.deletedAt)));
  return row?.key ?? '';
}
