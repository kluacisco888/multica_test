import { describe, expect, it } from 'vitest';
import { nestingProblem, orderTags, tagNameSchema, tagWithChildren, type TagNode } from './tags.js';

const tag = (id: string, sortOrder: string, parentId: string | null = null): TagNode => ({ id, sortOrder, parentId });

describe('标签 tree', () => {
  const tags = [tag('work', 'b'), tag('home', 'a'), tag('mail', 'b', 'work'), tag('meet', 'a', 'work'), tag('orphan', 'c', 'gone')];

  it('orders parents by sort key, each followed by its children; orphans are top level', () => {
    expect(orderTags(tags).map((t) => t.id)).toEqual(['home', 'work', 'meet', 'mail', 'orphan']);
  });

  it('a parent 标签 covers its children; a child only itself', () => {
    expect(tagWithChildren(tags, 'work')).toEqual(['work', 'mail', 'meet']);
    expect(tagWithChildren(tags, 'mail')).toEqual(['mail']);
    expect(tagWithChildren(tags, 'home')).toEqual(['home']);
  });

  it('allows one level of nesting only', () => {
    expect(nestingProblem(tags, 'home', null)).toBeNull();
    expect(nestingProblem(tags, 'home', 'work')).toBeNull();
    expect(nestingProblem(tags, null, 'work')).toBeNull();
    expect(nestingProblem(tags, 'work', 'work')).toBe('self');
    expect(nestingProblem(tags, 'home', 'nope')).toBe('parent_missing');
    expect(nestingProblem(tags, 'home', 'mail')).toBe('parent_is_child');
    expect(nestingProblem(tags, 'work', 'home')).toBe('has_children');
  });
});

describe('标签 names', () => {
  it('are trimmed and reject whitespace and #', () => {
    expect(tagNameSchema.parse('  工作 ')).toBe('工作');
    for (const bad of ['', '   ', 'a b', '#x', 'x'.repeat(65)]) expect(tagNameSchema.safeParse(bad).success, bad).toBe(false);
  });
});
