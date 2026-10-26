/** Deterministic checking of student math answers. Never evaluates code; only the safe parser in mathExpr.ts. */
import { MathParseError, evalConstant, expressionsEquivalent, parseExpr, variablesOf } from './mathExpr';
import { parseRelation, relationToSetIsolated, solveRelation } from './relation';
import {
  ALL, EMPTY, RealSet, complement, contains, equalIgnoringClosure, equalSets, formatSet, interval, isPointSet, negate,
  normalize, point, points, pointSubset, union,
} from './realSet';

export type MathSpec =
  | { type: 'math_set'; answer: string; variable?: string; relation?: string }
  | { type: 'math_expr'; answer: string; variable?: string }
  | { type: 'math_number'; answer: string };

export type MathTag = 'sign_error' | 'flipped_inequality' | 'endpoint_inclusion' | 'missing_solution' | 'extraneous_solution' | 'arithmetic_slip';

export interface MathResult {
  status: 'ok' | 'unparseable';
  /** 0..1 */
  correctness: number;
  verdict: 'correct' | 'partial' | 'incorrect' | 'unparseable';
  tags: MathTag[];
  message: string;
}

const NUM = '(?:-?\\s*(?:\\d+\\.?\\d*|\\.\\d+)(?:\\s*/\\s*\\d+\\.?\\d*)?|-?\\s*(?:inf(?:inity)?|∞)|-?\\s*sqrt\\([^)]*\\)|-?\\s*π)';

function parseBound(s: string): number {
  const t = s.trim().toLowerCase().replace(/\s+/g, '');
  if (t === 'inf' || t === '+inf' || t === '∞' || t === '+∞' || t === 'infinity') return Infinity;
  if (t === '-inf' || t === '-∞' || t === '-infinity') return -Infinity;
  return evalConstant(s);
}

/** Parse a student-written solution set. Throws MathParseError when unreadable. */
export function parseSolutionSet(raw: string, variable = 'x'): RealSet {
  let s = raw.trim().replace(/[−–]/g, '-');
  if (!s) throw new MathParseError('empty answer');
  const low = s.toLowerCase().replace(/\.$/, '');
  if (/^(no (real )?solutions?|none|empty set|∅|\{\s*\}|dne)$/.test(low)) return EMPTY;
  if (/^(all real numbers?|all reals?|ℝ|r|any real number|every real number|infinitely many( solutions)?)$/.test(low)) return ALL;
  // relation style: contains a comparison operator
  if (/[<>=≤≥≠]/.test(s)) {
    const rel = parseRelation(s);
    const set = relationToSetIsolated(rel, variable);
    if (!set) throw new MathParseError(`write the answer with ${variable} alone on one side (for example ${variable} > 3)`);
    return set;
  }
  // interval notation, possibly unions:  (-inf, 2] U (5, 9)
  const intervalRe = new RegExp(`([\\(\\[])\\s*(${NUM.replace(/\(\?:/g, '(?:')})\\s*,\\s*(${NUM})\\s*([\\)\\]])`, 'gi');
  const parts = s.split(/\s*(?:∪|\bU\b|\bu\b|\bunion\b)\s*/);
  if (parts.length >= 1 && parts.every((p) => /^[\(\[][^\{\}]*,[^\{\}]*[\)\]]$/.test(p.trim()))) {
    let out: RealSet = EMPTY;
    for (const p of parts) {
      intervalRe.lastIndex = 0;
      const m = intervalRe.exec(p.trim());
      if (!m) throw new MathParseError(`could not read interval "${p}"`);
      const lo = parseBound(m[2]), hi = parseBound(m[3]);
      if (lo > hi) throw new MathParseError('interval endpoints are out of order');
      out = union(out, interval(lo, hi, m[1] === '[', m[4] === ']'));
    }
    return out;
  }
  // finite set / list of numbers:  {1, 2}, 1, 2, or "3 and -2"
  s = s.replace(/^\{|\}$/g, '').replace(/^\{|\}$/g, '');
  const items = s.split(/\s*(?:,|;|\band\b|\bor\b)\s*/i).filter((x) => x.length);
  if (!items.length) throw new MathParseError('empty answer');
  let out: RealSet = EMPTY;
  for (const it of items) {
    const eq = it.match(new RegExp(`^${variable}\\s*=\\s*(.+)$`, 'i'));
    out = union(out, point(evalConstant(eq ? eq[1] : it)));
  }
  return out;
}

function tagsFor(student: RealSet, correct: RealSet): MathTag[] {
  const tags: MathTag[] = [];
  if (isPointSet(correct) && isPointSet(student) && normalize(student).length && normalize(correct).length) {
    if (pointSubset(student, correct) && points(student).length < points(correct).length) tags.push('missing_solution');
    else if (pointSubset(correct, student) && points(student).length > points(correct).length) tags.push('extraneous_solution');
    else if (equalSets(student, negate(correct))) tags.push('sign_error');
    else if (points(student).length === points(correct).length) tags.push('arithmetic_slip');
    return tags;
  }
  if (equalIgnoringClosure(student, correct) && !equalSets(student, correct)) tags.push('endpoint_inclusion');
  else if (equalIgnoringClosure(student, complement(correct))) tags.push('flipped_inequality');
  else if (equalSets(student, negate(correct))) tags.push('sign_error');
  return tags;
}

const TAG_TEXT: Record<MathTag, string> = {
  sign_error: 'Your answer looks like the opposite sign of the correct one — check where a negative sign was lost or added.',
  flipped_inequality: 'The boundary is right but the direction is reversed. Remember to flip the inequality when multiplying or dividing by a negative number (or re-check which side of the boundary works).',
  endpoint_inclusion: 'The endpoints are right, but check whether each one is included (≤, ≥, square bracket) or excluded (<, >, parenthesis).',
  missing_solution: 'You found some solutions but not all of them. Did you consider every case (for example, both the positive and negative case of an absolute value)?',
  extraneous_solution: 'One of your values does not actually work. Substitute each solution back into the original equation to check for extraneous solutions.',
  arithmetic_slip: 'The method may be fine, but at least one value is off. Recheck the arithmetic.',
};

export function checkMath(spec: MathSpec, input: string): MathResult {
  const bad = (m: string): MathResult => ({ status: 'unparseable', correctness: 0, verdict: 'unparseable', tags: [], message: m });
  try {
    if (spec.type === 'math_number') {
      const s = evalConstant(input.replace(/^[a-z]\s*=\s*/i, '')), c = evalConstant(spec.answer);
      const ok = Math.abs(s - c) <= 1e-6 * Math.max(1, Math.abs(c));
      return { status: 'ok', correctness: ok ? 1 : 0, verdict: ok ? 'correct' : 'incorrect', tags: [], message: ok ? 'Correct.' : 'That value is not correct.' };
    }
    if (spec.type === 'math_expr') {
      const v = spec.variable ?? 'x';
      const stripped = input.replace(/^\s*[a-z]\s*\(\s*[a-z]\s*\)\s*=\s*|^\s*y\s*=\s*/i, '');
      const parsed = parseExpr(stripped);
      if ([...variablesOf(parsed)].some((n) => n !== v && !variablesOf(parseExpr(spec.answer)).has(n))) return bad(`Use only the variable ${v}.`);
      const ok = expressionsEquivalent(stripped, spec.answer, v);
      return { status: 'ok', correctness: ok ? 1 : 0, verdict: ok ? 'correct' : 'incorrect', tags: [], message: ok ? 'Correct (equivalent forms are accepted).' : 'That expression is not equivalent to the expected one.' };
    }
    const variable = spec.variable ?? 'x';
    let student: RealSet;
    try { student = parseSolutionSet(input, variable); } catch (e) { return bad(e instanceof MathParseError ? `I couldn't read that answer: ${e.message}.` : "I couldn't read that answer."); }
    const correct = parseSolutionSet(spec.answer, variable);
    if (equalSets(student, correct)) return { status: 'ok', correctness: 1, verdict: 'correct', tags: [], message: 'Correct.' };
    const tags = tagsFor(student, correct);
    const partial = tags.includes('endpoint_inclusion') || tags.includes('missing_solution') || tags.includes('extraneous_solution');
    const detail = tags.length ? tags.map((t) => TAG_TEXT[t]).join(' ') : 'That solution set does not match.';
    return { status: 'ok', correctness: partial ? 0.5 : 0, verdict: partial ? 'partial' : 'incorrect', tags, message: detail };
  } catch (e) {
    return bad(e instanceof MathParseError ? `I couldn't read that answer: ${e.message}.` : "I couldn't read that answer.");
  }
}

export interface VerifyResult { verified: boolean | null; note: string }

/**
 * Independently verify an answer key against a machine-readable relation by numeric solving.
 * `null` = could not verify (kept, but labelled unverified). Sampling-based, not a proof.
 */
export function verifyMathSpec(spec: MathSpec & { relation?: string }): VerifyResult {
  if (spec.type !== 'math_set' || !spec.relation) return { verified: null, note: 'No machine-readable problem statement to verify against.' };
  try {
    const solved = solveRelation(parseRelation(spec.relation), spec.variable ?? 'x');
    if (!solved) return { verified: null, note: 'Problem form not supported by the numeric verifier.' };
    const claimed = parseSolutionSet(spec.answer, spec.variable ?? 'x');
    return equalSets(solved, claimed)
      ? { verified: true, note: 'Answer key matches an independent numeric solve (checked on [-100, 100]).' }
      : { verified: false, note: `Answer key disagrees with numeric solve (solver found ${formatSet(solved)}).` };
  } catch {
    return { verified: null, note: 'Could not parse the problem statement.' };
  }
}

export { contains };
