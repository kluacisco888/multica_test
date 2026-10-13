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
