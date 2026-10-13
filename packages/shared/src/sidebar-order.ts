import { compareSortKeys, keyBetween } from './sort-key.js';

/*
 * Sidebar drag-and-drop rules (spec 用户故事 15). The top level interleaves
 * 文件夹 and 清单 outside folders by sort key; 清单 inside a 文件夹 have their own
 * order. 文件夹 are one level deep, so a 文件夹 can only move at the top level.
 * The 收件箱 is fixed and takes no part.
 */

export interface SidebarItems {
  folders: { id: string; sortOrder: string }[];
  lists: { id: string; sortOrder: string; folderId: string | null; isInbox: boolean }[];
}

export type SidebarItemRef = { kind: 'list' | 'folder'; id: string };
export type DropPosition = 'before' | 'after' | 'inside';

export type SidebarOutlineEntry =
  | { kind: 'folder'; id: string; sortOrder: string }
  | { kind: 'list'; id: string; sortOrder: string; folderId: string | null };

export interface SidebarMove {
  kind: 'list' | 'folder';
  id: string;
  patch: { sortOrder: string; folderId?: string | null };
}

const byKey = (a: { sortOrder: string; id: string }, b: { sortOrder: string; id: string }) =>
  compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id);

function topLevel(items: SidebarItems): SidebarOutlineEntry[] {
  return [
    ...items.folders.map((f) => ({ kind: 'folder' as const, id: f.id, sortOrder: f.sortOrder })),
    ...items.lists
      .filter((l) => !l.isInbox && l.folderId === null)
      .map((l) => ({ kind: 'list' as const, id: l.id, sortOrder: l.sortOrder, folderId: null })),
  ].sort(byKey);
}

function childrenOf(items: SidebarItems, folderId: string): SidebarOutlineEntry[] {
  return items.lists
    .filter((l) => !l.isInbox && l.folderId === folderId)
    .map((l) => ({ kind: 'list' as const, id: l.id, sortOrder: l.sortOrder, folderId }))
    .sort(byKey);
}

/** Sidebar entries in display order (folder children right after their folder). */
export function sidebarOutline(items: SidebarItems): SidebarOutlineEntry[] {
  return topLevel(items).flatMap((entry) => (entry.kind === 'folder' ? [entry, ...childrenOf(items, entry.id)] : [entry]));
}

/**
 * The single write that drops `dragged` relative to `target`, or null when the
 * drop is not allowed or would not change anything.
 */
export function planSidebarDrop(
  items: SidebarItems,
  dragged: SidebarItemRef,
  target: SidebarItemRef,
  position: DropPosition,
): SidebarMove | null {
  if (dragged.kind === target.kind && dragged.id === target.id) return null;
  const listById = new Map(items.lists.map((l) => [l.id, l]));
  if (dragged.kind === 'list' && !listById.get(dragged.id)) return null;
  if (dragged.kind === 'list' && listById.get(dragged.id)?.isInbox) return null;
  if (target.kind === 'list' && (!listById.get(target.id) || listById.get(target.id)?.isInbox)) return null;
  if (dragged.kind === 'folder' && !items.folders.some((f) => f.id === dragged.id)) return null;

  // Resolve the level (folder id or null for top level) and the anchor entry in it.
  let level: string | null;
  let anchor: SidebarItemRef;
  let where: 'before' | 'after' | 'end';
  if (target.kind === 'folder') {
    if (position === 'inside' && dragged.kind === 'list') {
      level = target.id;
      anchor = target;
      where = 'end';
    } else {
      level = null;
      anchor = target;
      where = position === 'before' ? 'before' : 'after';
    }
  } else {
    const targetFolder = listById.get(target.id)?.folderId ?? null;
    if (dragged.kind === 'folder' && targetFolder !== null) {
      level = null;
      anchor = { kind: 'folder', id: targetFolder };
    } else {
      level = targetFolder;
      anchor = target;
    }
    where = position === 'before' ? 'before' : 'after';
  }

  const current = level === null ? topLevel(items) : childrenOf(items, level);
  const siblings = current.filter((e) => !(e.kind === dragged.kind && e.id === dragged.id));
  let index: number;
  if (where === 'end') {
    index = siblings.length;
  } else {
    const at = siblings.findIndex((e) => e.kind === anchor.kind && e.id === anchor.id);
    if (at < 0) return null;
    index = where === 'before' ? at : at + 1;
  }

  const currentFolder = dragged.kind === 'list' ? (listById.get(dragged.id)?.folderId ?? null) : null;
  if (currentFolder === level) {
    const was = current.findIndex((e) => e.kind === dragged.kind && e.id === dragged.id);
    if (was === index) return null; // same neighbours: nothing to write
  }

  let sortOrder: string;
  try {
    sortOrder = keyBetween(siblings[index - 1]?.sortOrder ?? null, siblings[index]?.sortOrder ?? null);
  } catch {
    return null; // neighbours share a key (concurrent appends): no room between them
  }
  return dragged.kind === 'list'
    ? { kind: 'list', id: dragged.id, patch: { sortOrder, folderId: level } }
    : { kind: 'folder', id: dragged.id, patch: { sortOrder } };
}
