import { describe, expect, it } from 'vitest';
import { planSidebarDrop, sidebarOutline, type SidebarItems } from './sidebar-order.js';

const F = 'f0000000-0000-4000-8000-000000000001';
const G = 'f0000000-0000-4000-8000-000000000002';

/** Sidebar: [F](a, b) c [G]() d */
function sample(): SidebarItems {
  return {
    folders: [
      { id: F, sortOrder: 'G' },
      { id: G, sortOrder: 'V' },
    ],
    lists: [
      { id: 'inbox', sortOrder: 'V', folderId: null, isInbox: true },
      { id: 'a', sortOrder: 'G', folderId: F, isInbox: false },
      { id: 'b', sortOrder: 'V', folderId: F, isInbox: false },
      { id: 'c', sortOrder: 'N', folderId: null, isInbox: false },
      { id: 'd', sortOrder: 'l', folderId: null, isInbox: false },
    ],
  };
}

/** Apply a planned drop and render the outline with folder ids replaced by names. */
function after(items: SidebarItems, ...args: Parameters<typeof planSidebarDrop>): string[] {
  const plan = planSidebarDrop(items, args[1], args[2], args[3]);
  if (!plan) return ['(no change)'];
  const next: SidebarItems = {
    folders: items.folders.map((f) => (plan.kind === 'folder' && f.id === plan.id ? { ...f, ...plan.patch } : f)),
    lists: items.lists.map((l) => (plan.kind === 'list' && l.id === plan.id ? { ...l, ...plan.patch } : l)),
  };
  return render(next);
}

function render(items: SidebarItems): string[] {
  return sidebarOutline(items).map((e) =>
    e.kind === 'folder' ? `[${e.id === F ? 'F' : 'G'}]` : e.folderId ? `  ${e.id}` : e.id,
  );
}

describe('planSidebarDrop', () => {
  it('outlines the sidebar: folders and top-level 清单 interleaved, children under their folder, no 收件箱', () => {
    expect(render(sample())).toEqual(['[F]', '  a', '  b', 'c', '[G]', 'd']);
  });

  it('reorders 清单 at the top level', () => {
    const s = sample();
    expect(after(s, s, { kind: 'list', id: 'd' }, { kind: 'list', id: 'c' }, 'before')).toEqual(['[F]', '  a', '  b', 'd', 'c', '[G]']);
    expect(after(s, s, { kind: 'list', id: 'c' }, { kind: 'list', id: 'd' }, 'after')).toEqual(['[F]', '  a', '  b', '[G]', 'd', 'c']);
  });

  it('reorders inside a folder and moves 清单 into and out of folders', () => {
    const s = sample();
    expect(after(s, s, { kind: 'list', id: 'b' }, { kind: 'list', id: 'a' }, 'before')).toEqual(['[F]', '  b', '  a', 'c', '[G]', 'd']);
    expect(after(s, s, { kind: 'list', id: 'c' }, { kind: 'list', id: 'a' }, 'after')).toEqual(['[F]', '  a', '  c', '  b', '[G]', 'd']);
    expect(after(s, s, { kind: 'list', id: 'd' }, { kind: 'folder', id: G }, 'inside')).toEqual(['[F]', '  a', '  b', 'c', '[G]', '  d']);
    expect(after(s, s, { kind: 'list', id: 'c' }, { kind: 'folder', id: F }, 'inside')).toEqual(['[F]', '  a', '  b', '  c', '[G]', 'd']);
    expect(after(s, s, { kind: 'list', id: 'a' }, { kind: 'list', id: 'd' }, 'after')).toEqual(['[F]', '  b', 'c', '[G]', 'd', 'a']);
  });

  it('moves folders only at the top level', () => {
    const s = sample();
    expect(after(s, s, { kind: 'folder', id: G }, { kind: 'folder', id: F }, 'before')).toEqual(['[G]', '[F]', '  a', '  b', 'c', 'd']);
    // Dropping a folder onto a 清单 inside a folder places it next to that folder.
    expect(after(s, s, { kind: 'folder', id: G }, { kind: 'list', id: 'a' }, 'before')).toEqual(['[G]', '[F]', '  a', '  b', 'c', 'd']);
    expect(after(s, s, { kind: 'folder', id: F }, { kind: 'list', id: 'd' }, 'after')).toEqual(['c', '[G]', 'd', '[F]', '  a', '  b']);
    // "inside" for a folder means "after" it.
    expect(after(s, s, { kind: 'folder', id: F }, { kind: 'folder', id: G }, 'inside')).toEqual(['c', '[G]', '[F]', '  a', '  b', 'd']);
  });

  it('ignores drops that change nothing or target the dragged item itself', () => {
    const s = sample();
    expect(planSidebarDrop(s, { kind: 'list', id: 'c' }, { kind: 'list', id: 'c' }, 'before')).toBeNull();
    expect(planSidebarDrop(s, { kind: 'list', id: 'a' }, { kind: 'list', id: 'b' }, 'before')).toBeNull();
    expect(planSidebarDrop(s, { kind: 'list', id: 'c' }, { kind: 'list', id: 'b' }, 'after')).not.toBeNull();
    expect(planSidebarDrop(s, { kind: 'list', id: 'inbox' }, { kind: 'list', id: 'c' }, 'before')).toBeNull();
    expect(planSidebarDrop(s, { kind: 'list', id: 'c' }, { kind: 'list', id: 'inbox' }, 'before')).toBeNull();
  });

  it('moves one step up or down for the keyboard alternative', () => {
    const s = sample();
    expect(after(s, s, { kind: 'list', id: 'c' }, { kind: 'folder', id: F }, 'before')).toEqual(['c', '[F]', '  a', '  b', '[G]', 'd']);
  });
});
