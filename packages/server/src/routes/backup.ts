import type { FastifyInstance } from 'fastify';
import { formatBackupSize, todayIn, type ImportResponse } from '@dida/shared';
import { sessionUser } from '../auth.js';
import { exportTasksCsv } from '../backup/csv.js';
import { BackupTooLarge, exportAccount, type BackupDeps } from '../backup/export.js';
import { importAccount, ImportFailed } from '../backup/import.js';
import { importTickTick } from '../backup/ticktick.js';
import { sendError } from '../http-errors.js';
import type { CredentialCipher } from '../notify/credentials.js';
import { readSettings } from '../settings.js';

/** `20261014`: today in the user's time zone, for file names. */
async function fileDate(app: FastifyInstance, userId: string): Promise<string> {
  return todayIn(app.clock.now(), (await readSettings(app.db, userId)).timeZone).replaceAll('-', '');
}

/**
 * 导入导出 (spec 用户故事 110–112): download the account as JSON, 任务 as
 * CSV, and import a JSON backup into the session user's account. A backup is
 * at most `maxBytes` both ways, and each user builds one export at a time
 * (the whole file is held in memory while it is sent).
 */
export function backupRoutes(app: FastifyInstance, { cipher, maxBytes }: { cipher: CredentialCipher | null; maxBytes: number }) {
  const deps = (): BackupDeps => ({
    db: app.db,
    clock: app.clock,
    sync: app.sync,
    reminders: app.reminders,
    habitReminders: app.habitReminders,
    files: app.attachmentStore,
    cipher,
    maxBytes,
  });
  const exporting = new Set<string>();

  app.get('/api/backup/export', async (request, reply) => {
    const userId = sessionUser(request).id;
    if (exporting.has(userId)) return sendError(reply, 409, 'export_running', '上一个备份还在生成，请稍后再试');
    exporting.add(userId);
    try {
      const doc = await exportAccount(deps(), userId);
      return await reply
        .type('application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="dida-clone-backup-${await fileDate(app, userId)}.json"`)
        .header('cache-control', 'no-store')
        .send(JSON.stringify(doc));
    } catch (error) {
      if (error instanceof BackupTooLarge) {
        return sendError(
          reply,
          413,
          'backup_too_large',
          `备份文件预计约 ${formatBackupSize(error.estimatedBytes)}，超过了导入上限 ${formatBackupSize(error.maxBytes)}，生成了也导不回来。请先删除一些不需要的附件，再生成备份。`,
        );
      }
      throw error;
    } finally {
      exporting.delete(userId);
    }
  });

  app.get('/api/backup/tasks.csv', async (request, reply) => {
    const userId = sessionUser(request).id;
    const csv = await exportTasksCsv(app.db, userId);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="dida-clone-tasks-${await fileDate(app, userId)}.csv"`)
      .header('cache-control', 'no-store')
      // BOM so spreadsheet apps read the Chinese text as UTF-8.
      .send(`\uFEFF${csv}`);
  });

  // 滴答清单 backups are posted as the CSV file itself. The text/csv parser lives in
  // its own encapsulated scope with this one route: every other route keeps the
  // global 1MB body limit for text/csv too (EURO-30 review, PR #41).
  void app.register(async (scope) => {
    scope.addContentTypeParser('text/csv', { parseAs: 'string' }, (_request, body, done) => done(null, body));
    scope.post('/api/backup/import-ticktick', { bodyLimit: maxBytes, onRequest: scope.authenticate }, async (request, reply) => {
      const userId = sessionUser(request).id;
      if (typeof request.body !== 'string') return sendError(reply, 415, 'unsupported_media_type', '请用 text/csv 上传滴答清单的备份文件');
      try {
        return { imported: await importTickTick(deps(), userId, request.body) };
      } catch (error) {
        if (error instanceof ImportFailed) return sendError(reply, 400, 'import_failed', error.message, error.issues);
        throw error;
      }
    });
  });

  // Large body limit, so check the session before the body is read (the
  // usual check runs as a preHandler, after parsing).
  app.post('/api/backup/import', { bodyLimit: maxBytes, onRequest: app.authenticate }, async (request, reply) => {
    const userId = sessionUser(request).id;
    try {
      const imported = await importAccount(deps(), userId, request.body);
      const response: ImportResponse = { imported };
      return response;
    } catch (error) {
      if (error instanceof ImportFailed) return sendError(reply, 400, 'import_failed', error.message, error.issues);
      throw error;
    }
  });
}
