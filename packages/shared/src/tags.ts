import { z } from 'zod';
import { colorSchema, sortKeySchema } from './lists.js';
import { compareSortKeys } from './sort-key.js';

/*
 * 标签 (spec 用户故事 18、19). Cross-清单 marks; a 任务 can carry several.
 * Like the reference, nesting is one level deep: a 标签 is either top level
 * or the child of a top-level 标签, and a 标签 with children cannot itself
 * become a child. Viewing a parent 标签 includes the tasks of its children.
 */

export const TAG_NAME_MAX_LENGTH = 64;

/**
 * Tag names are typed after `#` by 智能识别 (spec 用户故事 55), so they can
 * contain neither whitespace nor `#`. Unique per user, ignoring case.
 */
export const tagNameSchema = z
  .string()
  .trim()
  .min(1, '名称不能为空')
  .max(TAG_NAME_MAX_LENGTH, `名称最多 ${TAG_NAME_MAX_LENGTH} 个字符`)
  .refine((s) => !/[\s#]/.test(s), '标签名称不能包含空格或 #');

export const tagSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  name: z.string(),
  /** #rrggbb or null (no colour). */
  color: z.string().nullable(),
  /** Parent 标签 (top level when null). */
  parentId: z.uuid().nullable(),
  /** Fractional key; top-level tags and each parent's children have their own order. */
  sortOrder: z.string(),
});
export type Tag = z.infer<typeof tagSchema>;

/** `GET /api/tags`: every live 标签, parents before their children, each level by sort key. */
export const tagsResponseSchema = z.object({ tags: z.array(tagSchema) });
export type TagsResponse = z.infer<typeof tagsResponseSchema>;

export const createTagRequestSchema = z.object({
  id: z.uuid().optional(),
  name: tagNameSchema,
  color: colorSchema.nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  /** Defaults to the end of its level. */
  sortOrder: sortKeySchema.optional(),
});
export type CreateTagRequest = z.input<typeof createTagRequestSchema>;

export const updateTagRequestSchema = z
  .object({
    name: tagNameSchema,
    color: colorSchema.nullable(),
    parentId: z.uuid().nullable(),
    sortOrder: sortKeySchema,
  })
  .partial()
  .strict();
export type UpdateTagRequest = z.input<typeof updateTagRequestSchema>;

/** Minimal shape the tree helpers need. */
export interface TagNode {
  id: string;
  parentId: string | null;
  sortOrder: string;
}

const bySortKey = (a: TagNode, b: TagNode) => compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id);

/**
 * Display order: each top-level 标签 followed by its children. Children whose
 * parent is missing are shown at the top level.
 */
export function orderTags<T extends TagNode>(tags: readonly T[]): T[] {
  const ids = new Set(tags.map((t) => t.id));
  const isRoot = (t: T) => t.parentId === null || !ids.has(t.parentId);
  const out: T[] = [];
  for (const root of tags.filter(isRoot).sort(bySortKey)) {
    out.push(root);
    out.push(...tags.filter((t) => t.parentId === root.id && !isRoot(t)).sort(bySortKey));
  }
  return out;
}

/** The 标签 itself plus its children: viewing a parent 标签 shows the tasks of both. */
export function tagWithChildren(tags: readonly TagNode[], tagId: string): string[] {
  return [tagId, ...tags.filter((t) => t.parentId === tagId && t.id !== tagId).map((t) => t.id)];
}

export type NestingProblem = 'self' | 'parent_missing' | 'parent_is_child' | 'has_children';

/**
 * Why `tagId` (or a new 标签 when null) cannot be put under `parentId`, or
 * null when it can. Nesting is one level: the parent must be top level and
 * a 标签 with children stays top level.
 */
export function nestingProblem(tags: readonly TagNode[], tagId: string | null, parentId: string | null): NestingProblem | null {
  if (parentId === null) return null;
  if (parentId === tagId) return 'self';
  const parent = tags.find((t) => t.id === parentId);
  if (!parent) return 'parent_missing';
  if (parent.parentId !== null) return 'parent_is_child';
  if (tagId !== null && tags.some((t) => t.parentId === tagId)) return 'has_children';
  return null;
}
