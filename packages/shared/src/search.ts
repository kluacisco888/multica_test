import { z } from 'zod';
import { taskSchema } from './tasks.js';

/*
 * 全局搜索 (spec 用户故事 63): finds 任务 by title, 描述, 检查项 and 评论,
 * in every 清单 — including 清单 with 不进智能清单 on and 归档 清单. Deleted
 * tasks (回收站) are not searched.
 */

export const SEARCH_QUERY_MAX_LENGTH = 100;
/** At most this many tasks are returned, open ones first. */
export const SEARCH_RESULT_LIMIT = 200;

export const searchQuerySchema = z
  .object({ q: z.string().trim().min(1, '请输入搜索内容').max(SEARCH_QUERY_MAX_LENGTH, `最多 ${SEARCH_QUERY_MAX_LENGTH} 个字符`) })
  .strict();

/** Where a task matched; a task can match in several places. */
export const SEARCH_MATCH_FIELDS = ['title', 'description', 'checklist', 'comment'] as const;
export const searchMatchFieldSchema = z.enum(SEARCH_MATCH_FIELDS);
export type SearchMatchField = z.infer<typeof searchMatchFieldSchema>;

export const searchResponseSchema = z.object({
  tasks: z.array(taskSchema),
  /** Task id → fields that matched. */
  matches: z.record(z.string(), z.array(searchMatchFieldSchema)),
  /** True when more than `SEARCH_RESULT_LIMIT` tasks matched. */
  truncated: z.boolean(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
