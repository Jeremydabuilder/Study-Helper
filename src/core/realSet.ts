/** Subsets of the real line as unions of intervals/points; used to compare equivalent solution sets. */
export interface Seg { lo: number; hi: number; loClosed: boolean; hiClosed: boolean }
export type RealSet = Seg[];

const EPS = 1e-7;
const same = (a: number, b: number) => a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b)));
const isEmptySeg = (s: Seg) => s.lo > s.hi && !same(s.lo, s.hi) || (same(s.lo, s.hi) && !(s.loClosed && s.hiClosed));

export const EMPTY: RealSet = [];
export const ALL: RealSet = [{ lo: -Infinity, hi: Infinity, loClosed: false, hiClosed: false }];
export const point = (x: number): RealSet => [{ lo: x, hi: x, loClosed: true, hiClosed: true }];
export const interval = (lo: number, hi: number, loClosed: boolean, hiClosed: boolean): RealSet =>
  [{ lo, hi, loClosed: lo === -Infinity ? false : loClosed, hiClosed: hi === Infinity ? false : hiClosed }];

export function normalize(set: RealSet): RealSet {
  const segs = set.filter((s) => !isEmptySeg(s)).map((s) => ({ ...s })).sort((a, b) => a.lo - b.lo || Number(b.loClosed) - Number(a.loClosed));
  const out: Seg[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && (s.lo < last.hi || same(s.lo, last.hi) && (s.loClosed || last.hiClosed))) {
      if (s.hi > last.hi) { last.hi = s.hi; last.hiClosed = s.hiClosed; }
      else if (same(s.hi, last.hi)) last.hiClosed = last.hiClosed || s.hiClosed;
    } else out.push(s);
  }
  return out;
}

export const union = (a: RealSet, b: RealSet) => normalize([...a, ...b]);

export function intersect(a: RealSet, b: RealSet): RealSet {
  const out: Seg[] = [];
  for (const x of a) for (const y of b) {
    let lo = x.lo, loC = x.loClosed;
    if (y.lo > lo || (same(y.lo, lo) && !y.loClosed)) { lo = y.lo; loC = y.loClosed; } else if (same(y.lo, lo)) loC = x.loClosed && y.loClosed;
    let hi = x.hi, hiC = x.hiClosed;
    if (y.hi < hi || (same(y.hi, hi) && !y.hiClosed)) { hi = y.hi; hiC = y.hiClosed; } else if (same(y.hi, hi)) hiC = x.hiClosed && y.hiClosed;
    out.push({ lo, hi, loClosed: loC, hiClosed: hiC });
  }
  return normalize(out);
}

export function complement(a: RealSet): RealSet {
  const n = normalize(a);
  const out: Seg[] = [];
  let cur = -Infinity, curClosed = false; // next uncovered region starts here
  for (const s of n) {
    out.push({ lo: cur, hi: s.lo, loClosed: curClosed, hiClosed: !s.loClosed });
    cur = s.hi; curClosed = !s.hiClosed;
  }
  out.push({ lo: cur, hi: Infinity, loClosed: curClosed, hiClosed: false });
  return normalize(out.map((s) => ({ ...s, loClosed: s.lo === -Infinity ? false : s.loClosed, hiClosed: s.hi === Infinity ? false : s.hiClosed })));
}

export function negate(a: RealSet): RealSet {
  return normalize(a.map((s) => ({ lo: -s.hi, hi: -s.lo, loClosed: s.hiClosed, hiClosed: s.loClosed })));
}

export function equalSets(a: RealSet, b: RealSet): boolean {
  const x = normalize(a), y = normalize(b);
  return x.length === y.length && x.every((s, i) => same(s.lo, y[i].lo) && same(s.hi, y[i].hi) && s.loClosed === y[i].loClosed && s.hiClosed === y[i].hiClosed);
}

/** Same endpoints, ignoring open/closed differences. */
export function equalIgnoringClosure(a: RealSet, b: RealSet): boolean {
  const x = normalize(a), y = normalize(b);
  return x.length === y.length && x.every((s, i) => same(s.lo, y[i].lo) && same(s.hi, y[i].hi));
}

export const isPointSet = (a: RealSet) => normalize(a).every((s) => same(s.lo, s.hi));
export const points = (a: RealSet) => normalize(a).filter((s) => same(s.lo, s.hi)).map((s) => s.lo);

export function contains(a: RealSet, x: number): boolean {
  return a.some((s) => (x > s.lo && x < s.hi) || (s.loClosed && same(x, s.lo)) || (s.hiClosed && same(x, s.hi)));
}

/** Is every element of a also in b (for point sets)? */
export function pointSubset(a: RealSet, b: RealSet): boolean {
  return points(a).every((p) => contains(b, p));
}

const num = (x: number) => (x === Infinity ? '∞' : x === -Infinity ? '-∞' : String(Math.round(x * 1e6) / 1e6));
export function formatSet(a: RealSet): string {
  const n = normalize(a);
  if (!n.length) return '∅ (no solution)';
  if (n.length === 1 && n[0].lo === -Infinity && n[0].hi === Infinity) return 'all real numbers';
  if (isPointSet(n)) return n.map((s) => `x = ${num(s.lo)}`).join(' or ');
  return n.map((s) => (same(s.lo, s.hi) ? `{${num(s.lo)}}` : `${s.loClosed ? '[' : '('}${num(s.lo)}, ${num(s.hi)}${s.hiClosed ? ']' : ')'}`)).join(' ∪ ');
}
