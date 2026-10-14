import { describe, expect, it } from 'vitest';
import { dropAfterId, stepAfterId } from './list-drag.js';

const group = ['a', 'b', 'c', 'd'];

describe('dropAfterId', () => {
  it('turns a drop before / after a row into the task to follow', () => {
    expect(dropAfterId(group, 'd', 'a', 'before')).toBeNull();
    expect(dropAfterId(group, 'd', 'a', 'after')).toBe('a');
    expect(dropAfterId(group, 'a', 'c', 'after')).toBe('c');
    expect(dropAfterId(group, 'a', 'c', 'before')).toBe('b');
    expect(dropAfterId(group, 'c', 'a', 'after')).toBe('a');
  });

  it('ignores drops that change nothing or leave the group', () => {
    expect(dropAfterId(group, 'b', 'b', 'after')).toBeUndefined();
    expect(dropAfterId(group, 'b', 'a', 'after')).toBeUndefined();
    expect(dropAfterId(group, 'b', 'c', 'before')).toBeUndefined();
    expect(dropAfterId(group, 'b', 'x', 'after')).toBeUndefined();
    expect(dropAfterId(group, 'x', 'a', 'after')).toBeUndefined();
  });
});

describe('stepAfterId (Alt + ↑ / ↓)', () => {
  it('moves one place, not past either end', () => {
    expect(stepAfterId(group, 'c', -1)).toBe('a');
    expect(stepAfterId(group, 'b', -1)).toBeNull();
    expect(stepAfterId(group, 'b', 1)).toBe('c');
    expect(stepAfterId(group, 'a', -1)).toBeUndefined();
    expect(stepAfterId(group, 'd', 1)).toBeUndefined();
    expect(stepAfterId(group, 'x', 1)).toBeUndefined();
  });
});
