import { describe, expect, it } from 'vitest';
import { checkWorking, extractProblemMath } from '../src/core/stepcheck';

describe('reading the problem', () => {
  it('pulls the math out of a sentence', () => {
    expect(extractProblemMath('1. Solve for x: 2x + 3 = 11.')?.math).toBe('2x + 3 = 11');
    expect(extractProblemMath('Simplify (x^2 - 1)/(x - 1)')?.command).toBe('simplify');
  });
});

describe('solving an equation', () => {
  const P = 'Solve for x: 2x + 3 = 11';
  it('accepts correct working and answer', () => {
    const r = checkWorking(P, '2x + 3 = 11\n2x = 8\nx = 4');
    expect(r.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok']);
    expect(r.final.verdict).toBe('correct');
    expect(r.firstIncorrect).toBeNull();
  });
  it('accepts a different valid method: skipping steps, or guess and check, is not an invalid step', () => {
    const skip = checkWorking(P, 'x = 4');
    expect(skip.final.verdict).toBe('correct'); expect(skip.firstIncorrect).toBeNull();
    const sub = checkWorking(P, 'Try x = 4\n2(4) + 3 = 11\nx = 4');
    expect(sub.firstIncorrect).toBeNull(); expect(sub.final.verdict).toBe('correct');
    expect(sub.steps[0].status).toBe('note'); // words are not a step
  });
  it('finds the FIRST invalid step and does not blame later lines that follow from it', () => {
    const r = checkWorking(P, '2x + 3 = 11\n2x = 14\nx = 7');
    expect(r.firstIncorrect).toBe(2);
    expect(r.steps[1].status).toBe('incorrect');
    expect(r.steps[2].status).toBe('ok'); // x = 7 does follow from 2x = 14
    expect(r.final.verdict).toBe('incorrect');
  });
  it('names a lost sign', () => {
    const r = checkWorking('Solve x - 5 = 2', 'x - 5 = 2\nx = 4');
    expect(r.steps[1].tags).toContain('does_not_follow');
    const r2 = checkWorking('Solve for x: 3x = 9', '3x = 9\nx = -3');
    expect(r2.steps[1].tags).toContain('sign_error');
  });
  it('does not mark a false copy of the problem as a method error', () => {
    const r = checkWorking(P, '2x + 3 = 12\n2x = 9\nx = 4.5');
    expect(r.steps[0].status).toBe('incorrect'); expect(r.steps[0].tags).toContain('copy_mismatch');
  });
  it('treats unreadable lines as unchecked, never wrong', () => {
    const r = checkWorking(P, '2x + 3 = 11\n??? \n2x = 8\nx = 4');
    expect(r.steps[1].status).toBe('unchecked');
    expect(r.firstIncorrect).toBeNull(); expect(r.unchecked).toBe(1);
  });
  it('flags a false numeric statement as arithmetic', () => {
    const r = checkWorking(P, '2x + 3 = 11\n2x = 8\nx = 4\n2(4) + 3 = 12');
    expect(r.steps[3].status).toBe('incorrect'); expect(r.steps[3].tags).toContain('arithmetic_slip');
  });
  it('is not finished until the variable is alone', () => {
    const r = checkWorking(P, '2x + 3 = 11\n2x = 8');
    expect(r.final.verdict).toBe('unverified');
  });
});

describe('inequalities, endpoints and quadratics', () => {
  it('catches a flipped inequality when dividing by a negative', () => {
    const r = checkWorking('Solve -2x < 6', '-2x < 6\nx < -3');
    expect(r.steps[1].tags).toContain('flipped_inequality'); expect(r.final.verdict).toBe('incorrect');
    expect(checkWorking('Solve -2x < 6', '-2x < 6\nx > -3').final.verdict).toBe('correct');
  });
  it('catches endpoint inclusion', () => {
    const r = checkWorking('Solve 3x + 1 <= 10', '3x + 1 <= 10\n3x <= 9\nx < 3');
    expect(r.steps[2].tags).toContain('endpoint_inclusion'); expect(r.final.verdict).toBe('incorrect');
  });
  it('notes a lost solution and accepts different valid methods for a quadratic', () => {
    const lost = checkWorking('Solve x^2 = 9', 'x^2 = 9\nx = 3');
    expect(lost.steps[1].tags).toContain('missing_solution'); expect(lost.final.verdict).toBe('incorrect');
    const factor = checkWorking('Solve x^2 - 5x + 6 = 0', '(x-2)(x-3) = 0\nx = 2 or x = 3');
    expect(factor.firstIncorrect).toBeNull(); expect(factor.final.verdict).toBe('correct');
    const formula = checkWorking('Solve x^2 - 5x + 6 = 0', 'x = (5 + 1)/2 or x = (5 - 1)/2\nx = 3 or x = 2');
    expect(formula.firstIncorrect).toBeNull(); expect(formula.final.verdict).toBe('correct');
  });
  it('flags a step that adds solutions (squaring) as a note, and as wrong only if the answer is wrong', () => {
    const ok = checkWorking('Solve sqrt(x) = 3', 'sqrt(x) = 3\nx = 9');
    expect(ok.final.verdict).toBe('correct');
  });
});

describe('simplifying', () => {
  it('accepts equal expressions and notes the domain when a factor cancels', () => {
    const r = checkWorking('Simplify (x^2 - 1)/(x - 1)', '(x^2 - 1)/(x - 1) = (x-1)(x+1)/(x-1) = x + 1');
    expect(r.firstIncorrect).toBeNull(); expect(r.final.verdict).toBe('correct');
    expect(r.steps[0].tags).toContain('domain');
  });
  it('finds the unequal step', () => {
    const r = checkWorking('Simplify 2(x + 3) + 4x', '2x + 3 + 4x\n6x + 3');
    expect(r.firstIncorrect).toBe(1); expect(r.final.verdict).toBe('incorrect');
  });
  it('does not call a partly expanded answer expanded', () => {
    const r = checkWorking('Expand (x+1)(x+2)', '(x+1)(x+2)\nx(x+2) + (x+2)');
    expect(r.final.verdict).toBe('unverified'); expect(r.final.why).toMatch(/brackets/);
  });
});

it('says plainly when the problem cannot be read', () => {
  const r = checkWorking('Describe the main idea of the passage', 'It is about plants');
  expect(r.final.verdict).toBe('unverified'); expect(r.checked).toBe(0);
});
