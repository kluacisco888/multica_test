import { describe, expect, it } from 'vitest';
import { compareSortKeys } from './sort-key.js';
import {
  buildTaskTree,
  checklistToDescription,
  descriptionToChecklist,
  MAX_TASK_DEPTH,
  planIndent,
  planOutdent,
  type TreeTask,
} from './task-tree.js';

/*
 * Outline helpers: `outline` renders a tree as indented ids, `apply` applies a
 * planned move so the tests read as before / after outlines.
 */

function t(id: string, sortOrder: string, parentId: string | null = null, status: TreeTask['status'] = 'open'): TreeTask {
  return { id, sortOrder, parentId, status };
}

function outline(tasks: TreeTask[]): string[] {
  const out: string[] = [];
  const walk = (nodes: ReturnType<typeof buildTaskTree<TreeTask>>) => {
    for (const n of nodes) {
      out.push(`${'  '.repeat(n.depth - 1)}${n.task.id}`);
      walk(n.children);
    }
  };
  walk(buildTaskTree(tasks));
  return out;
}

function apply(tasks: TreeTask[], id: string, plan: ReturnType<typeof planIndent>): TreeTask[] {
  if (plan.kind !== 'move') throw new Error(`expected a move, got ${plan.kind}`);
  return tasks.map((x) => (x.id === id ? { ...x, parentId: plan.parentId, sortOrder: plan.sortOrder } : x));
}

/** a, b(b1, b2), c */
const sample = () => [t('a', 'G'), t('b', 'N'), t('b1', 'G', 'b'), t('b2', 'V', 'b'), t('c', 'V')];

/** A chain of `n` levels: l1 > l2 > … > ln. */
function chain(n: number): TreeTask[] {
  return Array.from({ length: n }, (_, i) => t(`l${i + 1}`, 'V', i === 0 ? null : `l${i}`));
}

describe('buildTaskTree', () => {
  it('nests children under their parent in sort-key order, depth counted from 1 at the root', () => {
    const tasks = [t('c', 'V'), t('b2', 'V', 'b'), t('a', 'G'), t('b1', 'G', 'b'), t('b', 'N')];
    expect(outline(tasks)).toEqual(['a', 'b', '  b1', '  b2', 'c']);
    const [, b] = buildTaskTree(tasks);
    expect(b?.depth).toBe(1);
    expect(b?.children.map((n) => n.depth)).toEqual([2, 2]);
  });

  it('treats a task whose parent is not in the set as a root (e.g. open child of a filtered-out parent)', () => {
    expect(outline([t('x1', 'G', 'x'), t('a', 'V')])).toEqual(['x1', 'a']);
  });

  it('never loops on corrupt cycles', () => {
    expect(outline([t('p', 'G', 'q'), t('q', 'V', 'p'), t('a', 'G')])).toEqual(['a']);
  });
});

describe('planIndent (Tab)', () => {
  it('makes the task the last child of the sibling above it', () => {
    const s = sample();
    expect(outline(apply(s, 'c', planIndent(s, 'c')))).toEqual(['a', 'b', '  b1', '  b2', '  c']);
    expect(outline(apply(s, 'b', planIndent(s, 'b')))).toEqual(['a', '  b', '    b1', '    b2', 'c']);
    expect(outline(apply(s, 'b2', planIndent(s, 'b2')))).toEqual(['a', 'b', '  b1', '    b2', 'c']);
  });

  it('does nothing for the first sibling', () => {
    const s = sample();
    expect(planIndent(s, 'a')).toEqual({ kind: 'none' });
    expect(planIndent(s, 'b1')).toEqual({ kind: 'none' });
    expect(planIndent(s, 'missing')).toEqual({ kind: 'none' });
  });

  it('only counts siblings accepted by `visible` (Tab in the open section skips completed tasks)', () => {
    const s = [t('a', 'G'), t('done', 'N', null, 'completed'), t('c', 'V')];
    const plan = planIndent(s, 'c', (x) => x.status === 'open');
    expect(plan).toMatchObject({ kind: 'move', parentId: 'a' });
  });

  it(`refuses when the moved subtree would go below level ${MAX_TASK_DEPTH}`, () => {
    // Root is level 1, so l1..l5 is exactly the limit.
    const full = [...chain(5), t('x', 'Z')];
    expect(planIndent(full, 'x')).toMatchObject({ kind: 'move', parentId: 'l1' });
    // x becomes level 2 under l1 – fine. A two-level subtree under l4 would reach level 6.
    const deep = [...chain(4), t('l4b', 'Z', 'l3'), t('l4b1', 'V', 'l4b')];
    expect(planIndent(deep, 'l4b')).toEqual({ kind: 'too-deep' });
    const leaf = [...chain(5), t('l5b', 'Z', 'l4')];
    expect(planIndent(leaf, 'l5b')).toEqual({ kind: 'too-deep' });
  });

  it('places the task after every existing child, including completed ones', () => {
    const s = [t('a', 'G'), t('a1', 'V', 'a', 'completed'), t('b', 'V')];
    const plan = planIndent(s, 'b');
    expect(plan.kind).toBe('move');
    if (plan.kind === 'move') expect(compareSortKeys(plan.sortOrder, 'V')).toBeGreaterThan(0);
  });
});

describe('planOutdent (Shift+Tab)', () => {
  it('makes the task the sibling right after its parent', () => {
    const s = sample();
    expect(outline(apply(s, 'b1', planOutdent(s, 'b1')))).toEqual(['a', 'b', '  b2', 'b1', 'c']);
    const deep = [...sample(), t('b11', 'V', 'b1')];
    expect(outline(apply(deep, 'b11', planOutdent(deep, 'b11')))).toEqual(['a', 'b', '  b1', '  b11', '  b2', 'c']);
  });

  it('does nothing for a root task', () => {
    expect(planOutdent(sample(), 'a')).toEqual({ kind: 'none' });
  });
});

describe('checklist ⇄ description', () => {
  it('turns each non-empty line into a 检查项, stripping list markers', () => {
    expect(descriptionToChecklist('买菜\n\n  - 洗衣服  \n* 拖地\n+ 擦窗\n1. 倒垃圾\n- [ ] 浇花\n- [x] 遛狗\n[X] 喂猫')).toEqual([
      { title: '买菜', completed: false },
      { title: '洗衣服', completed: false },
      { title: '拖地', completed: false },
      { title: '擦窗', completed: false },
      { title: '倒垃圾', completed: false },
      { title: '浇花', completed: false },
      { title: '遛狗', completed: true },
      { title: '喂猫', completed: true },
    ]);
    expect(descriptionToChecklist('')).toEqual([]);
    expect(descriptionToChecklist(' \n\n ')).toEqual([]);
  });

  it('cuts overlong lines to the 检查项 title limit', () => {
    expect(descriptionToChecklist('x'.repeat(600))[0]?.title).toHaveLength(512);
  });

  it('turns 检查项 back into one line each, in order', () => {
    expect(checklistToDescription([{ title: '买菜' }, { title: '洗衣服' }])).toBe('买菜\n洗衣服');
    expect(checklistToDescription([])).toBe('');
  });
});
