/*
 * 拖拽排序 in the task list (spec 用户故事 32): which `afterId` a drop (or a
 * keyboard move) sends to `POST /api/tasks/:id/move`. `group` is the ids of
 * the tasks the dragged one is ordered with, as shown: its siblings, or the
 * 已置顶 tasks. `undefined` means the drop changes nothing.
 */

/** Dropping `dragged` before / after `target` (both in `group`). */
export function dropAfterId(group: readonly string[], dragged: string, target: string, position: 'before' | 'after'): string | null | undefined {
  if (dragged === target || !group.includes(dragged) || !group.includes(target)) return undefined;
  const others = group.filter((id) => id !== dragged);
  const at = others.indexOf(target) + (position === 'after' ? 1 : 0);
  // Same place as now?
  if (group.indexOf(dragged) === at) return undefined;
  return at === 0 ? null : (others[at - 1] as string);
}

/** Alt + ↑ / ↓: one place up (`-1`) or down (`1`) within `group`. */
export function stepAfterId(group: readonly string[], id: string, step: -1 | 1): string | null | undefined {
  const index = group.indexOf(id);
  if (index === -1) return undefined;
  const next = index + step;
  if (next < 0 || next >= group.length) return undefined;
  return dropAfterId(group, id, group[next] as string, step === 1 ? 'after' : 'before');
}
