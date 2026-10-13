import { z } from 'zod';

/*
 * 附件 of a 任务 (spec 用户故事 38): files up to 50MB stored on the data volume,
 * downloaded only by their owner. Synced entity (ADR-0004): UUID, revision,
 * soft delete, served by `/api/changes` as `attachment`.
 *
 * Upload: `POST /api/tasks/:id/attachments?name=<file name>[&id=<uuid>]` with
 * the raw file as the request body and its MIME type as `Content-Type`.
 * Download: `GET /api/attachments/:id/content` (`?download=1` forces a download).
 */

/** Largest accepted file: 50MB. */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export const ATTACHMENT_NAME_MAX_LENGTH = 255;
export const ATTACHMENT_TOO_LARGE_MESSAGE = '单个附件不能超过 50MB';

/** How the web app can preview a file in place; null means download only. */
export type AttachmentPreview = 'image' | 'pdf' | null;

/**
 * Types shown inline in the browser. Deliberately a short allowlist without
 * SVG or HTML: anything else is served as a download so an uploaded file can
 * never run script on this origin.
 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

export function attachmentPreview(mimeType: string): AttachmentPreview {
  if (IMAGE_TYPES.has(mimeType)) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  return null;
}

/** `type/subtype` from a Content-Type header, lower case, without parameters; octet-stream when unusable. */
export function normalizeMimeType(contentType: string | undefined): string {
  const essence = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(essence) ? essence : 'application/octet-stream';
}

export const attachmentSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  taskId: z.uuid(),
  fileName: z.string(),
  mimeType: z.string(),
  /** Bytes. */
  size: z.number().int().nonnegative(),
  preview: z.enum(['image', 'pdf']).nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const uploadAttachmentQuerySchema = z
  .object({
    id: z.uuid().optional(),
    name: z
      .string()
      .trim()
      .min(1, '缺少文件名')
      .max(ATTACHMENT_NAME_MAX_LENGTH, `文件名最多 ${ATTACHMENT_NAME_MAX_LENGTH} 个字符`)
      // Path separators and control characters never belong in a shown file name.
      .refine((name) => ![...name].some((c) => c === '/' || c === '\\' || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f), '文件名不合法'),
  })
  .strict();
export type UploadAttachmentQuery = z.input<typeof uploadAttachmentQuerySchema>;

/** `GET /api/tasks/:id/attachments`: live 附件, oldest first. */
export const attachmentsResponseSchema = z.object({ attachments: z.array(attachmentSchema) });
export type AttachmentsResponse = z.infer<typeof attachmentsResponseSchema>;

/** "1.5 MB"-style size for the attachment card. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}
