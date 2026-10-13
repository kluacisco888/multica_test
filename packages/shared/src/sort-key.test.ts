import { describe, expect, it } from 'vitest';
import { compareSortKeys, isSortKey, keyBetween, sortKeysBetween } from './sort-key.js';

describe('keyBetween (fractional sort keys for drag-and-drop)', () => {
  it('gives a first key when the list is empty', () => {
    expect(keyBetween(null, null)).toBe('V');
  });

  it('puts a key after the last or before the first', () => {
    expect(keyBetween('V', null)).toBe('l');
    expect(keyBetween(null, 'V')).toBe('G');
  });

  it('finds a key between two neighbours, growing only when they are adjacent', () => {
    expect(keyBetween('F', 'V')).toBe('N');
    expect(keyBetween('a', 'b')).toBe('aV');
    expect(keyBetween('aV', 'b')).toBe('al');
  });

  it('keeps inserting at the same spot without ever colliding', () => {
    // Repeatedly drop an item right after "a" (worst case for key length).
    let upper = 'b';
    const keys: string[] = [];
    for (let i = 0; i < 200; i++) {
      upper = keyBetween('a', upper);
      keys.push(upper);
    }
    expect(new Set(keys).size).toBe(200);
    for (const key of keys) {
      expect(compareSortKeys('a', key)).toBeLessThan(0);
      expect(compareSortKeys(key, 'b')).toBeLessThan(0);
      expect(isSortKey(key)).toBe(true);
    }
    // Repeatedly dropping before the first item also stays valid.
    let lower = 'V';
    for (let i = 0; i < 200; i++) {
      const next = keyBetween(null, lower);
      expect(compareSortKeys(next, lower)).toBeLessThan(0);
      expect(isSortKey(next)).toBe(true);
      lower = next;
    }
  });

  it('rejects bounds that are out of order', () => {
    expect(() => keyBetween('b', 'a')).toThrow();
    expect(() => keyBetween('a', 'a')).toThrow();
  });
});

describe('sortKeysBetween', () => {
  it('returns n increasing keys strictly between the bounds', () => {
    const keys = sortKeysBetween('F', 'G', 5);
    expect(keys).toHaveLength(5);
    expect([...keys].sort(compareSortKeys)).toEqual(keys);
    expect(compareSortKeys('F', keys[0] as string)).toBeLessThan(0);
    expect(compareSortKeys(keys[4] as string, 'G')).toBeLessThan(0);
  });
});

describe('isSortKey', () => {
  it.each(['V', 'aV', 'z', '0V'])('accepts %j', (key) => expect(isSortKey(key)).toBe(true));
  it.each(['', 'a0', ' a', 'a-b', 'é', 'a'.repeat(129)])('rejects %j', (key) => expect(isSortKey(key)).toBe(false));
});

describe('compareSortKeys', () => {
  it('orders by code unit, not by locale (upper case before lower case)', () => {
    expect(['b', 'B', 'a', 'A', '1'].sort(compareSortKeys)).toEqual(['1', 'A', 'B', 'a', 'b']);
  });
});
