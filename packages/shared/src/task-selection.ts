/*
 * 多选 (spec 用户故事 34), like the reference: a plain click selects one task
 * and sets the anchor, Ctrl / Cmd + click adds or removes one task (the anchor
 * stays), Shift + click selects every task from the anchor to the clicked one
 * in the order they are shown, across groups.
 */

export type SelectMode = 'single' | 'toggle' | 'range';

export interface TaskSelection {
  /** Selected task ids, in display order. */
  ids: string[];
  /** Where a Shift + click range starts; null before the first click. */
  anchor: string | null;
}

export const EMPTY_SELECTION: TaskSelection = { ids: [], anchor: null };

/** The selection after clicking `id` with `mode`; `order` is every selectable task id as shown. */
export function selectTask(order: readonly string[], selection: TaskSelection, id: string, mode: SelectMode): TaskSelection {
  const inOrder = (ids: Iterable<string>) => {
    const set = new Set(ids);
    return order.filter((x) => set.has(x));
  };
  if (mode === 'single') return { ids: [id], anchor: id };
  if (mode === 'toggle') {
    const ids = selection.ids.includes(id) ? selection.ids.filter((x) => x !== id) : [...selection.ids, id];
    return { ids: inOrder(ids), anchor: selection.anchor ?? id };
  }
  const anchor = selection.anchor !== null && order.includes(selection.anchor) ? selection.anchor : null;
  if (anchor === null) return { ids: [id], anchor: id };
  const from = order.indexOf(anchor);
  const to = order.indexOf(id);
  if (to === -1) return selection;
  return { ids: order.slice(Math.min(from, to), Math.max(from, to) + 1), anchor };
}

/** 全选 / 取消全选 of one group: all of `groupIds` become selected, or — when they already all are — unselected. */
export function toggleGroup(order: readonly string[], selection: TaskSelection, groupIds: readonly string[]): TaskSelection {
  const all = groupIds.every((id) => selection.ids.includes(id));
  const ids = all ? selection.ids.filter((id) => !groupIds.includes(id)) : [...new Set([...selection.ids, ...groupIds])];
  const set = new Set(ids);
  return { ids: order.filter((x) => set.has(x)), anchor: selection.anchor };
}
