import type { FastifyInstance } from 'fastify';
import { BACKUP_IMPORT_MAX_BYTES, todayIn, type ImportResponse } from '@dida/shared';
import { sessionUser } from '../auth.js';
import { exportTasksCsv } from '../backup/csv.js';
import { exportAccount, type BackupDeps } from '../backup/export.js';
import { importAccount, ImportFailed } from '../backup/import.js';
import { sendError } from '../http-errors.js';
import type { CredentialCipher } from '../notify/credentials.js';
import { readSettings } from '../settings.js';

/** `20261014`: today in the user's time zone, for file names. */
async function fileDate(app: FastifyInstance, userId: string): Promise<string> {
  return todayIn(app.clock.now(), (await readSettings(app.db, userId)).timeZone).replaceAll('-', '');
}

/**
 * 导入导出 (spec 用户故事 110–112): download the account as JSON, 任务 as
 * CSV, and import a JSON backup into the session user's account.
 */
export function backupRoutes(app: FastifyInstance, { cipher }: { cipher: CredentialCipher | null }) {
  const deps = (): BackupDeps => ({ db: app.db, clock: app.clock, files: app.attachmentStore, cipher });

  app.get('/api/backup/export', async (request, reply) => {
    const userId = sessionUser(request).id;
    const doc = await exportAccount(deps(), userId);
    return reply
      .type('application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="dida-clone-backup-${await fileDate(app, userId)}.json"`)
      .header('cache-control', 'no-store')
      .send(JSON.stringify(doc));
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

  // Large body limit, so check the session before the body is read (the
  // usual check runs as a preHandler, after parsing).
  app.post('/api/backup/import', { bodyLimit: BACKUP_IMPORT_MAX_BYTES, onRequest: app.authenticate }, async (request, reply) => {
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
