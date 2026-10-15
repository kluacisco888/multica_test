import { z } from 'zod';

/*
 * 导入导出 (spec 用户故事 110–112): the account backup is one JSON document
 * holding every record of every synced entity (ADR-0004), tombstones
 * included, so importing it restores the account completely. 任务 can also
 * be exported as CSV.
 */

export const BACKUP_FORMAT = 'dida-clone-backup';
export const BACKUP_VERSION = 1;
/**
 * Largest backup file: the import accepts no more, and the export refuses to
 * build a larger one (附件 travel inside it as base64).
 */
export const BACKUP_IMPORT_MAX_BYTES = 256 * 1024 * 1024;

/** `12.3 MB` */
export function formatBackupSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Entity types of a backup, in import order (a record only refers to types
 * before it, or to its own type). Keys match `GET /api/changes`.
 */
export const BACKUP_ENTITY_TYPES = [
  'folder',
  'list',
  'kanbanColumn',
  'tag',
  'notificationChannel',
  'task',
  'checklistItem',
  'attachment',
  'comment',
  'filter',
  'settings',
  'countdown',
  'focusSession',
  'habit',
  'habitCheckin',
] as const;
export type BackupEntityType = (typeof BACKUP_ENTITY_TYPES)[number];

/**
 * Synced types that are not in a backup: the server's own delivery records of
 * 提醒 and 习惯提醒. Importing reschedules the reminders instead. A file that
 * still has them imports fine; they are skipped.
 */
export const BACKUP_SKIPPED_TYPES = ['reminderDelivery', 'habitReminderDelivery'] as const;

/** Chinese names used in import error messages. */
export const BACKUP_ENTITY_NAMES: Record<BackupEntityType, string> = {
  folder: '文件夹',
  list: '清单',
  kanbanColumn: '看板分栏',
  tag: '标签',
  notificationChannel: '通知渠道',
  task: '任务',
  checklistItem: '检查项',
  attachment: '附件',
  comment: '评论',
  filter: '过滤器',
  settings: '设置',
  countdown: '倒数日',
  focusSession: '专注记录',
  habit: '习惯',
  habitCheckin: '打卡',
};

/** A record in a backup: the stored columns (no user id, no revision), dates as ISO strings. */
export type BackupRecord = Record<string, unknown>;

export interface BackupDocument {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  entities: Partial<Record<BackupEntityType, BackupRecord[]>>;
}

/** Envelope check only; records are checked column by column by the server. */
export const backupDocumentSchema = z.object({
  format: z.literal(BACKUP_FORMAT, { error: '不是本应用导出的备份文件' }),
  version: z.literal(BACKUP_VERSION, { error: '不支持这个版本的备份文件' }),
  exportedAt: z.string(),
  entities: z.record(z.string(), z.array(z.unknown(), { error: '每类数据都应该是一个数组' })),
});

/** One problem found while importing: which record (1-based `index` within its type) and why. */
export const importIssueSchema = z.object({
  entity: z.string(),
  index: z.number().int(),
  id: z.string().nullable(),
  /** 滴答清单 CSV: the row's title (shortened), to find the line. */
  title: z.string().optional(),
  message: z.string(),
});
export type ImportIssue = z.infer<typeof importIssueSchema>;

export const importResponseSchema = z.object({
  /** Records imported per entity type. */
  imported: z.record(z.string(), z.number().int()),
});
export type ImportResponse = z.infer<typeof importResponseSchema>;

/** 任务 第 3 条（id …）：原因 */
export function describeImportIssue(issue: ImportIssue): string {
  // 滴答清单 CSV: `index` is the line of the file.
  if (issue.entity === 'ticktickCsv') {
    if (issue.index <= 0) return issue.message;
    return `第 ${issue.index} 行${issue.title ? `（${issue.title}）` : ''}：${issue.message}`;
  }
  const name = BACKUP_ENTITY_NAMES[issue.entity as BackupEntityType] ?? issue.entity;
  const where = issue.index > 0 ? `${name} 第 ${issue.index} 条` : name;
  return `${where}${issue.id ? `（id ${issue.id}）` : ''}：${issue.message}`;
}

/**
 * RFC 4180 CSV: fields with commas, quotes or line breaks are quoted; lines
 * end with CRLF. A field a spreadsheet would run as a formula (starting with
 * `=`, `+`, `-`, `@`, tab or CR) gets a leading `'` (CSV injection).
 */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const field = (raw: string) => {
    const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  };
  return rows.map((row) => row.map(field).join(',')).join('\r\n') + '\r\n';
}
