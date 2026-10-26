import { describe, expect, it } from 'vitest';
import { checkMath, parseSolutionSet, verifyMathSpec } from '../src/core/mathCheck';
import { expressionsEquivalent, evalConstant, parseExpr } from '../src/core/mathExpr';
import { equalSets, interval, point, union } from '../src/core/realSet';
import { parseRelation, solveRelation } from '../src/core/relation';

describe('safe expression parser', () => {
  it('evaluates arithmetic, fractions, abs and implicit multiplication', () => {
    expect(evalConstant('3/4')).toBeCloseTo(0.75);
    expect(evalConstant('2(3+4)')).toBe(14);
    expect(evalConstant('|-5| + 2^3')).toBe(13);
    expect(evalConstant('−3 × 2')).toBe(-6);
  });
  it('rejects code-like input instead of executing it', () => {
    for (const bad of ['process.exit(1)', 'require("fs")', 'x; alert(1)', '__proto__', '1 + {}']) {
      expect(() => evalConstant(bad)).toThrow();
    }
  });
  it('recognises equivalent expressions', () => {
    expect(expressionsEquivalent('2(x+3)', '2x+6')).toBe(true);
    expect(expressionsEquivalent('(x^2-1)/(x-1)', 'x+1')).toBe(true);
    expect(expressionsEquivalent('2x+5', '2x+6')).toBe(false);
  });
  it('parses absolute value bars', () => {
    expect(equalSets(solveRelation(parseRelation('|2x-3| = 7'))!, union(point(5), point(-2)))).toBe(true);
  });
});

describe('solution-set parsing', () => {
  it('accepts equivalent notations', () => {
    const a = parseSolutionSet('x > 3');
    expect(equalSets(a, parseSolutionSet('(3, inf)'))).toBe(true);
    expect(equalSets(a, parseSolutionSet('(3, ∞)'))).toBe(true);
    expect(equalSets(parseSolutionSet('x = 2 or x = -5'), parseSolutionSet('{-5, 2}'))).toBe(true);
    expect(equalSets(parseSolutionSet('x<-1 or x>4'), parseSolutionSet('(-inf,-1) U (4,inf)'))).toBe(true);
    expect(equalSets(parseSolutionSet('-1 < x <= 4'), interval(-1, 4, false, true))).toBe(true);
    expect(equalSets(parseSolutionSet('no solution'), [])).toBe(true);
    expect(equalSets(parseSolutionSet('x = 7/2'), point(3.5))).toBe(true);
  });
  it('requires an isolated variable', () => {
    expect(() => parseSolutionSet('2x > 6')).toThrow();
  });
});

describe('checkMath', () => {
  const abs = { type: 'math_set' as const, answer: 'x = 5 or x = -2' };
  it('marks correct, ignoring order and notation', () => {
    expect(checkMath(abs, '-2, 5').verdict).toBe('correct');
    expect(checkMath(abs, 'x=5 or x=-2').verdict).toBe('correct');
  });
  it('gives partial credit and tags for a missing solution', () => {
    const r = checkMath(abs, 'x = 5');
    expect(r.verdict).toBe('partial'); expect(r.tags).toContain('missing_solution');
  });
  it('flags extraneous solutions', () => {
    const r = checkMath({ type: 'math_set', answer: 'x = 5' }, 'x = 5 or x = 1');
    expect(r.tags).toContain('extraneous_solution');
  });
  it('distinguishes a sign mistake from a flipped inequality and endpoint error', () => {
    expect(checkMath({ type: 'math_set', answer: 'x = 4' }, 'x = -4').tags).toContain('sign_error');
    expect(checkMath({ type: 'math_set', answer: 'x < -2' }, 'x > -2').tags).toContain('flipped_inequality');
    const e = checkMath({ type: 'math_set', answer: 'x <= 3' }, 'x < 3');
    expect(e.tags).toContain('endpoint_inclusion'); expect(e.verdict).toBe('partial');
  });
  it('reports unparseable input as unparseable, not wrong', () => {
    const r = checkMath(abs, 'banana');
    expect(r.status).toBe('unparseable'); expect(r.verdict).toBe('unparseable');
  });
  it('handles numbers and expressions', () => {
    expect(checkMath({ type: 'math_number', answer: '3/4' }, '0.75').verdict).toBe('correct');
    expect(checkMath({ type: 'math_expr', answer: '2x+6' }, '2(x+3)').verdict).toBe('correct');
  });
});

describe('verifyMathSpec (independent numeric solve)', () => {
  it('verifies correct keys and rejects wrong ones', () => {
    expect(verifyMathSpec({ type: 'math_set', answer: 'x = 5 or x = -2', relation: '|2x-3| = 7' }).verified).toBe(true);
    expect(verifyMathSpec({ type: 'math_set', answer: 'x = 5', relation: '|2x-3| = 7' }).verified).toBe(false);
    expect(verifyMathSpec({ type: 'math_set', answer: 'x > -3', relation: '-2x < 6' }).verified).toBe(true);
    expect(verifyMathSpec({ type: 'math_set', answer: 'x < -3', relation: '-2x < 6' }).verified).toBe(false);
    expect(verifyMathSpec({ type: 'math_set', answer: 'x = 5', relation: '|x+1| = 2x-4' }).verified).toBe(true); // x=1 is extraneous
    expect(verifyMathSpec({ type: 'math_set', answer: 'no solution', relation: '|x| = -3' }).verified).toBe(true);
    expect(verifyMathSpec({ type: 'math_set', answer: 'x = 2', relation: '|x-2| = 0' }).verified).toBe(true);
  });
  it('says unverified (not verified) when there is no relation', () => {
    expect(verifyMathSpec({ type: 'math_set', answer: 'x = 1' }).verified).toBeNull();
  });
});

import { MATH_SKILLS, MathSkill, generateMathProblem } from '../src/core/mathgen';
describe('math generators', () => {
  it('every generated answer key is confirmed by the independent numeric solver', () => {
    const failures: string[] = [];
    for (const skill of Object.keys(MATH_SKILLS) as MathSkill[]) for (const d of [1, 2, 3] as const) for (let seed = 1; seed <= 60; seed++) {
      const p = generateMathProblem(skill, seed * 7919 + d, d);
      if (p.spec.relation) {
        const v = verifyMathSpec(p.spec);
        if (v.verified !== true) failures.push(`${skill} d${d} seed${seed}: ${p.prompt} -> ${p.spec.answer} (${v.note})`);
      }
      // the key must grade itself as correct
      if (checkMath(p.spec, p.spec.answer).verdict !== 'correct') failures.push(`self-check ${skill}: ${p.spec.answer}`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
  it('is deterministic per seed and varies across seeds', () => {
    expect(generateMathProblem('math.abs_equation', 5, 2).prompt).toBe(generateMathProblem('math.abs_equation', 5, 2).prompt);
    const set = new Set(Array.from({ length: 20 }, (_, i) => generateMathProblem('math.linear_equation', i, 2).prompt));
    expect(set.size).toBeGreaterThan(10);
  });
});
