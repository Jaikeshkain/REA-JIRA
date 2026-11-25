/**
 * Minimal LexoRank-style ordering: base-36 strings compared lexicographically.
 * rankBetween(a, b) returns a string strictly between a and b (either may be null = open end),
 * so drag-and-drop updates a single row instead of renumbering a column. (JIRA_REQUIREMENTS §2.2)
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const MIN = DIGITS[0];
const MAX = DIGITS[BASE - 1];

const val = (c: string | undefined, dflt: number) => (c === undefined ? dflt : DIGITS.indexOf(c));

export function rankBetween(a: string | null, b: string | null): string {
  const lo = a ?? '';
  const hi = b ?? '';
  if (a && b && a >= b) throw new Error(`rankBetween: ${a} >= ${b}`);
  let out = '';
  for (let i = 0; ; i++) {
    const l = val(lo[i], 0);
    const h = b === null || i >= hi.length ? BASE : val(hi[i], 0);
    if (l === h) {
      out += DIGITS[l];
      continue;
    }
    const mid = Math.floor((l + h) / 2);
    if (mid > l) return out + DIGITS[mid];
    // adjacent digits: keep l and continue on the next position with an open upper bound
    out += DIGITS[l];
    const rest = rankBetween(lo.slice(i + 1) || null, null);
    return out + rest;
  }
}

/** Evenly spread initial ranks for n items. */
export function initialRanks(n: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    prev = rankBetween(prev, null);
    out.push(prev);
  }
  return out;
}

export { MIN as RANK_MIN, MAX as RANK_MAX };
