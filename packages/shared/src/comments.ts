import { z } from 'zod';

/*
 * 评论 on a 任务 (spec 用户故事 39): progress notes, written by the 任务's own
 * user (no @ mentions, out of scope). Synced entity (ADR-0004): UUID,
 * revision, soft delete, served by `/api/changes` as `comment`.
 */

export const COMMENT_MAX_LENGTH = 5000;

export const commentSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  taskId: z.uuid(),
  content: z.string(),
  /** When the text was last edited; null if never edited. */
  editedAt: z.iso.datetime().nullable(),
});
export type Comment = z.infer<typeof commentSchema>;

const contentSchema = z
  .string()
  .trim()
  .min(1, '评论不能为空')
  .max(COMMENT_MAX_LENGTH, `评论最多 ${COMMENT_MAX_LENGTH} 个字符`);

export const createCommentRequestSchema = z.object({ id: z.uuid().optional(), content: contentSchema }).strict();
export type CreateCommentRequest = z.input<typeof createCommentRequestSchema>;

export const updateCommentRequestSchema = z.object({ content: contentSchema }).strict();
export type UpdateCommentRequest = z.input<typeof updateCommentRequestSchema>;

/** `GET /api/tasks/:id/comments`: live 评论, oldest first. */
export const commentsResponseSchema = z.object({ comments: z.array(commentSchema) });
export type CommentsResponse = z.infer<typeof commentsResponseSchema>;
