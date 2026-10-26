/**
 * Relations (equations / inequalities, optionally compound) and a numeric solver.
 * Used (a) to verify that an answer key really satisfies the problem and (b) to parse student answers
 * written as "x > 3", "x = 2 or x = -5", "-1 < x <= 4".
 */
import { MathParseError, Node, evalNode, normalizeMathText, parseExpr, variablesOf } from './mathExpr';
import { ALL, EMPTY, RealSet, interval, intersect, point, union, normalize } from './realSet';

export type RelOp = '=' | '<' | '<=' | '>' | '>=' | '!=';
export type Relation =
  | { k: 'atom'; lhs: Node; op: RelOp; rhs: Node }
  | { k: 'and'; parts: Relation[] }
  | { k: 'or'; parts: Relation[] };

const OP_RE = /(<=|>=|≠|!=|==|=<|=>|<|>|=|≤|≥)/;
const canonOp = (s: string): RelOp =>
  s === '≤' || s === '<=' || s === '=<' ? '<=' : s === '≥' || s === '>=' || s === '=>' ? '>=' : s === '≠' || s === '!=' ? '!=' : s === '==' ? '=' : (s as RelOp);

function parseChain(src: string): Relation {
  const pieces = src.split(OP_RE).map((x) => x.trim());
  if (pieces.length < 3 || pieces.length % 2 === 0) throw new MathParseError('not a relation');
  const atoms: Relation[] = [];
  for (let i = 0; i + 2 < pieces.length + 0; i += 2) {
    if (!pieces[i] || !pieces[i + 2]) throw new MathParseError('missing side of relation');
    atoms.push({ k: 'atom', lhs: parseExpr(pieces[i]), op: canonOp(pieces[i + 1]), rhs: parseExpr(pieces[i + 2]) });
  }
  return atoms.length === 1 ? atoms[0] : { k: 'and', parts: atoms };
}

/** Parse "a < x <= b", "x<1 or x>4", "x = 2, x = -3" into a relation tree. */
export function parseRelation(raw: string): Relation {
  const s = normalizeMathText(raw).trim();
  const orParts = s.split(/\s+or\s+|\s*,\s*(?=[^,]*(?:<|>|=|≤|≥|≠))|;|\s*∨\s*/i).filter((x) => x.trim());
  const parse1 = (t: string): Relation => {
    const andParts = t.split(/\s+and\s+|\s*∧\s*|&&/i).filter((x) => x.trim());
    const rs = andParts.map(parseChain);
    return rs.length === 1 ? rs[0] : { k: 'and', parts: rs };
  };
  const rs = orParts.map(parse1);
  return rs.length === 1 ? rs[0] : { k: 'or', parts: rs };
}

export function holds(rel: Relation, env: Record<string, number>, tol = 1e-9): boolean {
  if (rel.k === 'and') return rel.parts.every((p) => holds(p, env, tol));
  if (rel.k === 'or') return rel.parts.some((p) => holds(p, env, tol));
  const d = evalNode(rel.lhs, env) - evalNode(rel.rhs, env);
  if (!Number.isFinite(d)) return false;
  const scale = tol * Math.max(1, Math.abs(evalNode(rel.lhs, env)), Math.abs(evalNode(rel.rhs, env)));
  switch (rel.op) {
    case '=': return Math.abs(d) <= scale;
    case '!=': return Math.abs(d) > scale;
    case '<': return d < -scale;
    case '<=': return d <= scale;
    case '>': return d > scale;
    case '>=': return d >= -scale;
  }
}

function atoms(rel: Relation, acc: Extract<Relation, { k: 'atom' }>[] = []) {
  if (rel.k === 'atom') acc.push(rel); else rel.parts.forEach((p) => atoms(p, acc));
  return acc;
}

export function relationVariables(rel: Relation): Set<string> {
  const v = new Set<string>();
  for (const a of atoms(rel)) { variablesOf(a.lhs, v); variablesOf(a.rhs, v); }
  return v;
}

const RANGE = 100, STEP = 1 / 32;

/** Find critical points (roots / kinks / poles) of lhs-rhs for each atom on [-RANGE, RANGE]. */
function criticalPoints(rel: Relation, v: string): number[] {
  const out: number[] = [];
  for (const a of atoms(rel)) {
    const f = (x: number) => evalNode(a.lhs, { [v]: x }) - evalNode(a.rhs, { [v]: x });
    let px = -RANGE, pf = f(px);
    let ppf = NaN;
    for (let x = -RANGE + STEP; x <= RANGE + 1e-9; x += STEP) {
      const cf = f(x);
      if (Number.isFinite(pf) && Number.isFinite(cf)) {
        if (pf === 0) out.push(px);
        else if (pf * cf < 0) out.push(bisect(f, px, x));
        // tangent root / kink at zero: local minimum of |f| that is ~0
        if (Number.isFinite(ppf) && Math.abs(pf) <= Math.abs(ppf) && Math.abs(pf) <= Math.abs(cf) && Math.abs(pf) < 0.2) {
          const r = minimiseAbs(f, px - STEP, px + STEP);
          if (Math.abs(f(r)) < 1e-9) out.push(r);
        }
      }
      ppf = pf; px = x; pf = cf;
    }
  }
  out.sort((a, b) => a - b);
  const ded: number[] = [];
  for (const x of out) if (!ded.length || Math.abs(x - ded[ded.length - 1]) > 1e-6) ded.push(x);
  return ded;
}

function bisect(f: (x: number) => number, a: number, b: number): number {
  let fa = f(a);
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2, fm = f(m);
    if (fm === 0) return m;
    if (fa * fm < 0) b = m; else { a = m; fa = fm; }
  }
  const r = (a + b) / 2;
  const rr = Math.round(r * 1e9) / 1e9;
  return Math.abs(f(rr)) <= Math.abs(f(r)) ? rr : r;
}
function minimiseAbs(f: (x: number) => number, a: number, b: number): number {
  for (let i = 0; i < 80; i++) {
    const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3;
    if (Math.abs(f(m1)) < Math.abs(f(m2))) b = m2; else a = m1;
  }
  const r = (a + b) / 2;
  const rr = Math.round(r * 1e9) / 1e9;
  return Math.abs(f(rr)) <= Math.abs(f(r)) ? rr : r;
}

/**
 * Numerically solve a one-variable relation over [-100, 100]. Heuristic (grid + bisection), not a proof:
 * roots outside the range or extremely close together can be missed. Returns null if it can't be handled.
 */
export function solveRelation(rel: Relation, variable = 'x'): RealSet | null {
  const vars = relationVariables(rel);
  if (vars.size > 1 || (vars.size === 1 && !vars.has(variable))) return null;
  const T = (x: number) => { try { return holds(rel, { [variable]: x }); } catch { return false; } };
  const crit = criticalPoints(rel, variable);
  if (crit.length > 40) return null;
  if (!crit.length) return T(0) ? ALL : EMPTY;
  let out: RealSet = EMPTY;
  const pieces: RealSet[] = [];
  const bounds = [-Infinity, ...crit, Infinity];
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i], hi = bounds[i + 1];
    const mid = lo === -Infinity ? hi - 1 : hi === Infinity ? lo + 1 : (lo + hi) / 2;
    if (T(mid)) pieces.push(interval(lo, hi, false, false));
  }
  for (const c of crit) if (T(c)) pieces.push(point(c));
  for (const p of pieces) out = union(out, p);
  return normalize(out);
}

/** Convert an "isolated variable" relation (x > 3, 2 <= x, x = 5) into a set. Null if not of that form. */
export function relationToSetIsolated(rel: Relation, variable = 'x'): RealSet | null {
  if (rel.k === 'and') { let s: RealSet = ALL; for (const p of rel.parts) { const t = relationToSetIsolated(p, variable); if (!t) return null; s = intersect(s, t); } return s; }
  if (rel.k === 'or') { let s: RealSet = EMPTY; for (const p of rel.parts) { const t = relationToSetIsolated(p, variable); if (!t) return null; s = union(s, t); } return s; }
  const isVar = (n: Node) => n.t === 'var' && n.name === variable;
  const constant = (n: Node) => { if (variablesOf(n).size) return null; const v = evalNode(n, {}); return Number.isFinite(v) ? v : null; };
  let op = rel.op, c: number | null;
  if (isVar(rel.lhs)) c = constant(rel.rhs);
  else if (isVar(rel.rhs)) { c = constant(rel.lhs); op = ({ '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=', '!=': '!=' } as const)[rel.op]; }
  else return null;
  if (c === null) return null;
  switch (op) {
    case '=': return point(c);
    case '<': return interval(-Infinity, c, false, false);
    case '<=': return interval(-Infinity, c, false, true);
    case '>': return interval(c, Infinity, false, false);
    case '>=': return interval(c, Infinity, true, false);
    case '!=': return union(interval(-Infinity, c, false, false), interval(c, Infinity, false, false));
  }
}
