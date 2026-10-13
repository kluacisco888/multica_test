import { describe, expect, it } from 'vitest';
import { compareSortKeys, isSortKey, keyBetween, placeAt, SORT_KEY_REBALANCE_LENGTH, sortKeysBetween, spreadSortKeys } from './sort-key.js';

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

describe('spreadSortKeys', () => {
  it.each([1, 2, 61, 62, 1000, 5000])('gives %i short, increasing, valid keys', (n) => {
    const keys = spreadSortKeys(n);
    expect(keys).toHaveLength(n);
    for (let i = 1; i < n; i++) expect(compareSortKeys(keys[i - 1] as string, keys[i] as string)).toBeLessThan(0);
    for (const key of keys) {
      expect(isSortKey(key)).toBe(true);
      expect(key.length).toBeLessThanOrEqual(Math.ceil(Math.log(n + 1) / Math.log(62)) + 1);
    }
  });
});

describe('placeAt (drag-and-drop: insert at a position, rebalancing long keys)', () => {
  /** Apply placeAt to an ordered key list, as the server does. */
  function insert(keys: string[], index: number): string[] {
    const plan = placeAt(keys, index);
    if ('key' in plan) return [...keys.slice(0, index), plan.key, ...keys.slice(index)];
    expect(plan.rebalance).toHaveLength(keys.length + 1);
    return plan.rebalance;
  }

  function expectHealthy(keys: string[]) {
    for (let i = 1; i < keys.length; i++) expect(compareSortKeys(keys[i - 1] as string, keys[i] as string)).toBeLessThan(0);
    for (const key of keys) {
      expect(isSortKey(key)).toBe(true);
      expect(key.length).toBeLessThanOrEqual(SORT_KEY_REBALANCE_LENGTH);
    }
  }

  it('writes only the moved key while there is room', () => {
    expect(placeAt([], 0)).toEqual({ key: 'V' });
    expect(placeAt(['F', 'V'], 1)).toEqual({ key: 'N' });
    expect(placeAt(['F', 'V'], 0)).toEqual({ key: keyBetween(null, 'F') });
    expect(placeAt(['F', 'V'], 2)).toEqual({ key: keyBetween('V', null) });
  });

  it.each([
    ['at the top', () => 0],
    ['right after the first item', () => 1],
    ['at the end', (n: number) => n],
    ['in the middle', (n: number) => Math.floor(n / 2)],
  ])('keeps 1000 inserts %s ordered with bounded key length', (_name, at) => {
    let keys: string[] = ['V'];
    let rebalances = 0;
    for (let i = 0; i < 1000; i++) {
      const plan = placeAt(keys, at(keys.length));
      if ('rebalance' in plan) rebalances++;
      keys = insert(keys, at(keys.length));
    }
    expect(keys).toHaveLength(1001);
    expectHealthy(keys);
    // Rebalancing (rewriting every key) is the rare case, not every drag.
    expect(rebalances).toBeLessThan(100);
  });

  it('rejects an index outside the list', () => {
    expect(() => placeAt(['V'], 2)).toThrow();
    expect(() => placeAt(['V'], -1)).toThrow();
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
