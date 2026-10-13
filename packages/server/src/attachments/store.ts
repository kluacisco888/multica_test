import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/*
 * Files of 附件 on the data volume: `<dataDir>/attachments/<userId>/<attachmentId>`.
 * That directory is what scripts/backup.sh archives as attachments.tar and
 * scripts/restore.sh puts back, so a backup always carries the files.
 * Names on disk are only UUIDs (validated by the routes); the user's file
 * name lives in the database.
 */

export class FileTooLargeError extends Error {
  constructor() {
    super('file too large');
  }
}

export interface AttachmentStore {
  /** Root directory, `<dataDir>/attachments`. */
  readonly root: string;
  /**
   * Stream `body` into the file of (`userId`, `id`), at most `maxBytes`.
   * Throws FileTooLargeError (and keeps nothing) when the body is larger.
   * Returns the byte count. The file only appears once fully written.
   */
  write(userId: string, id: string, body: Readable, maxBytes: number): Promise<number>;
  open(userId: string, id: string): Promise<{ stream: ReadStream; size: number } | null>;
  remove(userId: string, id: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAttachmentStore(dataDir: string): AttachmentStore {
  const root = path.resolve(dataDir, 'attachments');
  // Partial uploads; same file system as the final location so rename is atomic.
  const incoming = path.join(root, '.incoming');

  function fileOf(userId: string, id: string): string {
    if (!UUID.test(userId) || !UUID.test(id)) throw new Error('attachment ids must be UUIDs');
    return path.join(root, userId.toLowerCase(), id.toLowerCase());
  }

  return {
    root,
    async write(userId, id, body, maxBytes) {
      const target = fileOf(userId, id);
      await mkdir(incoming, { recursive: true });
      await mkdir(path.dirname(target), { recursive: true });
      const temp = path.join(incoming, randomUUID());
      let size = 0;
      // Past the limit, keep reading but drop the bytes, so the client still
      // receives the 413 instead of a reset connection. A body far beyond the
      // limit is cut off.
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > maxBytes * 2) done(new FileTooLargeError());
          else done(null, size > maxBytes ? undefined : chunk);
        },
      });
      try {
        await pipeline(body, limit, createWriteStream(temp, { flags: 'wx' }));
        if (size > maxBytes) throw new FileTooLargeError();
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      return size;
    },
    async open(userId, id) {
      const file = fileOf(userId, id);
      try {
        const { size } = await stat(file);
        return { stream: createReadStream(file), size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async remove(userId, id) {
      await rm(fileOf(userId, id), { force: true });
    },
  };
}
