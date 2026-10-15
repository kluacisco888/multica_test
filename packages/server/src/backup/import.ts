import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  BACKUP_ENTITY_NAMES,
  BACKUP_ENTITY_TYPES,
  BACKUP_SKIPPED_TYPES,
  backupDocumentSchema,
  tryParseCivilDate,
  type BackupEntityType,
  type ImportIssue,
} from '@dida/shared';
import type { Tx } from '../db/client.js';
import { lists } from '../db/schema/tasks.js';
import { userSettings } from '../db/schema/settings.js';
import { userRevisions } from '../db/schema/users.js';
import type { EmailCredentials, FeishuCredentials } from '../db/schema/channels.js';
import { credentialContext, emailHints, feishuHints } from '../notify/notifier.js';
import { backupEntities, mapJsonIds, type BackupColumn, type BackupEntity } from './entities.js';
import { checkFields } from './fields.js';
import type { BackupDeps } from './export.js';

/*
 * 导入本应用的 JSON 备份 (spec 用户故事 112). Everything happens in one
 * transaction: a record that cannot be imported names itself (type and
 * 1-based position in the file) and nothing of the file stays behind.
 *
 * 1. Every record is checked against the table's columns and the API's
 *    rules (fields.ts), and its references must point at records of the
 *    file, so a crafted file cannot reach another user's records. All
 *    problems are reported together.
 * 2. Every record gets a new id (the source account may live on this same
 *    server): id columns and the known ids inside JSON columns are rewritten,
 *    text (titles, descriptions, 评论) never. The file's 收件箱 and 设置
 *    become the user's existing ones when there are.
 * 3. Records are inserted as stored (timestamps, tombstones and 回收站 state
 *    included); revisions are fresh but keep the file's order. 通知渠道
 *    secrets are sealed for the new record and their masks recomputed.
 * 4. 提醒 are scheduled afresh for the imported 任务 and 倒数日; the
 *    server's delivery records are not part of a backup.
 */

/** The file cannot be imported; nothing was written. */
export class ImportFailed extends Error {
  constructor(
    message: string,
    readonly issues: ImportIssue[],
  ) {
    super(message);
  }
}

const INVALID_FILE = '备份文件里有不能导入的数据，没有导入任何内容';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Fields of a record that are not table columns. */
const EXTRA_FIELDS: Partial<Record<BackupEntityType, string[]>> = { attachment: ['content'] };

type Rec = Record<string, unknown>;

interface Entry {
  entity: BackupEntity;
  /** 1-based position within its type in the file. */
  index: number;
  /** Id in the file. */
  sourceId: string;
  record: Rec;
}

const isObject = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why `value` does not fit `column`, or null when it does. */
function columnProblem(column: PgColumn, value: unknown): string | null {
  if (value === null) return column.notNull ? '不能为空' : null;
  switch (column.dataType) {
    case 'date':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : '应为 ISO 时间';
    case 'number':
      return Number.isSafeInteger(value) ? null : '应为整数';
    case 'boolean':
      return typeof value === 'boolean' ? null : '应为 true 或 false';
    case 'json':
      return null;
    case 'array': {
      if (!Array.isArray(value)) return '应为数组';
      const base = (column as PgColumn & { baseColumn: PgColumn }).baseColumn;
      return value.every((v) => v !== null && columnProblem(base, v) === null) ? null : '数组里有不合法的值';
    }
    case 'string': {
      if (typeof value !== 'string') return '应为字符串';
      if (column.columnType === 'PgUUID') return UUID.test(value) ? null : '应为 UUID';
      if (column.columnType === 'PgDateString') return tryParseCivilDate(value) ? null : '日期格式应为 YYYY-MM-DD';
      const values = column.enumValues;
      return values && values.length > 0 && !values.includes(value) ? '的取值不合法' : null;
    }
    default:
      return null;
  }
}

/** Column-type checks, then the API's rules (fields.ts); the record comes back in its stored form. */
function checkRecord(entity: BackupEntity, input: unknown): { problems: string[]; record: Rec } {
  if (!isObject(input)) return { problems: ['应该是一个对象'], record: {} };
  const problems = checkColumns(entity, input);
  return problems.length > 0 ? { problems, record: input } : checkFields(entity.type, input);
}

function checkColumns(entity: BackupEntity, record: Rec): string[] {
  const problems: string[] = [];
  const known = new Set([...entity.columns.map((c) => c.key), ...(EXTRA_FIELDS[entity.type] ?? [])]);
  for (const key of Object.keys(record)) if (!known.has(key)) problems.push(`不认识的字段 ${key}`);
  for (const { key, column } of entity.columns) {
    if (!(key in record)) {
      if (key === 'id' || (column.notNull && !column.hasDefault)) problems.push(`缺少 ${key}`);
      continue;
    }
    if (entity.type === 'notificationChannel' && key === 'credentials') {
      if (record[key] !== null && !isObject(record[key])) problems.push('credentials 应为对象');
      continue;
    }
    const problem = columnProblem(column, record[key]);
    if (problem) problems.push(`${key} ${problem}`);
  }
  if (entity.type === 'attachment' && 'content' in record) {
    const content = record.content;
    if (content !== null && (typeof content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(content))) {
      problems.push('content 应为 base64');
    } else if (typeof content === 'string' && Buffer.from(content, 'base64').length !== record.size) {
      problems.push('content 和 size 对不上');
    }
  }
  return problems;
}

/** Check the file and collect its records in import order; throws ImportFailed listing every problem. */
function readFile(input: unknown, hasCipher: boolean): Entry[] {
  const doc = backupDocumentSchema.safeParse(input);
  if (!doc.success) {
    const issues = doc.error.issues.map((i) => ({ entity: i.path.join('.'), index: 0, id: null, message: i.message }));
    throw new ImportFailed(issues[0]?.message ?? '备份文件格式不对', issues);
  }
  const issues: ImportIssue[] = [];
  for (const key of Object.keys(doc.data.entities)) {
    if ((BACKUP_SKIPPED_TYPES as readonly string[]).includes(key)) continue;
    if (!(BACKUP_ENTITY_TYPES as readonly string[]).includes(key)) issues.push({ entity: key, index: 0, id: null, message: '不认识的数据类型' });
  }
  const entries: Entry[] = [];
  const seen = new Map<string, string>();
  const idsOf = new Map<BackupEntityType, Set<string>>();
  for (const entity of backupEntities) {
    (doc.data.entities[entity.type] ?? []).forEach((record, i) => {
      const index = i + 1;
      const id = isObject(record) && typeof record.id === 'string' ? record.id.toLowerCase() : null;
      const { problems, record: checked } = checkRecord(entity, record);
      if (id && UUID.test(id)) {
        const first = seen.get(id);
        if (first) problems.push(`id 和${first}重复`);
        else seen.set(id, `${BACKUP_ENTITY_NAMES[entity.type]} 第 ${index} 条`);
        let set = idsOf.get(entity.type);
        if (!set) idsOf.set(entity.type, (set = new Set()));
        set.add(id);
      }
      for (const message of problems) issues.push({ entity: entity.type, index, id, message });
      if (problems.length === 0) entries.push({ entity, index, sourceId: id as string, record: checked });
    });
  }
  // References must point at records of the file, so a crafted file cannot reach another user's records.
  const known = (type: BackupEntityType, id: unknown) => idsOf.get(type)?.has(String(id).toLowerCase()) === true;
  for (const e of entries) {
    for (const { key, refers } of e.entity.columns) {
      if (!refers || e.record[key] == null) continue;
      const values = Array.isArray(e.record[key]) ? (e.record[key] as unknown[]) : [e.record[key]];
      if (!values.every((v) => known(refers, v))) issues.push(issueOf(e, `${key} 引用的${BACKUP_ENTITY_NAMES[refers]}不在备份文件里`));
    }
    const outside = new Set<BackupEntityType>();
    mapJsonIds(e.entity.type, e.record, (id, refers) => {
      if (!known(refers, id)) outside.add(refers);
      return id;
    });
    for (const refers of outside) issues.push(issueOf(e, `引用的${BACKUP_ENTITY_NAMES[refers]}不在备份文件里`));
    if (e.entity.type === 'notificationChannel' && !hasCipher) {
      issues.push(issueOf(e, '服务器没有配置 APP_ENCRYPTION_KEY，不能导入通知渠道'));
    }
  }
  if (issues.length > 0) {
    issues.sort((a, b) => BACKUP_ENTITY_TYPES.indexOf(a.entity as BackupEntityType) - BACKUP_ENTITY_TYPES.indexOf(b.entity as BackupEntityType) || a.index - b.index);
    throw new ImportFailed(INVALID_FILE, issues);
  }
  return entries;
}

/** New ids for the id columns and the known ids inside JSON columns; nothing else changes. */
function remap(entity: BackupEntity, record: Rec, ids: Map<string, string>): Rec {
  const swap = (id: string) => ids.get(id.toLowerCase()) ?? id;
  const out: Rec = { ...record };
  for (const { key, holdsIds } of entity.columns) {
    const value = out[key];
    if (!holdsIds || value == null) continue;
    out[key] = Array.isArray(value) ? value.map((v) => swap(String(v))) : swap(String(value));
  }
  return mapJsonIds(entity.type, out, swap);
}

/** Parents before children for references within one type (子任务, 父标签, 重复任务 chains). */
function parentsFirst(entries: Entry[], selfRefs: BackupColumn[]): Entry[] | { cycle: Entry } {
  if (selfRefs.length === 0) return entries;
  const pending = new Map(entries.map((e) => [String(e.record.id), e]));
  const ordered: Entry[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((e) => selfRefs.every(({ key }) => !pending.has(String(e.record[key]))));
    if (ready.length === 0) return { cycle: [...pending.values()][0] as Entry };
    for (const e of ready) {
      ordered.push(e);
      pending.delete(String(e.record.id));
    }
  }
  return ordered;
}

/** Reserve `count` revisions of the user; returns the one before the first. */
export async function reserveRevisions(tx: Tx, userId: string, count: number): Promise<number> {
  const [row] = await tx
    .insert(userRevisions)
    .values({ userId, revision: count })
    .onConflictDoUpdate({ target: userRevisions.userId, set: { revision: sql`${userRevisions.revision} + ${count}` } })
    .returning({ revision: userRevisions.revision });
  if (!row) throw new Error('revision counter upsert returned no row');
  return row.revision - count;
}

function dbProblem(error: unknown): string {
  const cause = ((error as { cause?: unknown }).cause ?? error) as { code?: string; constraint?: string; column?: string; message?: string };
  switch (cause.code) {
    case '23505':
      return `和已有的数据冲突（${cause.constraint ?? '唯一约束'}）`;
    case '23514':
      return `不符合数据约束（${cause.constraint ?? '检查约束'}）`;
    case '23503':
      return `引用的数据不存在（${cause.constraint ?? '外键'}）`;
    case '23502':
      return `缺少必填字段 ${cause.column ?? ''}`.trim();
    default:
      if (cause.code?.startsWith('22')) return `字段格式不合法：${cause.message ?? ''}`;
      throw error;
  }
}

/** Import a backup document into the account of `userId`; returns the records imported per type. */
export async function importAccount(deps: BackupDeps, userId: string, input: unknown): Promise<Record<string, number>> {
  const entries = readFile(input, deps.cipher !== null);
  const written: string[] = [];
  try {
    return await deps.sync.transaction(userId, async (ops, tx) => {
      // Fresh ids; the file's live 收件箱 and 设置 merge into the user's own.
      const ids = new Map<string, string>(entries.map((e) => [e.sourceId, randomUUID()]));
      const merged = new Set<string>();
      const [inbox] = await tx.select({ id: lists.id }).from(lists).where(and(eq(lists.userId, userId), eq(lists.isInbox, true), isNull(lists.deletedAt)));
      const [settings] = await tx.select({ id: userSettings.id }).from(userSettings).where(and(eq(userSettings.userId, userId), isNull(userSettings.deletedAt)));
      const live = (type: BackupEntityType, extra: (r: Rec) => boolean = () => true) =>
        entries.filter((e) => e.entity.type === type && e.record.deletedAt == null && extra(e.record));
      for (const [existing, matches, name] of [
        [inbox, live('list', (r) => r.isInbox === true), '收件箱'],
        [settings, live('settings'), '设置'],
      ] as const) {
        if (matches.length > 1) {
          throw new ImportFailed(INVALID_FILE, matches.slice(1).map((e) => issueOf(e, `只能有一个${name}`)));
        }
        const [match] = matches;
        if (existing && match) {
          ids.set(match.sourceId, existing.id);
          merged.add(existing.id);
        }
      }

      const records = entries.map((e) => ({ ...e, record: remap(e.entity, e.record, ids) }));

      // Revisions in file order, whatever order the rows go in.
      let revision = await reserveRevisions(tx, userId, records.length);
      const revisionOf = new Map(records.map((e) => [e, ++revision]));
      const counts: Record<string, number> = {};
      for (const entity of backupEntities) {
        const own = records.filter((e) => e.entity === entity);
        const selfRefs = entity.columns.filter((c) => c.foreignKey && c.refers === entity.type);
        const ordered = parentsFirst(own, selfRefs);
        if (!Array.isArray(ordered)) throw new ImportFailed(INVALID_FILE, [issueOf(ordered.cycle, '父子关系形成了循环')]);
        for (const e of ordered) {
          const values = rowValues(deps, userId, e, revisionOf.get(e) as number);
          try {
            if (merged.has(String(e.record.id))) {
              const { id, ...patch } = values;
              await tx.update(entity.table).set(patch as never).where(eq(entity.table.id, id as string));
            } else {
              await tx.insert(entity.table).values(values as never);
            }
          } catch (error) {
            throw new ImportFailed('导入失败，没有导入任何内容', [issueOf(e, dbProblem(error))]);
          }
        }
        counts[entity.type] = own.length;
      }

      // 提醒 are scheduled afresh, as if each 任务 / 倒数日 had just been saved.
      const idsOfType = (type: BackupEntityType) => records.filter((e) => e.entity.type === type).map((e) => String(e.record.id));
      // In batches: one query per batch stays under PostgreSQL's 65535 bind parameters.
      for (const batch of batches(idsOfType('task'))) await deps.reminders.reconcile(ops, tx, userId, batch);
      for (const batch of batches(idsOfType('countdown'))) await deps.reminders.reconcileCountdowns(ops, tx, userId, batch);
      // 习惯提醒 times already past today were never live here: not sent after the import.
      for (const batch of batches(idsOfType('habit'))) await deps.habitReminders.skipPast(ops, tx, userId, batch);

      for (const e of records) {
        if (e.entity.type !== 'attachment' || typeof e.record.content !== 'string') continue;
        const content = Buffer.from(e.record.content, 'base64');
        const id = String(e.record.id);
        written.push(id);
        await deps.files.write(userId, id, Readable.from([content]), content.length);
      }
      return counts;
    });
  } catch (error) {
    await Promise.all(written.map((id) => deps.files.remove(userId, id)));
    throw error;
  }
}

/** Ids per reconcile call. */
export const RECONCILE_BATCH = 1000;

export function batches<T>(items: T[], size = RECONCILE_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function issueOf(e: Entry, message: string): ImportIssue {
  return { entity: e.entity.type, index: e.index, id: e.sourceId, message };
}

/** Insert values of a record: timestamps as Dates, the user's id, the new revision, sealed credentials. */
function rowValues(deps: BackupDeps, userId: string, e: Entry, revision: number): Rec {
  const values: Rec = { userId, revision };
  for (const { key, column } of e.entity.columns) {
    if (!(key in e.record)) continue;
    const value = e.record[key];
    values[key] = column.dataType === 'date' && typeof value === 'string' ? new Date(value) : value;
  }
  if (e.entity.type === 'notificationChannel' && deps.cipher) {
    const credentials = (e.record.credentials as Rec | null) ?? null;
    values.credentials = deps.cipher.seal(credentials ?? {}, credentialContext(userId, String(e.record.id)));
    // Masks follow from the secrets, whatever the file says.
    values.credentialHints = !credentials
      ? {}
      : e.record.type === 'email'
        ? emailHints(credentials as EmailCredentials)
        : feishuHints(credentials as FeishuCredentials);
  }
  return values;
}
