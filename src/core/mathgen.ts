/**
 * Deterministic, provider-independent math problem generators. Answers are computed exactly (rationals)
 * and every generated problem carries a machine-readable `relation` so tests can cross-check with the
 * numeric solver. This gives unlimited fresh variants for transfer / held-out checks without model calls.
 */
import { Frac } from './rational';

export interface GeneratedProblem {
  prompt: string;
  spec: { type: 'math_set'; answer: string; variable: 'x'; relation?: string };
  hints: [string, string];
  workedExample: string;
  explanation: string;
  difficulty: 1 | 2 | 3;
  family: string;
}

export const MATH_SKILLS = {
  'math.linear_equation': 'Solving linear equations',
  'math.linear_inequality': 'Solving linear inequalities',
  'math.compound_inequality': 'Compound inequalities',
  'math.abs_equation': 'Absolute value equations',
  'math.abs_inequality': 'Absolute value inequalities',
  'math.sets': 'Sets and set operations',
} as const;
export type MathSkill = keyof typeof MATH_SKILLS;
export const isMathSkill = (s: string | null | undefined): s is MathSkill => !!s && s in MATH_SKILLS;

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = () => number;
const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const nz = (r: R, lo: number, hi: number) => { let v = 0; while (v === 0) v = int(r, lo, hi); return v; };
const pick = <T,>(r: R, xs: T[]) => xs[Math.floor(r() * xs.length)];

/** "3x", "-x", "x", "0" style rendering of a·x + b */
function lin(a: number, b: number): string {
  const ax = a === 0 ? '' : a === 1 ? 'x' : a === -1 ? '-x' : `${a}x`;
  if (a === 0) return String(b);
  if (b === 0) return ax;
  return `${ax} ${b < 0 ? '-' : '+'} ${Math.abs(b)}`;
}
const solStr = (f: Frac) => `x = ${f}`;

function linearEquation(r: R, d: 1 | 2 | 3): GeneratedProblem {
  if (d === 1) {
    const sol = new Frac(nz(r, -9, 9));
    const a = nz(r, 2, 9), b = nz(r, -12, 12);
    const rhs = sol.mul(a).add(b);
    const rel = `${lin(a, b)} = ${rhs}`;
    return {
      prompt: `Solve for x: ${rel}`, spec: { type: 'math_set', answer: solStr(sol), variable: 'x', relation: rel },
      hints: ['Undo the addition or subtraction first.', `Subtract ${b} from both sides, then divide both sides by ${a}.`],
      workedExample: `Solve 3x + 4 = 19. Subtract 4: 3x = 15. Divide by 3: x = 5. Check: 3(5)+4 = 19 ✓.`,
      explanation: `Whatever you do to one side you must do to the other. Undo the ${b < 0 ? 'subtraction' : 'addition'} first, then undo the multiplication by ${a}. Answer: ${solStr(sol)}.`,
      difficulty: 1, family: 'linear_equation.one_side',
    };
  }
  // variables on both sides:  a x + b = c x + e
  const a = nz(r, -8, 9), c = pick(r, [-6, -4, -3, -2, 1, 2, 3, 5].filter((v) => v !== a)), b = int(r, -10, 10);
  const e = d === 2 ? (a - c) * nz(r, -6, 6) + b : int(r, -12, 12);
  const sol = new Frac(e - b, a - c);
  const rel = `${lin(a, b)} = ${lin(c, e)}`;
  return {
    prompt: `Solve for x: ${rel}`, spec: { type: 'math_set', answer: solStr(sol), variable: 'x', relation: rel },
    hints: ['Get all the x-terms on one side and the plain numbers on the other.', `Subtract ${lin(c, 0)} from both sides first, then isolate x.`],
    workedExample: `Solve 5x + 2 = 2x + 14. Subtract 2x: 3x + 2 = 14. Subtract 2: 3x = 12. Divide by 3: x = 4. Check: 5(4)+2 = 22 and 2(4)+14 = 22 ✓.`,
    explanation: `Collect x-terms on one side (subtract ${lin(c, 0)}), move constants to the other, then divide. Answer: ${solStr(sol)}${sol.isInt() ? '' : ' (a fraction is fine)'}. Always substitute back to check.`,
    difficulty: d, family: 'linear_equation.both_sides',
  };
}

const OPS = [
  { s: '<', f: (c: Frac) => `x < ${c}`, flip: '>' }, { s: '<=', f: (c: Frac) => `x <= ${c}`, flip: '>=' },
  { s: '>', f: (c: Frac) => `x > ${c}`, flip: '<' }, { s: '>=', f: (c: Frac) => `x >= ${c}`, flip: '<=' },
];
function linearInequality(r: R, d: 1 | 2 | 3): GeneratedProblem {
  const neg = d >= 2 ? r() < 0.7 : false;
  const a = neg ? -nz(r, 2, 7) : nz(r, 2, 7) , b = int(r, -9, 9);
  const op = pick(r, OPS);
  const bound = new Frac(int(r, -8, 8));
  const rhs = bound.mul(a).add(b);
  const rel = `${lin(a, b)} ${op.s} ${rhs}`;
  const finalOp = a < 0 ? OPS.find((o) => o.s === op.flip)! : op;
  const ans = finalOp.f(bound);
  return {
    prompt: `Solve the inequality and write the solution as an inequality (for example x > 2): ${rel}`,
    spec: { type: 'math_set', answer: ans, variable: 'x', relation: rel },
    hints: [a < 0 ? 'Solve like an equation — but what happens when you divide by a negative number?' : 'Solve like an equation: undo addition, then undo multiplication.', a < 0 ? `Dividing by ${a} reverses the direction of the inequality sign.` : `Subtract ${b} from both sides, then divide both sides by ${a}.`],
    workedExample: `Solve -2x + 3 < 11. Subtract 3: -2x < 8. Divide by -2 and FLIP the sign: x > -4. Check x = 0: -2(0)+3 = 3 < 11 ✓.`,
    explanation: `Multiplying or dividing both sides by a negative number reverses the inequality. ${a < 0 ? `Here you divide by ${a}, so the sign flips.` : `Here you divide by ${a} (positive), so the sign stays.`} Answer: ${ans}.`,
    difficulty: d, family: a < 0 ? 'linear_inequality.negative_coefficient' : 'linear_inequality.positive_coefficient',
  };
}

function compoundInequality(r: R, d: 1 | 2 | 3): GeneratedProblem {
  const a = nz(r, 2, 5), b = int(r, -5, 5);
  const lo = int(r, -4, 2), hi = lo + int(r, 2, 6);
  const loV = a * lo + b, hiV = a * hi + b;
  const closedLo = r() < 0.5, closedHi = r() < 0.5;
  if (d === 3 && r() < 0.5) {
    // "or" form: ax+b < loV or ax+b > hiV
    const rel = `${lin(a, b)} < ${loV} or ${lin(a, b)} > ${hiV}`;
    const ans = `x < ${lo} or x > ${hi}`;
    return {
      prompt: `Solve and write the solution as inequalities joined by "or": ${rel}`,
      spec: { type: 'math_set', answer: ans, variable: 'x', relation: rel },
      hints: ['Solve each inequality separately.', `Solve ${lin(a, b)} < ${loV} and ${lin(a, b)} > ${hiV} on their own; the answer is "either/or".`],
      workedExample: `Solve 2x < -2 or 2x > 6. First: x < -1. Second: x > 3. The solution is x < -1 or x > 3 (two separate pieces).`,
      explanation: `An "or" inequality is the union of two solution sets. Answer: ${ans}.`,
      difficulty: 3, family: 'compound_inequality.or',
    };
  }
  const l = closedLo ? '<=' : '<', h = closedHi ? '<=' : '<';
  const rel = `${loV} ${l} ${lin(a, b)} ${h} ${hiV}`;
  const ans = `${lo} ${l} x ${h} ${hi}`;
  return {
    prompt: `Solve the compound inequality and write it as lo < x < hi (use ≤ where included): ${rel}`,
    spec: { type: 'math_set', answer: ans, variable: 'x', relation: rel },
    hints: ['Do the same operation to all three parts.', `Subtract ${b} from all three parts, then divide all three by ${a}.`],
    workedExample: `Solve 1 < 2x + 3 ≤ 9. Subtract 3 from all parts: -2 < 2x ≤ 6. Divide by 2: -1 < x ≤ 3. Endpoint -1 is excluded (<), 3 is included (≤).`,
    explanation: `Treat all three parts the same way. Keep each sign (< or ≤) as it was because ${a} is positive. Answer: ${ans}.`,
    difficulty: Math.max(2, d) as 2 | 3, family: 'compound_inequality.and',
  };
}

function absEquation(r: R, d: 1 | 2 | 3): GeneratedProblem {
  if (d === 3 && r() < 0.6) {
    // |x + a| = s x + t, check for extraneous
    for (let tries = 0; tries < 50; tries++) {
      const a = int(r, -6, 6), s = pick(r, [2, 3, -1, 2]), t = int(r, -9, 9);
      const cands: Frac[] = [];
      if (s !== 1) cands.push(new Frac(t - a, 1 - s)); // x + a = s x + t
      if (s !== -1) cands.push(new Frac(-a - t, 1 + s)); // -(x + a) = s x + t
      const valid = cands.filter((x) => Math.abs(x.num() + a) === s * x.num() + t && s * x.num() + t >= 0);
      const uniq = valid.filter((x, i) => valid.findIndex((y) => y.eq(x)) === i);
      if (cands.length === 2 && uniq.length < cands.length && uniq.length >= 0 && cands.every((c) => Number.isInteger(c.num()))) {
        const rel = `|x ${a < 0 ? '-' : '+'} ${Math.abs(a)}| = ${lin(s, t)}`;
        const ans = uniq.length ? uniq.map(solStr).join(' or ') : 'no solution';
        return {
          prompt: `Solve for x, and check every candidate in the original equation: ${rel}`,
          spec: { type: 'math_set', answer: ans, variable: 'x', relation: rel },
          hints: ['Split into two cases: the inside equals the right side, or the opposite of the inside equals the right side.', 'Plug each candidate back in. An absolute value can never equal a negative number.'],
          workedExample: `Solve |x + 1| = 2x - 4. Case 1: x + 1 = 2x - 4 → x = 5. Case 2: -(x + 1) = 2x - 4 → x = 1. Check x = 5: |6| = 6 ✓. Check x = 1: |2| = -2 ✗ (extraneous). Answer: x = 5.`,
          explanation: `Candidates were ${cands.map(String).join(' and ')}. Only ${uniq.length ? uniq.join(', ') : 'none'} satisfy the original equation; the others are extraneous because the right side would be negative.`,
          difficulty: 3, family: 'abs_equation.extraneous',
        };
      }
    }
  }
  const p = pick(r, [1, 1, 2, 3]) , q = int(r, -8, 8);
  const roll = r();
  const rVal = d === 1 ? int(r, 1, 9) : roll < 0.15 ? 0 : roll < 0.35 ? -int(r, 1, 6) : int(r, 1, 12);
  const inside = lin(p, q);
  const rel = `|${inside}| = ${rVal}`;
  let ans: string;
  if (rVal < 0) ans = 'no solution';
  else {
    const s1 = new Frac(rVal - q, p), s2 = new Frac(-rVal - q, p);
    ans = rVal === 0 ? solStr(s1) : `${solStr(s1)} or ${solStr(s2)}`;
  }
  return {
    prompt: `Solve for x: ${rel}`, spec: { type: 'math_set', answer: ans, variable: 'x', relation: rel },
    hints: ['An absolute value equation can have two cases. What are they?', rVal < 0 ? 'Can an absolute value ever equal a negative number?' : `Solve ${inside} = ${rVal} and ${inside} = ${-rVal}.`],
    workedExample: `Solve |2x - 3| = 7. Case 1: 2x - 3 = 7 → x = 5. Case 2: 2x - 3 = -7 → x = -2. Check: |2(5)-3| = 7 ✓ and |2(-2)-3| = 7 ✓.`,
    explanation: rVal < 0 ? `Absolute value is never negative, so |…| = ${rVal} has no solution.` : rVal === 0 ? `|…| = 0 only when the inside is 0, so there is exactly one solution: ${ans}.` : `Two cases: inside = ${rVal} or inside = ${-rVal}. Answer: ${ans}.`,
    difficulty: d, family: rVal < 0 ? 'abs_equation.no_solution' : 'abs_equation.two_cases',
  };
}

function absInequality(r: R, d: 1 | 2 | 3): GeneratedProblem {
  const p = pick(r, [1, 2, 3]), q = int(r, -6, 6), rv = int(r, 1, 9);
  const less = r() < 0.5, closed = r() < 0.5;
  const op = `${less ? '<' : '>'}${closed ? '=' : ''}`;
  const rel = `|${lin(p, q)}| ${op} ${rv}`;
  const lo = new Frac(-rv - q, p), hi = new Frac(rv - q, p);
  const ans = less ? `${lo} ${closed ? '<=' : '<'} x ${closed ? '<=' : '<'} ${hi}` : `x ${closed ? '<=' : '<'} ${lo} or x ${closed ? '>=' : '>'} ${hi}`;
  return {
    prompt: `Solve and write the answer using inequalities${less ? '' : ' (use "or")'}: ${rel}`,
    spec: { type: 'math_set', answer: ans, variable: 'x', relation: rel },
    hints: [less ? '"Less than" means the inside is trapped between -r and r.' : '"Greater than" means the inside is beyond r in either direction.', less ? `Write -${rv} ${closed ? '≤' : '<'} ${lin(p, q)} ${closed ? '≤' : '<'} ${rv} and solve.` : `Write ${lin(p, q)} ${closed ? '≤' : '<'} -${rv} or ${lin(p, q)} ${closed ? '≥' : '>'} ${rv} and solve each.`],
    workedExample: `Solve |x - 2| < 5 → -5 < x - 2 < 5 → -3 < x < 7. For |x - 2| > 5 → x - 2 < -5 or x - 2 > 5 → x < -3 or x > 7.`,
    explanation: `|u| ${op} r ${less ? 'means u is within r of 0' : 'means u is at least/more than r away from 0'}. Answer: ${ans}.`,
    difficulty: Math.max(2, d) as 2 | 3, family: less ? 'abs_inequality.less' : 'abs_inequality.greater',
  };
}

function sets(r: R, d: 1 | 2 | 3): GeneratedProblem {
  const pool = Array.from({ length: 12 }, (_, i) => i + 1);
  const take = (n: number) => { const p = [...pool]; const o: number[] = []; for (let i = 0; i < n; i++) o.push(p.splice(int(r, 0, p.length - 1), 1)[0]); return o.sort((a, b) => a - b); };
  const A = take(int(r, 4, 6)), B = [...take(3), ...A.slice(0, int(r, 1, 3))].filter((v, i, arr) => arr.indexOf(v) === i).sort((a, b) => a - b);
  const show = (s: number[]) => `{${s.join(', ')}}`;
  const op = pick(r, d === 1 ? ['union', 'intersection'] : ['union', 'intersection', 'difference']);
  const res = op === 'union' ? [...new Set([...A, ...B])].sort((a, b) => a - b) : op === 'intersection' ? A.filter((v) => B.includes(v)) : A.filter((v) => !B.includes(v));
  const sym = op === 'union' ? 'A ∪ B' : op === 'intersection' ? 'A ∩ B' : 'A − B';
  return {
    prompt: `Let A = ${show(A)} and B = ${show(B)}. Find ${sym} (write the result as a set, like {1, 2}; write {} if it is empty).`,
    spec: { type: 'math_set', answer: res.length ? show(res) : '{}', variable: 'x' },
    hints: [op === 'union' ? 'Union means everything that is in A, in B, or in both.' : op === 'intersection' ? 'Intersection means only the elements that are in BOTH sets.' : 'A − B means the elements of A that are NOT in B.', 'List each element of A and check whether it belongs to B.'],
    workedExample: `A = {1, 2, 3}, B = {3, 4}. A ∪ B = {1, 2, 3, 4} (list each element once). A ∩ B = {3}. A − B = {1, 2}.`,
    explanation: `${sym} = ${res.length ? show(res) : '{} (empty)'}. ${op === 'union' ? 'Do not repeat shared elements.' : ''}`,
    difficulty: d, family: `sets.${op}`,
  };
}

const GEN: Record<MathSkill, (r: R, d: 1 | 2 | 3) => GeneratedProblem> = {
  'math.linear_equation': linearEquation,
  'math.linear_inequality': linearInequality,
  'math.compound_inequality': compoundInequality,
  'math.abs_equation': absEquation,
  'math.abs_inequality': absInequality,
  'math.sets': sets,
};

export function generateMathProblem(skill: MathSkill, seed: number, difficulty: 1 | 2 | 3 = 2): GeneratedProblem {
  return GEN[skill](rng(seed), difficulty);
}
