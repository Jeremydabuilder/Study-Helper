/**
 * Step-by-step checking of a student's typed math working. Deterministic: it never evaluates code and never asks a model.
 *
 * What it does, honestly:
 *  - Each line is compared with the line before it (the first line with the problem as written). A transition is VALID when the two lines have the same
 *    solutions (equations/inequalities) or the same value (expressions). That is why a different valid method is never marked wrong: methods differ in
 *    the lines they pass through, not in what each line means. A line that does NOT follow is an invalid step, and the first one is reported.
 *  - A line it cannot read (words, drawings, multi-variable inequalities, notation it does not know) is "unchecked", never "wrong".
 *  - Equations are solved numerically on [-100, 100]; roots outside that range or many critical points make it say "could not verify".
 *  - After an invalid line, the next lines are judged against that line, so one slip does not mark every later line wrong.
 */
import { MathParseError, Node, evalNode, normalizeMathText, parseExpr, variablesOf } from './mathExpr';
import { Relation, holds, parseRelation, relationToSetIsolated, relationVariables, solveRelation } from './relation';
import { RealSet, ALL, complement, equalIgnoringClosure, equalSets, formatSet, isPointSet, negate, points as pointsOf, pointSubset } from './realSet';

export type StepTag = 'sign_error' | 'flipped_inequality' | 'endpoint_inclusion' | 'missing_solution' | 'extraneous_solution' | 'arithmetic_slip' | 'does_not_follow' | 'copy_mismatch' | 'domain' | 'units';
export interface StepVerdict { index: number; text: string; status: 'ok' | 'incorrect' | 'unchecked' | 'note'; why: string; tags: StepTag[] }
export interface StepCheckResult {
  kind: 'solve' | 'simplify' | 'unknown';
  problem: { text: string; parsed: boolean; solution: string | null };
  steps: StepVerdict[];
  /** 1-based index into `steps` of the first line that does not follow, or null */
  firstIncorrect: number | null;
  final: { text: string | null; verdict: 'correct' | 'incorrect' | 'unverified'; why: string };
  notes: string[];
  checked: number; unchecked: number;
}

const COMMAND = /\b(solve|simplify|expand|factor(?:ise|ize)?|evaluate|compute|calculate|find)\b/i;

/** Pulls the mathematical part out of a question such as "Solve for x: 2x + 3 = 11." Returns null when no math can be read. */
export function extractProblemMath(prompt: string): { command: string | null; math: string } | null {
  let s = prompt.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\(?[0-9a-z]{1,3}[.)]\s+/i, '');
  const m = s.match(COMMAND);
  const command = m ? m[1].toLowerCase() : null;
  let rest = m ? s.slice((m.index ?? 0) + m[0].length) : s;
  const colon = rest.indexOf(':');
  if (colon >= 0 && colon < 40) rest = rest.slice(colon + 1);
  rest = rest.replace(/^\s*(for\s+[a-z]\b|the\s+(?:following\s+)?(?:equation|inequality|expression)s?|each\s+of\s+the\s+following)\s*[:,]?/i, '').trim();
  rest = rest.replace(/[.?!]+\s*$/, '').trim();
  if (!rest || !/[0-9a-z]/i.test(rest) || looksLikeWords(rest)) return null;
  return { command, math: rest };
}

const LEAD = /^\s*(?:step\s*\d+\s*[:.)-]?|\d+\s*[.)]\s+|[-•*]\s+|(?:so|thus|therefore|hence|then)[,:]?\s+|∴|⇒|=>|→|->)\s*/i;
const CHECKMARK = /\s*[✓✔☑]\s*$/;
const cleanLine = (raw: string) => { let s = raw.trim(); for (let i = 0; i < 3; i++) s = s.replace(LEAD, ''); return s.replace(CHECKMARK, '').trim(); };
const looksLikeWords = (s: string) => /[a-z]{3,}/i.test(s.replace(/\b(sqrt|abs|sin|cos|tan|log|ln|exp|pi|and|or)\b/gi, ''));

function tryParseRel(s: string): Relation | null { try { return parseRelation(s); } catch { return null; } }
function tryParseExpr(s: string): Node | null { try { return parseExpr(s); } catch { return null; } }

function setOf(rel: Relation, variable: string): RealSet | null {
  try { return relationToSetIsolated(rel, variable) ?? solveRelation(rel, variable); } catch { return null; }
}
const hasOnlyVar = (rel: Relation, variable: string) => { const v = relationVariables(rel); return v.size === 1 && v.has(variable); };

/** Are two expressions equal wherever both are defined? Also reports values at which exactly one side is undefined. */
export function equivalentDetail(a: string, b: string): { equal: boolean; undefinedAt: number[] } {
  const A = parseExpr(a), B = parseExpr(b);
  const vars = [...new Set([...variablesOf(A), ...variablesOf(B)])];
  const pts = [-7.3, -3.1, -1.7, -0.6, 0.4, 1.3, 2.9, 4.7, 9.1, 13.37, 0.77, -2.2];
  let compared = 0;
  for (let i = 0; i < pts.length; i++) {
    const env: Record<string, number> = {};
    vars.forEach((v, j) => { env[v] = pts[(i + 3 * j) % pts.length]; });
    const va = evalNode(A, env), vb = evalNode(B, env);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
    compared++;
    if (Math.abs(va - vb) > 1e-8 * Math.max(1, Math.abs(va), Math.abs(vb))) return { equal: false, undefinedAt: [] };
  }
  if (compared < 3) return { equal: false, undefinedAt: [] };
  const undefinedAt: number[] = [];
  if (vars.length === 1) {
    for (let k = -20; k <= 20; k++) {
      const x = k / 2; const env = { [vars[0]]: x };
      const fa = Number.isFinite(evalNode(A, env)), fb = Number.isFinite(evalNode(B, env));
      if (fa !== fb) undefinedAt.push(x);
    }
  }
  return { equal: true, undefinedAt };
}

/** Two equations with several variables are equivalent when one side-difference is a non-zero constant multiple of the other. */
function equationsProportional(a: Relation, b: Relation): boolean | null {
  if (a.k !== 'atom' || b.k !== 'atom' || a.op !== '=' || b.op !== '=') return null;
  const vars = [...new Set([...relationVariables(a), ...relationVariables(b)])];
  if (!vars.length || vars.length > 3) return null;
  const pts = [-3.1, -1.3, 0.7, 2.2, 4.9, 6.1, -5.3, 1.9];
  let ratio: number | null = null, n = 0;
  for (let i = 0; i < pts.length; i++) {
    const env: Record<string, number> = {}; vars.forEach((v, j) => { env[v] = pts[(i + 3 * j) % pts.length]; });
    const d1 = evalNode(a.lhs, env) - evalNode(a.rhs, env), d2 = evalNode(b.lhs, env) - evalNode(b.rhs, env);
    if (!Number.isFinite(d1) || !Number.isFinite(d2)) continue;
    if (Math.abs(d1) < 1e-9 && Math.abs(d2) < 1e-9) continue;
    if (Math.abs(d1) < 1e-9 || Math.abs(d2) < 1e-9) return false;
    const r = d2 / d1; if (ratio === null) ratio = r; else if (Math.abs(r - ratio) > 1e-7 * Math.max(1, Math.abs(ratio))) return false;
    n++;
  }
  return n >= 3;
}

const isRay = (s: RealSet) => s.length === 1 && (s[0].lo === -Infinity) !== (s[0].hi === Infinity);
function classifyTransition(prev: RealSet, next: RealSet): { tags: StepTag[]; why: string } {
  if (equalIgnoringClosure(prev, next)) return { tags: ['endpoint_inclusion'], why: 'The boundary value is included or left out differently from the line before (check < versus ≤, and open versus closed brackets).' };
  if (isPointSet(prev) && isPointSet(next) && equalSets(negate(prev), next)) return { tags: ['sign_error'], why: 'The solution is the opposite of what the line before gives. A sign was probably lost or flipped.' };
  if (isRay(prev) && isRay(next) && equalIgnoringClosure(complement(prev), next)) return { tags: ['flipped_inequality'], why: 'The inequality points the other way compared with the line before. Remember to reverse it when multiplying or dividing both sides by a negative number.' };
  if (pointSubset(next, prev) && !pointSubset(prev, next)) return { tags: ['missing_solution'], why: 'This line has fewer solutions than the line before, so a solution was lost (for example by dividing by something that can be zero).' };
  if (pointSubset(prev, next) && !pointSubset(next, prev)) return { tags: ['extraneous_solution'], why: 'This line has extra solutions that the line before did not (squaring both sides can do that). Check each answer in the original problem.' };
  return { tags: ['does_not_follow'], why: 'This line does not have the same solutions as the line before, so something changed that should not have (an arithmetic slip is common here).' };
}

const UNIT = /\b(cm|mm|km|kg|mg|ml|mph|m\/s|km\/h|degrees?|meters?|metres?|seconds?|minutes?|hours?|grams?|liters?|litres?|inches|feet|miles|dollars?)\b|°|%|\$/i;

export function checkWorking(promptText: string, working: string): StepCheckResult {
  const lines = working.replace(/\r\n/g, '\n').split('\n').map(cleanLine).filter(Boolean).slice(0, 60);
  const prob = extractProblemMath(promptText);
  const out: StepCheckResult = { kind: 'unknown', problem: { text: prob?.math ?? '', parsed: false, solution: null }, steps: [], firstIncorrect: null, final: { text: null, verdict: 'unverified', why: '' }, notes: [], checked: 0, unchecked: 0 };
  if (!lines.length) { out.final.why = 'There is no working to check yet.'; return out; }

  const pRel = prob ? tryParseRel(normalizeMathText(prob.math)) : null;
  const pExpr = prob && !pRel ? tryParseExpr(normalizeMathText(prob.math)) : null;
  const wantsExpression = !!prob?.command && /simplify|expand|factor|evaluate|compute|calculate/.test(prob.command);
  out.kind = pRel && !wantsExpression ? 'solve' : pExpr || (pRel && wantsExpression) ? 'simplify' : 'unknown';
  out.problem.parsed = out.kind !== 'unknown';

  if (out.kind === 'unknown') {
    // no problem to compare with: still check each line against the one before
    const first = lines.find((l) => tryParseRel(normalizeMathText(l)) || tryParseExpr(normalizeMathText(l)));
    if (!first) { out.steps = lines.map((t, i) => ({ index: i + 1, text: t, status: 'unchecked' as const, why: 'I could not read this line as math.', tags: [] })); out.unchecked = lines.length; out.final.why = 'I could not read the problem or your working as math, so nothing was checked.'; return out; }
    out.notes.push('The problem itself could not be read as math, so lines were compared only with the line before them, and the final answer could not be verified.');
  }

  const variable = (() => { const v = pRel ? [...relationVariables(pRel)] : pExpr ? [...variablesOf(pExpr)] : []; return v[0] ?? 'x'; })();
  if (out.kind === 'solve' || pRel) out.notes.push('Equations are solved numerically between −100 and 100; a solution outside that range would not be noticed.');

  let prevSet: RealSet | null = pRel ? setOf(pRel, variable) : null;
  let prevRel: Relation | null = pRel;
  let prevExpr: string | null = pExpr ? prob!.math : pRel && wantsExpression ? prob!.math : null;
  out.problem.solution = out.kind === 'solve' && prevSet ? formatSet(prevSet) : null;
  const problemSet = prevSet;
  let lastLineSet: RealSet | null = null, lastLine: string | null = null, lastExprText: string | null = null;
  let lastWasOk = true;
  const upgradeCandidates: number[] = [];

  const push = (text: string, status: StepVerdict['status'], why: string, tags: StepTag[] = []) => {
    const idx = out.steps.length + 1; out.steps.push({ index: idx, text, status, why, tags });
    if (status === 'incorrect' && out.firstIncorrect === null) out.firstIncorrect = idx;
    if (status === 'unchecked') out.unchecked++; else if (status !== 'note' || tags.includes('domain')) out.checked++;
    return idx;
  };

  for (const raw of lines) {
    const text = normalizeMathText(raw);
    if (looksLikeWords(text)) { push(raw, 'note', 'Words, not a step. Not checked.'); continue; }
    const rel = tryParseRel(text);

    if (out.kind === 'simplify' || (out.kind === 'unknown' && !rel)) {
      // an equals-chain "a = b = c" asserts the pieces are equal; a bare expression continues from the line before
      const pieces = rel && !/[<>≤≥≠]/.test(text) ? text.split('=').map((p) => p.trim()).filter(Boolean) : [text];
      const parsed = pieces.map((p) => tryParseExpr(p));
      if (parsed.some((p) => !p)) { push(raw, looksLikeWords(text) ? 'note' : 'unchecked', looksLikeWords(text) ? 'Words, not a step. Not checked.' : 'I could not read this line as math, so it was not checked.'); continue; }
      let ok = true, why = '', tags: StepTag[] = [];
      const seq = prevExpr !== null && pieces.length === 1 ? [prevExpr, pieces[0]] : pieces;
      let domainNote = '';
      for (let i = 0; i + 1 < seq.length; i++) {
        const d = equivalentDetail(seq[i], seq[i + 1]);
        if (!d.equal) { ok = false; why = `“${seq[i]}” and “${seq[i + 1]}” are not equal: they give different values.`; tags = ['does_not_follow']; break; }
        if (d.undefinedAt.length) domainNote = ` Equal wherever both are defined, but not at ${d.undefinedAt.slice(0, 3).join(', ')} where one of them is undefined. Say so if the problem asks for the domain.`;
      }
      if (ok) { push(raw, domainNote ? 'note' : 'ok', domainNote ? domainNote.trim() : 'Equal to the line before.', domainNote ? ['domain'] : []); }
      else { push(raw, 'incorrect', why, tags); }
      lastWasOk = ok; lastExprText = pieces[pieces.length - 1]; prevExpr = lastExprText; lastLine = raw;
      continue;
    }

    // solving: the line must be a relation
    if (!rel) {
      const asExpr = tryParseExpr(text);
      if (asExpr && prevExpr === null) { push(raw, 'unchecked', 'This is an expression, not an equation or inequality, so it cannot be compared with the line before.'); continue; }
      push(raw, looksLikeWords(text) ? 'note' : 'unchecked', looksLikeWords(text) ? 'Words, not a step. Not checked.' : 'I could not read this line as an equation, so it was not checked.');
      continue;
    }
    const vars = relationVariables(rel);
    if (vars.size === 0) {
      let t = false; try { t = holds(rel, {}); } catch { /* handled below */ }
      if (t) push(raw, 'ok', 'A true statement (for example a check by substitution).');
      else push(raw, 'incorrect', 'This statement is false as written. Re-check the arithmetic.', ['arithmetic_slip']);
      continue;
    }
    const set = vars.size === 1 ? setOf(rel, [...vars][0]) : null;
    if (!set || !prevSet || vars.size > 1) {
      const prop = prevRel ? equationsProportional(prevRel, rel) : null;
      if (prop === true) { push(raw, 'ok', 'Equivalent to the line before (checked numerically).'); prevRel = rel; prevSet = null; lastLine = raw; lastLineSet = null; continue; }
      if (prop === false) { push(raw, 'incorrect', 'This equation is not equivalent to the line before (checked numerically).', ['does_not_follow']); prevRel = rel; lastWasOk = false; lastLine = raw; continue; }
      push(raw, 'unchecked', vars.size > 1 ? 'More than one variable (or an inequality with several variables): this step is not checked automatically.' : 'I could not solve this line automatically, so it was not checked.');
      prevRel = rel; prevSet = set ?? null; lastLine = raw; lastLineSet = set ?? null;
      continue;
    }
    if (equalSets(prevSet, set)) {
      push(raw, 'ok', out.steps.length === 0 && problemSet && equalSets(problemSet, set) && prevRel === pRel ? 'Matches the problem.' : 'Has the same solutions as the line before.');
    } else {
      const c = classifyTransition(prevSet, set);
      const first = out.steps.every((s) => s.status !== 'ok' && s.status !== 'incorrect') && prevRel === pRel;
      if (c.tags[0] === 'extraneous_solution') { const i = push(raw, 'note', c.why, c.tags); upgradeCandidates.push(i); }
      else push(raw, 'incorrect', first && problemSet ? `This first line does not match the problem as written. ${c.why}` : c.why, first && c.tags[0] === 'does_not_follow' ? ['copy_mismatch'] : c.tags);
    }
    lastWasOk = out.steps[out.steps.length - 1].status !== 'incorrect';
    prevRel = rel; prevSet = set; lastLine = raw; lastLineSet = set;
  }

  // final answer
  if (out.kind === 'solve') {
    if (!lastLine) out.final = { text: null, verdict: 'unverified', why: 'No readable line to take as your answer.' };
    else if (!problemSet) out.final = { text: lastLine, verdict: 'unverified', why: 'I could not solve the problem automatically, so the final answer could not be verified.' };
    else if (!lastLineSet || !(pRel && hasOnlyVar(pRel, variable))) out.final = { text: lastLine, verdict: 'unverified', why: 'The last line was not checked as an answer.' };
    else {
      const asAnswer = tryParseRel(normalizeMathText(lastLine));
      const solved = asAnswer ? relationToSetIsolated(asAnswer, variable) : null;
      if (!solved) out.final = { text: lastLine, verdict: 'unverified', why: 'The last line is not yet a solution (the variable is not on its own). Keep going, or write your answer on its own line.' };
      else if (equalSets(solved, problemSet)) out.final = { text: lastLine, verdict: 'correct', why: 'This answer satisfies the original problem.' };
      else if (equalIgnoringClosure(solved, problemSet)) out.final = { text: lastLine, verdict: 'incorrect', why: 'Right boundary, but the endpoint is included or excluded wrongly (check < versus ≤).' };
      else out.final = { text: lastLine, verdict: 'incorrect', why: pointsOf(solved).length && isPointSet(solved) && isPointSet(problemSet) && pointsOf(solved).length < pointsOf(problemSet).length ? 'Some solutions are missing from this answer.' : 'This answer does not satisfy the original problem.' };
      void ALL;
    }
    if (out.final.verdict === 'incorrect') { const i = upgradeCandidates.find((k) => out.firstIncorrect === null || k < out.firstIncorrect); if (i !== undefined) { const s = out.steps[i - 1]; s.status = 'incorrect'; out.firstIncorrect = Math.min(out.firstIncorrect ?? i, i); out.checked = out.steps.filter((x) => x.status !== 'unchecked' && x.status !== 'note').length; } }
  } else if (out.kind === 'simplify') {
    if (lastExprText === null) out.final = { text: null, verdict: 'unverified', why: 'No readable expression to take as your answer.' };
    else {
      const d = (() => { try { return equivalentDetail(prob!.math, lastExprText); } catch { return null; } })();
      if (!d) out.final = { text: lastExprText, verdict: 'unverified', why: 'I could not compare your answer with the problem.' };
      else if (!d.equal) out.final = { text: lastExprText, verdict: 'incorrect', why: 'This is not equal to the original expression.' };
      else {
        const cmd = prob!.command ?? '';
        let extra = '';
        if (/expand/.test(cmd) && /\(/.test(lastExprText.replace(/\b(sqrt|abs|sin|cos|tan|log|ln|exp)\s*\(/gi, ''))) extra = ' It still has brackets to multiply out, so it may not be fully expanded.';
        else if (/factor/.test(cmd) && !/\(/.test(lastExprText)) extra = ' It does not look factored (no brackets).';
        else if (/simplify/.test(cmd)) extra = ' The app checks that it has the same value; whether it is fully simplified in your teacher’s sense is not checked.';
        out.final = { text: lastExprText, verdict: extra && /still has|does not look/.test(extra) ? 'unverified' : 'correct', why: `Equal in value to the original.${extra}` };
      }
    }
  } else out.final = { text: lastLine, verdict: 'unverified', why: out.final.why || 'The problem could not be read, so the final answer could not be verified.' };

  // units: an answer to a question that mentions units should say which
  if (out.final.verdict !== 'unverified' && lastLine && UNIT.test(promptText) && !UNIT.test(lastLine) && /^\s*[-\d.\s/=x a-z]*\d\s*$/i.test(lastLine)) {
    out.notes.push('The question mentions units, but your final line has none. Write the unit with your answer.');
  }
  if (lastWasOk === false && out.firstIncorrect === null) out.firstIncorrect = out.steps.findIndex((s) => s.status === 'incorrect') + 1 || null;
  return out;
}

/** Plain, short description of the first invalid step for the student (and for a hint). */
export function describeFirstIncorrect(r: StepCheckResult): string | null {
  if (r.firstIncorrect === null) return null;
  const s = r.steps[r.firstIncorrect - 1];
  return `Line ${s.index} (“${s.text}”): ${s.why}`;
}
