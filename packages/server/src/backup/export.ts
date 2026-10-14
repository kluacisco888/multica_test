import { and, asc, eq, ne, sum } from 'drizzle-orm';
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupDocument, type BackupRecord } from '@dida/shared';
import type { AttachmentStore } from '../attachments/store.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { attachments } from '../db/schema/attachments.js';
import type { CredentialCipher } from '../notify/credentials.js';
import { credentialContext } from '../notify/notifier.js';
import type { ReminderService } from '../reminders/scheduler.js';
import type { SyncWriter } from '../sync/sync.js';
import { backupEntities } from './entities.js';

export interface BackupDeps {
  db: Db;
  clock: Clock;
  sync: SyncWriter;
  /** Imported 任务 and 倒数日 get their 提醒 scheduled afresh. */
  reminders: ReminderService;
  files: AttachmentStore;
  /** null when APP_ENCRYPTION_KEY is not set (then there are no 通知渠道 either). */
  cipher: CredentialCipher | null;
  /** Largest backup file, for the export and the import alike. */
  maxBytes: number;
}

/** The backup would be larger than the import accepts; nothing was read into memory. */
export class BackupTooLarge extends Error {
  constructor(
    readonly estimatedBytes: number,
    readonly maxBytes: number,
  ) {
    super('backup too large');
  }
}

async function readFile(files: AttachmentStore, userId: string, id: string): Promise<string | null> {
  const opened = await files.open(userId, id);
  if (!opened) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('base64');
}

/** Characters of `bytes` as base64. */
const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * The whole account of `userId` (spec 用户故事 110): every record of every
 * backed-up table, tombstones included, oldest change first. Read from one
 * snapshot. Two columns change form so the file restores anywhere: a 通知渠道
 * carries its credentials decrypted (they are sealed to the user and record
 * id), an 附件 carries its file as base64 `content` (null when it has none).
 *
 * Before any file is read, the size of the result is worked out from the
 * records and the 附件 sizes in the database; past `maxBytes` (what the
 * import accepts) it throws BackupTooLarge.
 */
export async function exportAccount(deps: BackupDeps, userId: string): Promise<BackupDocument> {
  const { entities, fileBytes } = await deps.db.transaction(
    async (tx) => {
      const out: BackupDocument['entities'] = {};
      for (const { type, table, columns } of backupEntities) {
        const rows = (await tx
          .select()
          .from(table)
          .where(eq(table.userId, userId))
          .orderBy(asc(table.revision), asc(table.id))) as Record<string, unknown>[];
        out[type] = rows.map((row) => {
          const record: BackupRecord = {};
          for (const { key } of columns) {
            const value = row[key];
            record[key] = value instanceof Date ? value.toISOString() : value;
          }
          return record;
        });
      }
      // 附件 that still have a file (彻底删除 empties the name and removes the file).
      const [total] = await tx
        .select({ bytes: sum(attachments.size).mapWith(Number) })
        .from(attachments)
        .where(and(eq(attachments.userId, userId), ne(attachments.fileName, '')));
      return { entities: out, fileBytes: total?.bytes ?? 0 };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );

  for (const record of entities.notificationChannel ?? []) {
    const id = String(record.id);
    try {
      record.credentials = deps.cipher ? deps.cipher.open(String(record.credentials), credentialContext(userId, id)) : null;
    } catch {
      // Sealed with another key: the channel travels without its secrets.
      record.credentials = null;
    }
  }

  const doc: BackupDocument = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: deps.clock.now().toISOString(), entities };
  const attachmentCount = entities.attachment?.length ?? 0;
  // Records as written, plus each file's `"content":"<base64>"` (an upper bound: per-file rounding included).
  const estimatedBytes = Buffer.byteLength(JSON.stringify(doc)) + base64Length(fileBytes) + attachmentCount * (`,"content":""`.length + 4);
  if (estimatedBytes > deps.maxBytes) throw new BackupTooLarge(estimatedBytes, deps.maxBytes);

  for (const record of entities.attachment ?? []) {
    record.content = record.fileName === '' ? null : await readFile(deps.files, userId, String(record.id));
  }
  return doc;
}
