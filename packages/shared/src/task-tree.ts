import { compareSortKeys, keyBetween } from './sort-key.js';

/*
 * 子任务 tree rules and 检查清单 ⇄ 描述 conversion (spec 用户故事 35–37).
 * Pure functions shared by the API (validation) and the web app (Tab /
 * Shift+Tab, outline rendering).
 *
 * Depth is counted with the root task as level 1, so a tree may be at most
 * `MAX_TASK_DEPTH` levels deep including the root.
 */

export const MAX_TASK_DEPTH = 5;
export const DEPTH_EXCEEDED_MESSAGE = `子任务最多 ${MAX_TASK_DEPTH} 层`;
export const CHECKLIST_ITEM_TITLE_MAX_LENGTH = 512;

export interface TreeTask {
  id: string;
  parentId: string | null;
  sortOrder: string;
  status: 'open' | 'completed' | 'abandoned';
}

export interface TaskNode<T extends TreeTask> {
  task: T;
  /** 1 for a root task. */
  depth: number;
  children: TaskNode<T>[];
}

const bySortKey = (a: TreeTask, b: TreeTask) => compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id);

/**
 * Nest `tasks` by `parentId`, siblings in sort-key order. A task whose parent
 * is not among `tasks` is shown as a root; rows caught in a (corrupt) cycle
 * are dropped rather than looping.
 */
export function buildTaskTree<T extends TreeTask>(tasks: readonly T[]): TaskNode<T>[] {
  const ids = new Set(tasks.map((x) => x.id));
  const children = new Map<string | null, T[]>();
  for (const task of tasks) {
    const key = task.parentId !== null && ids.has(task.parentId) ? task.parentId : null;
    children.set(key, [...(children.get(key) ?? []), task]);
  }
  const seen = new Set<string>();
  const build = (parentId: string | null, depth: number): TaskNode<T>[] =>
    [...(children.get(parentId) ?? [])].sort(bySortKey).flatMap((task) => {
      if (seen.has(task.id)) return [];
      seen.add(task.id);
      return [{ task, depth, children: build(task.id, depth + 1) }];
    });
  return build(null, 1);
}

function byId<T extends TreeTask>(tasks: readonly T[]): Map<string, T> {
  return new Map(tasks.map((x) => [x.id, x]));
}

/** Level of `id` (root = 1), following `parentId` within `tasks`. */
export function taskDepth(tasks: readonly TreeTask[], id: string): number {
  const index = byId(tasks);
  let depth = 0;
  let current = index.get(id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    depth++;
    current = current.parentId === null ? undefined : index.get(current.parentId);
  }
  return depth;
}

/** Number of levels in the subtree rooted at `id` (a leaf is 1). */
export function subtreeHeight(tasks: readonly TreeTask[], id: string): number {
  const height = (parentId: string, seen: Set<string>): number => {
    if (seen.has(parentId)) return 0;
    seen.add(parentId);
    const kids = tasks.filter((x) => x.parentId === parentId);
    return 1 + Math.max(0, ...kids.map((k) => height(k.id, seen)));
  };
  return height(id, new Set());
}

export type TreeMovePlan = { kind: 'move'; parentId: string | null; sortOrder: string } | { kind: 'none' } | { kind: 'too-deep' };

function siblingsOf<T extends TreeTask>(tasks: readonly T[], parentId: string | null): T[] {
  return tasks.filter((x) => x.parentId === parentId).sort(bySortKey);
}

/** Key after every current child of `parentId`. */
function endOfChildren(tasks: readonly TreeTask[], parentId: string, excludeId: string): string {
  const last = siblingsOf(tasks, parentId)
    .filter((x) => x.id !== excludeId)
    .at(-1);
  return keyBetween(last?.sortOrder ?? null, null);
}

/**
 * Tab: make `id` the last child of the sibling just above it. Only siblings
 * accepted by `visible` count as "above" (the open section ignores completed
 * tasks). `too-deep` when the moved subtree would pass `MAX_TASK_DEPTH`.
 */
export function planIndent<T extends TreeTask>(tasks: readonly T[], id: string, visible: (task: T) => boolean = () => true): TreeMovePlan {
  const task = byId(tasks).get(id);
  if (!task) return { kind: 'none' };
  const siblings = siblingsOf(tasks, task.parentId).filter((x) => x.id === id || visible(x));
  const index = siblings.findIndex((x) => x.id === id);
  const above = index > 0 ? siblings[index - 1] : undefined;
  if (!above) return { kind: 'none' };
  if (taskDepth(tasks, above.id) + subtreeHeight(tasks, id) > MAX_TASK_DEPTH) return { kind: 'too-deep' };
  return { kind: 'move', parentId: above.id, sortOrder: endOfChildren(tasks, above.id, id) };
}

/** Shift+Tab: make `id` the sibling right after its parent. */
export function planOutdent(tasks: readonly TreeTask[], id: string): TreeMovePlan {
  const index = byId(tasks);
  const task = index.get(id);
  const parent = task?.parentId ? index.get(task.parentId) : undefined;
  if (!task || !parent) return { kind: 'none' };
  const parentSiblings = siblingsOf(tasks, parent.parentId);
  const next = parentSiblings[parentSiblings.findIndex((x) => x.id === parent.id) + 1];
  return { kind: 'move', parentId: parent.parentId, sortOrder: keyBetween(parent.sortOrder, next?.sortOrder ?? null) };
}

/* 检查清单 ⇄ 描述 */

const LIST_MARKER = /^(?:[-*+]\s+|\d+[.)]\s+)?(?:\[([ xX])\]\s*)?/;

/**
 * 描述 → 检查清单: every non-empty line becomes one 检查项; Markdown list
 * markers are dropped and `[x]` marks the item as checked.
 */
export function descriptionToChecklist(description: string): { title: string; completed: boolean }[] {
  return description.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    const marker = LIST_MARKER.exec(trimmed);
    const title = trimmed.slice(marker?.[0].length ?? 0).trim().slice(0, CHECKLIST_ITEM_TITLE_MAX_LENGTH);
    if (!title) return [];
    return [{ title, completed: marker?.[1] === 'x' || marker?.[1] === 'X' }];
  });
}

/** 检查清单 → 描述: one line per 检查项, in order; the checked state is not kept. */
export function checklistToDescription(items: readonly { title: string }[]): string {
  return items.map((item) => item.title).join('\n');
}
