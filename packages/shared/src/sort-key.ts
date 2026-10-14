/**
 * Fractional sort keys (spec: 拖拽排序用分数排序键). A key is a base-62 string;
 * items sort by plain code-unit comparison of their keys, and a new key can
 * always be made between two neighbours, so a drag writes only the moved row.
 *
 * Keys never end in "0" (the smallest digit), which guarantees there is always
 * room before any key.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const SORT_KEY_MAX_LENGTH = 128;
const SORT_KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

export function isSortKey(value: string): boolean {
  return value.length <= SORT_KEY_MAX_LENGTH && SORT_KEY.test(value);
}

/** Code-unit order (not locale order): use this wherever sort keys are compared. */
export function compareSortKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Midpoint of two digit strings; `b === null` means "no upper bound". */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0] as string) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0] as string) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)] as string;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return (DIGITS[digitA] as string) + midpoint(a.slice(1), null);
}

/** A key strictly between `before` and `after`; null means the start / end of the list. */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && compareSortKeys(before, after) >= 0) {
    throw new Error(`sort keys out of order: ${before} >= ${after}`);
  }
  return midpoint(before ?? '', after);
}

/** `n` increasing keys strictly between `before` and `after`. */
export function sortKeysBetween(before: string | null, after: string | null, n: number): string[] {
  const keys: string[] = [];
  let previous = before;
  for (let i = 0; i < n; i++) {
    previous = keyBetween(previous, after);
    keys.push(previous);
  }
  return keys;
}

/**
 * Longest key `placeAt` hands out. Dropping again and again at the same spot
 * grows a key by about one digit every 6 drops; past this length the whole
 * group is given fresh, evenly spread keys instead.
 */
export const SORT_KEY_REBALANCE_LENGTH = 16;

/** `n` increasing keys spread evenly over the key space, each as short as `n` allows (plus one digit of headroom). */
export function spreadSortKeys(n: number): string[] {
  if (n <= 0) return [];
  let length = 1;
  while (DIGITS.length ** length < n + 1) length++;
  length++; // room for a few drops between neighbours before keys grow
  const space = BigInt(DIGITS.length) ** BigInt(length);
  const base = BigInt(DIGITS.length);
  const keys: string[] = [];
  for (let i = 1; i <= n; i++) {
    let value = (space * BigInt(i)) / BigInt(n + 1);
    let key = '';
    for (let d = 0; d < length; d++) {
      key = (DIGITS[Number(value % base)] as string) + key;
      value /= base;
    }
    // Trailing zeros carry no value; keys never end in "0".
    keys.push(key.replace(/0+$/, ''));
  }
  return keys;
}

/**
 * Where a dragged item lands at `index` of `keys` (the ordered keys of the
 * other items in its group): normally one new key, so only the moved row is
 * written; when that key would be longer than `SORT_KEY_REBALANCE_LENGTH`,
 * fresh keys for the whole group in its new order (`keys.length + 1` keys,
 * the moved item's at `index`).
 */
export function placeAt(keys: readonly string[], index: number): { key: string } | { rebalance: string[] } {
  if (!Number.isInteger(index) || index < 0 || index > keys.length) throw new Error(`index ${index} outside 0–${keys.length}`);
  const key = keyBetween(keys[index - 1] ?? null, keys[index] ?? null);
  if (key.length <= SORT_KEY_REBALANCE_LENGTH) return { key };
  return { rebalance: spreadSortKeys(keys.length + 1) };
}
