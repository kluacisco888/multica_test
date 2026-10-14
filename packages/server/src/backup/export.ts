import { asc, eq } from 'drizzle-orm';
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupDocument, type BackupRecord } from '@dida/shared';
import type { AttachmentStore } from '../attachments/store.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import type { CredentialCipher } from '../notify/credentials.js';
import { credentialContext } from '../notify/notifier.js';
import { backupEntities } from './entities.js';

export interface BackupDeps {
  db: Db;
  clock: Clock;
  files: AttachmentStore;
  /** null when APP_ENCRYPTION_KEY is not set (then there are no 通知渠道 either). */
  cipher: CredentialCipher | null;
}

async function readFile(files: AttachmentStore, userId: string, id: string): Promise<string | null> {
  const opened = await files.open(userId, id);
  if (!opened) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('base64');
}

/**
 * The whole account of `userId` (spec 用户故事 110): every record of every
 * synced table, tombstones included, oldest change first. Read from one
 * snapshot. Two columns change form so the file restores anywhere: a 通知渠道
 * carries its credentials decrypted (they are sealed to the user and record
 * id), an 附件 carries its file as base64 `content` (null when it has none).
 */
export async function exportAccount(deps: BackupDeps, userId: string): Promise<BackupDocument> {
  const entities = await deps.db.transaction(
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
      return out;
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
  for (const record of entities.attachment ?? []) {
    record.content = await readFile(deps.files, userId, String(record.id));
  }

  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: deps.clock.now().toISOString(), entities };
}
