import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { link, mkdir, readdir, rm, stat } from 'node:fs/promises';
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

/** A file for this attachment id already exists (another upload with the same client id won). */
export class AttachmentExistsError extends Error {
  constructor() {
    super('attachment file exists');
  }
}

export interface AttachmentStore {
  /** Root directory, `<dataDir>/attachments`. */
  readonly root: string;
  /**
   * Stream `body` into the file of (`userId`, `id`), at most `maxBytes`.
   * Throws FileTooLargeError (and keeps nothing) when the body is larger.
   * Throws AttachmentExistsError when the file of this id already exists:
   * an existing file is never replaced. Returns the byte count. The file only
   * appears once fully written; on success the caller owns it.
   */
  write(userId: string, id: string, body: Readable, maxBytes: number): Promise<number>;
  open(userId: string, id: string): Promise<{ stream: ReadStream; size: number } | null>;
  remove(userId: string, id: string): Promise<void>;
  /** Attachment ids that have a file, per user; only `userId`'s when given. */
  list(userId?: string): Promise<{ userId: string; id: string }[]>;
  /** Delete partial uploads left by a crash; call once at startup, before serving. */
  cleanIncoming(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Entry names of a directory; none when it does not exist. */
async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function createAttachmentStore(dataDir: string): AttachmentStore {
  const root = path.resolve(dataDir, 'attachments');
  // Partial uploads; same file system as the final location so link is atomic.
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
        // link (unlike rename) fails with EEXIST instead of replacing a file
        // another request with the same id has already put there.
        await link(temp, target).catch((error: NodeJS.ErrnoException) => {
          throw error.code === 'EEXIST' ? new AttachmentExistsError() : error;
        });
      } finally {
        await rm(temp, { force: true });
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
    async list(userId) {
      const users = userId ? [userId.toLowerCase()] : await names(root);
      const files: { userId: string; id: string }[] = [];
      for (const user of users) {
        if (!UUID.test(user)) continue;
        for (const id of await names(path.join(root, user))) {
          if (UUID.test(id)) files.push({ userId: user, id });
        }
      }
      return files;
    },
    async cleanIncoming() {
      await rm(incoming, { recursive: true, force: true });
    },
  };
}
