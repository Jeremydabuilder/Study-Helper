/**
 * The practice loop: session -> question -> (hints) -> attempt -> grade -> feedback -> next.
 * Everything that affects scheduling is derived from the attempt log by core/learning.ts.
 */
import { AIError } from '../../ai/provider';
import { MISTAKE_BLURB, MISTAKE_LABEL, MistakeKind, diagnose, Diagnosis } from '../../core/diagnosis';
import { NextAction, nextAction } from '../../core/nextAction';
import { checkMath, MathSpec } from '../../core/mathCheck';
import { AttemptRecord, replay, TraceEntry, isDue, LEVEL_LABEL, GradeSource, GradeStatus } from '../../core/learning';
import { planToday } from '../../core/priority';
import { buildContext } from '../../core/retrieval';
import { wilson } from '../../core/stats';
import { HOUR, DAY } from '../../core/time';
import { uid } from '../db';
import { Ctx, HttpError, clip, getProfile, getSchedulerParams, parse } from './common';
import { modelChunks } from './sourceSafety';
import { memoryAction, recordImprovement, recordMistakeMemory } from './teachingMemory';
import { PickOpts, QuestionRow, getQuestion, pickQuestion, publicQuestion } from './questions';
import { buildPlanInputs } from './plan';

type Purpose = PickOpts['purpose'];
interface Slot { conceptId: string; purpose: Purpose; n: number; done: number; extra: number; streak: number; priority?: boolean }
/** Per-session teaching state: what to do next, and how the last few answers on each concept went. */
interface Notes { next?: NextAction | null; fails?: Record<string, number>; explained?: Record<string, number> }
const notesOf = (s: any): Notes => parse<Notes>(s.notes, {});
interface Current { questionId: string; conceptId: string; purpose: Purpose; servedAt: number; hintsShown: number; revealed: boolean; attemptId: string | null; fallbackOffline?: boolean; why?: string | null }

const TEXT_MIN_CHARS = 1;
const MAX_ANSWER = 4000;

/* --------------------------- concept state / evidence --------------------------- */

export function loadAttempts(ctx: Ctx, conceptId: string): AttemptRecord[] {
  return ctx.db.all<any>(`SELECT a.*, q.heldout FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.concept_id = ? ORDER BY a.created_at, a.rowid`, conceptId).map((a) => ({
    id: a.id, conceptId: a.concept_id, questionId: a.question_id, sessionId: a.session_id, at: a.created_at, correctness: a.correctness,
    gradeStatus: a.grade_status as GradeStatus, gradeSource: a.grade_source as GradeSource, hinted: a.hints_used > 0, sawAnswer: !!a.saw_answer, idk: !!a.idk,
    confidence: a.confidence as 1 | 2 | 3 | null, feedbackShown: !!a.feedback_shown, heldout: !!a.heldout,
  }));
}

export function recomputeConcept(ctx: Ctx, conceptId: string, trace?: TraceEntry[]) {
  const active = ctx.db.get<any>("SELECT COUNT(*) n FROM misconceptions WHERE concept_id = ? AND status = 'active'", conceptId).n;
  const state = replay(loadAttempts(ctx, conceptId), { tz: getProfile(ctx.db).timezone, activeMisconceptions: active, params: getSchedulerParams(ctx.db), trace });
  ctx.db.run(`INSERT INTO concept_state (concept_id,state,level,due_at,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(concept_id) DO UPDATE SET state=excluded.state, level=excluded.level, due_at=excluded.due_at, updated_at=excluded.updated_at`,
    conceptId, JSON.stringify(state), state.level, state.dueAt, ctx.now());
  return state;
}

/* --------------------------- starting & resuming --------------------------- */

export interface StartOpts {
  mode: 'diagnostic' | 'practice' | 'review' | 'exam' | 'mixed'; subjectId?: string | null; minutes: number; conceptIds?: string[];
  itemId?: string | null; abandonExisting?: boolean; fromPlan?: boolean;
}

export function activeSession(ctx: Ctx) {
  return ctx.db.get<any>("SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1");
}

export function startSession(ctx: Ctx, o: StartOpts) {
  const existing = activeSession(ctx);
  if (existing) {
    if (!o.abandonExisting) throw new HttpError(409, 'session_active', 'You have a session in progress.', { sessionId: existing.id, mode: existing.mode });
    ctx.db.run("UPDATE sessions SET status='abandoned', ended_at=? WHERE id=?", ctx.now(), existing.id);
  }
  const minutes = Math.max(3, Math.min(180, Math.round(o.minutes || 15)));
  const slots: Slot[] = [];
  const confirmed = (subjectId?: string | null) => ctx.db.all<any>(`SELECT c.id, c.subject_id FROM concepts c WHERE c.status='confirmed' ${subjectId ? 'AND c.subject_id = ?' : ''} ORDER BY c.created_at`, ...(subjectId ? [subjectId] : []));
  const mk = (conceptId: string, purpose: Purpose, n: number): Slot => ({ conceptId, purpose, n, done: 0, extra: 0, streak: 0 });
  let subjectId = o.subjectId ?? null;

  if (o.mode === 'diagnostic') {
    const pool = confirmed(subjectId);
    if (!pool.length) throw new HttpError(409, 'no_concepts', 'Confirm at least one concept first.');
    const states = new Map(ctx.db.all<any>('SELECT concept_id, level FROM concept_state').map((r) => [r.concept_id, r.level]));
    const unassessed = pool.filter((c) => !states.has(c.id) || states.get(c.id) === 'not_assessed');
    const chosen = (unassessed.length ? unassessed : pool).slice(0, Math.max(2, Math.min(6, Math.floor(minutes / 2.5))));
    const prereqCount = (id: string) => ctx.db.get<any>('SELECT COUNT(*) n FROM concept_prereqs WHERE concept_id=?', id).n;
    chosen.sort((a, b) => prereqCount(a.id) - prereqCount(b.id));
    for (const c of chosen) slots.push(mk(c.id, 'diagnostic', 1));
  } else if (o.mode === 'practice') {
    if (!o.conceptIds?.length) throw new HttpError(400, 'invalid', 'Choose a concept to practise.');
    for (const id of o.conceptIds) slots.push(mk(id, 'practice', Math.max(2, Math.min(5, Math.floor(minutes / 4)))));
  } else if (o.mode === 'review') {
    const now = ctx.now();
    const due = ctx.db.all<any>(`SELECT cs.concept_id id FROM concept_state cs JOIN concepts c ON c.id = cs.concept_id WHERE c.status='confirmed' AND cs.due_at IS NOT NULL AND cs.due_at <= ? ${subjectId ? 'AND c.subject_id = ?' : ''} ORDER BY cs.due_at`, now, ...(subjectId ? [subjectId] : []));
    if (!due.length) throw new HttpError(409, 'nothing_due', 'Nothing is due for review right now.');
    for (const d of due.slice(0, Math.max(1, Math.floor(minutes / 3)))) slots.push(mk(d.id, 'review', 1));
  } else if (o.mode === 'exam') {
    const ids = o.conceptIds?.length ? o.conceptIds : o.itemId ? ctx.db.all<any>('SELECT concept_id FROM academic_item_concepts WHERE item_id=?', o.itemId).map((r) => r.concept_id) : [];
    if (!ids.length) throw new HttpError(409, 'no_topics', 'Link topics (concepts) to this test first — I will not guess its coverage.');
    const total = Math.max(ids.length, Math.floor(minutes / 2.5));
    for (let i = 0; i < total; i++) { const id = ids[i % ids.length]; const ex = slots.find((s) => s.conceptId === id); if (ex) ex.n++; else slots.push(mk(id, 'exam', 1)); }
  } else {
    // mixed / from today's plan
    const inputs = buildPlanInputs(ctx, { minutes });
    const plan = planToday({ ...inputs, minutes });
    const only = o.conceptIds?.length ? plan.tasks.filter((t) => o.conceptIds!.includes(t.conceptId)) : plan.tasks;
    for (const t of only) slots.push(mk(t.conceptId, t.kind === 'diagnose' ? 'diagnostic' : t.kind === 'repair' ? 'repair' : t.kind === 'practice' ? 'practice' : 'review', t.kind === 'practice' ? 3 : t.kind === 'repair' ? 2 : 1));
    if (!slots.length) throw new HttpError(409, 'nothing_to_do', 'There is nothing to study yet. Add material and confirm some concepts first.');
  }
  if (!subjectId && slots.length) subjectId = ctx.db.get<any>('SELECT subject_id FROM concepts WHERE id = ?', slots[0].conceptId)?.subject_id ?? null;
  const id = uid();
  ctx.db.run('INSERT INTO sessions (id,subject_id,mode,status,planned_minutes,started_at,slots,hold_feedback,item_id) VALUES (?,?,?,?,?,?,?,?,?)',
    id, subjectId, o.mode, 'active', minutes, ctx.now(), JSON.stringify(slots), Number(o.mode === 'exam'), o.itemId ?? null);
  return { id };
}

/* --------------------------- picking the next question --------------------------- */

function chooseSlot(slots: Slot[], mode: string, lastConcept: string | null, force: string | null): number {
  const open = slots.map((s, i) => ({ s, i })).filter((x) => x.s.done < x.s.n);
  if (!open.length) return -1;
  const pri = open.find((x) => x.s.priority); // a follow-up the last answer called for (a prerequisite check, a fresh application)
  if (pri) return pri.i;
  const forced = force ? open.find((x) => x.s.conceptId === force) : null;
  if (forced) return forced.i;
  if (mode === 'practice') return open[0].i; // deep practice on one concept at a time
  const other = open.filter((x) => x.s.conceptId !== lastConcept);
  const pool = other.length ? other : open;
  return pool.sort((a, b) => (b.s.n - b.s.done) - (a.s.n - a.s.done) || a.i - b.i)[0].i;
}

async function advance(ctx: Ctx, session: any, opts: { useOffline?: boolean } = {}): Promise<Current | null> {
  const slots = parse<Slot[]>(session.slots, []);
  const notes = notesOf(session);
  const act = notes.next ?? null;
  const last = ctx.db.get<any>('SELECT concept_id, question_id FROM attempts WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', session.id);
  const followUp = act && !['move_on', 'confirm_grade'].includes(act.type) ? last?.concept_id ?? null : null;
  const idx = chooseSlot(slots, session.mode, last?.concept_id ?? null, followUp);
  if (idx < 0) return null;
  const slot = slots[idx];
  const asked = ctx.db.all<any>('SELECT question_id FROM attempts WHERE session_id = ?', session.id).map((r) => r.question_id);
  const lastKind = last ? ctx.db.get<any>('SELECT kind FROM questions WHERE id=?', last.question_id)?.kind : null;
  const lastWrong = last ? ctx.db.get<any>('SELECT correctness, idk FROM attempts WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', session.id) : null;
  let act2 = act;
  if (!act2 || !act2.focus) { // nothing from the last answer: a saved, unchecked confusion on THIS concept still shapes the next question
    const askedDisc = ctx.db.get<any>("SELECT COUNT(*) n FROM attempts a JOIN questions q ON q.id=a.question_id WHERE a.session_id=? AND a.concept_id=? AND q.focus='discriminate'", session.id, slot.conceptId).n > 0;
    act2 = (slot.purpose !== 'review' && slot.purpose !== 'exam' ? memoryAction(ctx, slot.conceptId, askedDisc) : null) ?? act;
  }
  const sameConcept = !!act2 && (slot.conceptId === last?.concept_id || !!act2.prerequisite || act2 !== act);
  const q = await pickQuestion(ctx, { conceptId: slot.conceptId, purpose: slot.done > 0 && slot.purpose === 'practice' ? 'practice' : slot.purpose, exclude: asked, lastKind, easier: !!(lastWrong && (lastWrong.idk || (lastWrong.correctness ?? 1) < 0.4)), useOffline: opts.useOffline, action: sameConcept && act2?.focus ? act2 : undefined });
  const cur: Current = { questionId: q.id, conceptId: q.concept_id, purpose: slot.purpose, servedAt: ctx.now(), hintsShown: 0, revealed: false, attemptId: null, why: sameConcept ? act2?.reason ?? null : null };
  ctx.db.run('UPDATE sessions SET current = ?, notes = ? WHERE id = ?', JSON.stringify(cur), JSON.stringify({ ...notes, next: null } satisfies Notes), session.id);
  return cur;
}

/* --------------------------- views --------------------------- */

const PURPOSE_LABEL: Record<Purpose, string> = {
  diagnostic: 'Quick check', practice: 'Practice', review: 'Review', repair: 'Fixing a mistake pattern', transfer: 'Fresh question', exam: 'Test practice',
};

function revealPayload(q: QuestionRow) {
  const spec = parse<any>(q.answer_spec, {});
  const choices = parse<{ text: string }[] | null>(q.choices, null);
  const rubric = parse<any>(q.rubric, null);
  let correctAnswer = '';
  if (spec.type === 'choice') correctAnswer = choices?.[spec.correct]?.text ?? '';
  else if (spec.type?.startsWith('math')) correctAnswer = spec.answer;
  else correctAnswer = rubric?.sample ? `Sample answer: ${rubric.sample}` : (rubric?.keyPoints ?? []).map((k: any) => `• ${k.point}`).join('\n');
  return { correctAnswer, explanation: q.explanation, workedExample: q.worked_example, keyPoints: (rubric?.keyPoints ?? []).map((k: any) => k.point as string) };
}

export async function sessionView(ctx: Ctx, id: string, opts: { useOffline?: boolean } = {}) {
  let s = ctx.db.get<any>('SELECT * FROM sessions WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'not_found', 'Session not found.');
  const slots = parse<Slot[]>(s.slots, []);
  const progress = { answered: slots.reduce((a, x) => a + x.done, 0), planned: slots.reduce((a, x) => a + x.n, 0) };
  const base = { id: s.id, mode: s.mode, status: s.status, holdFeedback: !!s.hold_feedback, plannedMinutes: s.planned_minutes, startedAt: s.started_at, subjectId: s.subject_id, progress };
  if (s.status !== 'active') return { ...base, phase: 'done' as const, summary: parse(s.summary, null) };
  let cur = parse<Current | null>(s.current, null);
  if (!cur) {
    cur = await advance(ctx, s, opts); // may throw (AI failure) — session state is untouched so the client can retry
    if (!cur) return { ...base, phase: 'ready_to_finish' as const };
    s = ctx.db.get<any>('SELECT * FROM sessions WHERE id = ?', id);
  }
  const q = getQuestion(ctx, cur.questionId);
  const concept = ctx.db.get<any>('SELECT id, name FROM concepts WHERE id = ?', cur.conceptId);
  const hints = parse<string[]>(q.hints, []).slice(0, cur.hintsShown);
  if (cur.attemptId) {
    const a = ctx.db.get<any>('SELECT * FROM attempts WHERE id = ?', cur.attemptId);
    return { ...base, phase: 'feedback' as const, purpose: PURPOSE_LABEL[cur.purpose], concept, question: publicQuestion(q), hints, attemptId: a.id, answer: a.answer_text, feedback: s.hold_feedback ? null : parse(a.diagnosis, null), clarifications: s.hold_feedback ? [] : clarifications(ctx, a.id), progress };
  }
  return { ...base, phase: 'question' as const, purpose: PURPOSE_LABEL[cur.purpose], concept, question: publicQuestion(q), hints, revealed: cur.revealed ? revealPayload(q) : null, servedAt: cur.servedAt, why: cur.why ?? null };
}

/* --------------------------- hints / reveal --------------------------- */

function currentOf(ctx: Ctx, sessionId: string, questionId: string) {
  const s = ctx.db.get<any>('SELECT * FROM sessions WHERE id = ?', sessionId);
  if (!s || s.status !== 'active') throw new HttpError(409, 'session_inactive', 'This session is no longer active.');
  const cur = parse<Current | null>(s.current, null);
  if (!cur || cur.questionId !== questionId) throw new HttpError(409, 'stale_question', 'That question is no longer the current one. Reload to continue.');
  return { s, cur };
}

export function requestHint(ctx: Ctx, sessionId: string, questionId: string) {
  const { s, cur } = currentOf(ctx, sessionId, questionId);
  if (s.hold_feedback) throw new HttpError(409, 'exam_mode', 'Hints are off in test mode.');
  if (cur.attemptId) throw new HttpError(409, 'already_answered', 'This question is already answered.');
  const hints = parse<string[]>(getQuestion(ctx, questionId).hints, []);
  if (cur.hintsShown < hints.length) { cur.hintsShown++; ctx.db.run('UPDATE sessions SET current=? WHERE id=?', JSON.stringify(cur), sessionId); }
  return { hints: hints.slice(0, cur.hintsShown), remaining: hints.length - cur.hintsShown };
}

export function revealAnswer(ctx: Ctx, sessionId: string, questionId: string) {
  const { s, cur } = currentOf(ctx, sessionId, questionId);
  if (s.hold_feedback) throw new HttpError(409, 'exam_mode', 'Answers are held until the end of the test.');
  if (cur.attemptId) throw new HttpError(409, 'already_answered', 'This question is already answered.');
  cur.revealed = true;
  ctx.db.run('UPDATE sessions SET current=? WHERE id=?', JSON.stringify(cur), sessionId);
  return revealPayload(getQuestion(ctx, questionId));
}

/* --------------------------- grading --------------------------- */

export interface Outcome {
  status: GradeStatus; correctness: number | null; source: GradeSource; confidence: 'high' | 'medium' | 'low' | null; feedback: string;
  tags: string[]; slip?: boolean; misconception?: { label: string; description: string; origin: 'observed' | 'ai_inferred' }; rubricPoints?: { point: string; met: boolean }[];
  unparseable?: string; nextStep?: string; model?: string | null;
  chosenMisconception?: string | null; chosenText?: string | null; graderKind?: MistakeKind | null; confusedName?: string | null;
}

const MATH_TAG_INFO: Record<string, { label: string; description: string; slip: boolean }> = {
  sign_error: { label: 'Sign slip', description: 'Lost or flipped a negative sign while solving.', slip: true },
  arithmetic_slip: { label: 'Arithmetic slip', description: 'Method looked reasonable but a calculation was off.', slip: true },
  flipped_inequality: { label: 'Forgets to flip the inequality', description: 'Did not reverse the inequality when multiplying/dividing by a negative number (or chose the wrong side of the boundary).', slip: false },
  missing_solution: { label: 'Misses a case', description: 'Found only some solutions — e.g. did not consider both cases of an absolute value.', slip: false },
  extraneous_solution: { label: 'Skips checking solutions', description: 'Kept a value that does not satisfy the original equation (extraneous solution).', slip: false },
  endpoint_inclusion: { label: 'Endpoint inclusion', description: 'Confused when an endpoint is included (≤, ≥, [ ]) or excluded (<, >, ( )).', slip: false },
};

export async function gradeQuestion(ctx: Ctx, q: QuestionRow, answer: string, reasoning: string): Promise<Outcome> {
  const spec = parse<any>(q.answer_spec, {});
  const choices = parse<{ text: string; misconception?: string }[] | null>(q.choices, null);
  if (spec.type === 'choice') {
    const idx = Number(answer);
    if (!Number.isInteger(idx) || !choices || idx < 0 || idx >= choices.length) throw new HttpError(400, 'invalid', 'Pick one of the choices.');
    const ok = idx === spec.correct;
    return {
      status: 'graded', correctness: ok ? 1 : 0, source: 'deterministic', confidence: 'high', tags: [], chosenMisconception: !ok ? choices[idx].misconception ?? null : null, chosenText: !ok ? choices[idx].text : null,
      feedback: ok ? 'Correct.' : `Not quite.${choices[idx].misconception ? ` That choice is easy to mix up: ${choices[idx].misconception.toLowerCase()}.` : ''}`,
      misconception: !ok && choices[idx].misconception ? { label: choices[idx].misconception!, description: `Chose “${choices[idx].text.slice(0, 120)}” for a question about this concept.`, origin: 'observed' } : undefined,
    };
  }
  if (typeof spec.type === 'string' && spec.type.startsWith('math')) {
    const r = checkMath(spec as MathSpec, answer);
    if (r.status === 'unparseable') return { status: 'pending', correctness: null, source: 'deterministic', confidence: null, feedback: r.message, tags: [], unparseable: r.message };
    const unverifiedKey = q.verified !== 1 && r.correctness < 1;
    const tag = r.tags[0];
    const info = tag ? MATH_TAG_INFO[tag] : undefined;
    return {
      status: unverifiedKey ? 'uncertain' : 'graded', correctness: r.correctness, source: 'deterministic', confidence: unverifiedKey ? 'low' : 'high', tags: r.tags, slip: info?.slip,
      feedback: unverifiedKey ? `${r.message} (This answer key could not be independently verified, so this result is not counted until you confirm it.)` : r.message,
      misconception: info && r.correctness < 1 && !unverifiedKey ? { label: info.label, description: info.description, origin: 'observed' } : undefined,
    };
  }
  // open-ended: rubric-based
  const rubric = parse<any>(q.rubric, { keyPoints: [], sample: null });
  const concept = ctx.db.get<any>('SELECT id, name, summary, subject_id FROM concepts WHERE id=?', q.concept_id);
  const chunks = ctx.db.all<any>('SELECT ch.id, ch.label, ch.text, ch.source_id, ch.char_start FROM source_chunks ch JOIN sources s ON s.id=ch.source_id WHERE s.subject_id=? AND s.status=\'confirmed\'', concept.subject_id);
  const refIds = ctx.db.all<any>('SELECT chunk_id FROM concept_refs WHERE concept_id=? AND chunk_id IS NOT NULL', concept.id).map((r) => r.chunk_id);
  const context = buildContext({ concept: { ...concept, subjectId: concept.subject_id }, chunks: modelChunks(ctx, chunks), refChunkIds: refIds, memories: [], misconceptions: [], maxChars: 2500 });
  try {
    const g = await ctx.ai.gradeAnswer({
      question: { prompt: q.prompt, kind: q.kind, rubric: rubric.keyPoints ?? [], sampleAnswer: rubric.sample ?? undefined },
      answer: clip(answer, MAX_ANSWER), reasoning: clip(reasoning, MAX_ANSWER), excerpts: context.sourceExcerpts.map((e) => ({ label: e.label, text: e.text })), gradeLevel: getProfile(ctx.db).grade, knownIssues: knownIssuesFor(ctx, q.concept_id),
    });
    const sure = g.confidence !== 'low';
    return {
      model: ctx.ai.live ? ctx.ai.modelFor?.('grade') ?? null : null,
      status: sure ? 'graded' : 'uncertain', correctness: g.correctness, source: ctx.ai.live ? 'ai' : g.confidence === 'high' ? 'deterministic' : 'heuristic', confidence: g.confidence, tags: [],
      feedback: g.feedback + (sure ? '' : ' (I am not sure about this grade — please confirm how you did.)'), rubricPoints: g.points.map((p) => ({ point: p.point, met: p.met })), nextStep: g.next_step,
      misconception: g.misconception && g.correctness < 0.8 ? { label: g.misconception.label, description: g.misconception.description, origin: 'ai_inferred' } : undefined,
      graderKind: g.mistake_kind && g.mistake_kind !== 'none' ? g.mistake_kind : null, confusedName: g.confused_with ?? null,
    };
  } catch (e) {
    if (e instanceof AIError) return { status: 'failed', correctness: null, source: 'ai', confidence: null, tags: [], feedback: `Grading is unavailable right now (${e.message}) Your answer is saved — you can retry grading or grade yourself.` };
    throw e;
  }
}

/* --------------------------- submitting an answer --------------------------- */

export interface AnswerInput { questionId: string; answer: string; reasoning?: string; confidence?: number | null; clientToken: string; idk?: boolean; revealedOnly?: boolean }

function displayAnswer(q: QuestionRow, a: string) {
  if (q.kind === 'multiple_choice') { const c = parse<{ text: string }[]>(q.choices, []); return c[Number(a)]?.text ?? a; }
  return a;
}

/* ---- diagnosing one answer ---- */

const siblingsOf = (ctx: Ctx, conceptId: string) => ctx.db.all<{ id: string; name: string }>("SELECT id, name FROM concepts WHERE status='confirmed' AND subject_id=(SELECT subject_id FROM concepts WHERE id=?) AND id != ?", conceptId, conceptId);
function findConfused(sibs: { id: string; name: string }[], texts: (string | null | undefined)[]) {
  const hay = texts.filter(Boolean).join(' \n ').toLowerCase();
  return sibs.find((x) => x.name.length >= 4 && hay.includes(x.name.toLowerCase())) ?? null;
}

export function diagnoseOutcome(ctx: Ctx, q: QuestionRow, o: Outcome, a: { answer: string; skipped: boolean }): Diagnosis | null {
  const sibs = siblingsOf(ctx, q.concept_id);
  const wrong = o.status === 'graded' && (o.correctness ?? 1) < 0.8;
  const confusedWith = findConfused(sibs, [o.chosenMisconception, o.confusedName, wrong && q.kind !== 'multiple_choice' ? a.answer : null, o.graderKind === 'concept_confusion' ? a.answer : null]);
  const rp = o.rubricPoints ?? [];
  return diagnose({
    questionKind: q.kind, correctness: o.correctness, gradeStatus: o.status, reportedUnclear: !!q.reported_unclear, idk: a.skipped, blank: !a.answer.trim() && !a.skipped,
    mathTags: o.tags, slipTag: o.slip, chosenMisconception: o.chosenMisconception ?? null, confusedWith, rubricMet: rp.filter((p) => p.met).length, rubricTotal: rp.length, graderKind: o.graderKind ?? null,
  });
}

/** The observed mistake as it will be remembered: a specific label when the app knows one, otherwise the kind. */
function describeMistake(d: Diagnosis, o: Outcome) {
  if (o.misconception) return { label: o.misconception.label, description: o.misconception.description, origin: o.misconception.origin };
  if (d.confusedWith) return { label: `Mixed up with “${d.confusedWith.name}”`, description: d.why, origin: 'observed' as const };
  return { label: MISTAKE_LABEL[d.kind], description: d.why, origin: (o.source === 'ai' ? 'ai_inferred' : 'observed') as 'observed' | 'ai_inferred' };
}

const PATTERN_DAYS = 30;
/** A "pattern" means the same observed mistake on at least two DIFFERENT questions within a month. One answer never makes one. */
function patternSupport(ctx: Ctx, conceptId: string, label: string, now: number, thisQuestionId: string, thisAttemptId?: string) {
  const rows = ctx.db.all<any>(`SELECT m.attempt_id, a.question_id FROM observed_mistakes m JOIN attempts a ON a.id = m.attempt_id WHERE m.concept_id = ? AND lower(m.label) = ? AND m.created_at > ? ${thisAttemptId ? 'AND m.attempt_id != ?' : ''}`,
    conceptId, label.toLowerCase().trim(), now - PATTERN_DAYS * DAY, ...(thisAttemptId ? [thisAttemptId] : []));
  const qs = new Set<string>(rows.map((r) => r.question_id)); qs.add(thisQuestionId);
  return { questions: qs.size, attemptIds: rows.map((r) => r.attempt_id as string) };
}
const NO_PATTERN: MistakeKind[] = ['missing_knowledge', 'unreliable'];

/* ---- what to do next ---- */

function weakestPrerequisite(ctx: Ctx, conceptId: string) {
  const rows = ctx.db.all<any>(`SELECT c.id, c.name, COALESCE(cs.level,'not_assessed') level FROM concept_prereqs p JOIN concepts c ON c.id = p.prereq_id AND c.status='confirmed' LEFT JOIN concept_state cs ON cs.concept_id = c.id WHERE p.concept_id = ?`, conceptId);
  const order: Record<string, number> = { not_assessed: 0, learning: 1, shaky: 2, solid: 9 };
  return rows.filter((r) => r.level !== 'solid').sort((x, y) => order[x.level] - order[y.level])[0] ?? null;
}

/** Another way to see the idea, used when the first explanation did not work: the student's own source wording and the plain-language summary. */
function alternativeExplanation(ctx: Ctx, q: QuestionRow) {
  const ref = ctx.db.get<any>('SELECT quote, label FROM concept_refs WHERE concept_id = ? AND stale = 0 ORDER BY rowid LIMIT 1', q.concept_id);
  const c = ctx.db.get<any>('SELECT name, summary FROM concepts WHERE id = ?', q.concept_id);
  const parts = [`Let’s look at it a different way. In short: ${c.summary || c.name}`];
  if (ref) parts.push(`Your material says (${ref.label}): “${ref.quote}”`);
  return parts.join(' ');
}

export async function submitAnswer(ctx: Ctx, sessionId: string, inp: AnswerInput) {
  if (!inp.clientToken) throw new HttpError(400, 'invalid', 'Missing submission token.');
  // duplicate submission (double click / retry after network error): return the original result
  const dup = ctx.db.get<any>('SELECT * FROM attempts WHERE client_token = ?', inp.clientToken);
  if (dup) return { duplicate: true, ...attemptResult(ctx, dup) };
  const { s, cur } = currentOf(ctx, sessionId, inp.questionId);
  if (cur.attemptId) throw new HttpError(409, 'already_answered', 'You already answered this question.');
  const q = getQuestion(ctx, inp.questionId);
  const answer = clip(inp.answer, MAX_ANSWER).trim(), reasoning = clip(inp.reasoning, MAX_ANSWER).trim();
  const idk = !!inp.idk, skippedAfterReveal = !!inp.revealedOnly && cur.revealed;
  if (!idk && !skippedAfterReveal && answer.length < TEXT_MIN_CHARS) throw new HttpError(400, 'empty', 'Write an answer first, or choose “I don’t know”.');
  const confidence = inp.confidence === 1 || inp.confidence === 2 || inp.confidence === 3 ? inp.confidence : null;
  const responseMs = Math.max(0, Math.min(ctx.now() - cur.servedAt, 30 * 60_000));

  let outcome: Outcome;
  if (idk || skippedAfterReveal) {
    outcome = { status: 'graded', correctness: 0, source: 'deterministic', confidence: 'high', tags: [], feedback: idk ? 'Thanks for saying so — that tells us exactly where to start. Here is a worked example; then you will try a similar one with less support.' : 'Answer revealed — this one will not count as independent practice.' };
  } else {
    outcome = await gradeQuestion(ctx, q, answer, reasoning);
    if (outcome.unparseable) return { unparseable: true, message: outcome.unparseable }; // nothing saved; the student's text stays in the box
  }
  const hold = !!s.hold_feedback;
  const attemptId = uid();
  const revealUsed = cur.revealed || idk || skippedAfterReveal;
  const independent = !revealUsed && cur.hintsShown === 0;
  const diag = diagnoseOutcome(ctx, q, outcome, { answer, skipped: idk || skippedAfterReveal });
  const mrec = diag && diag.kind !== 'unreliable' ? describeMistake(diag, outcome) : null;
  const now = ctx.now();
  const support = mrec && diag && !NO_PATTERN.includes(diag.kind) ? patternSupport(ctx, q.concept_id, mrec.label, now, q.id) : null;

  // teaching state for this session: consecutive misses, and what the next question should do
  const notes = notesOf(s); const fails = { ...(notes.fails ?? {}) }; const explained = { ...(notes.explained ?? {}) };
  const counted = outcome.status === 'graded';
  const wrong = counted && ((outcome.correctness ?? 0) < 0.8 || idk || revealUsed);
  if (counted) fails[q.concept_id] = wrong ? (fails[q.concept_id] ?? 0) + 1 : 0;
  if (wrong) explained[q.concept_id] = (explained[q.concept_id] ?? 0) + 1;
  const slotsBefore = parse<Slot[]>(s.slots, []);
  const slotNow = slotsBefore.find((x) => x.conceptId === cur.conceptId && x.done < x.n) ?? slotsBefore.find((x) => x.conceptId === cur.conceptId);
  const success = counted && (outcome.correctness ?? 0) >= 0.8 && independent;
  const concept = ctx.db.get<any>('SELECT name FROM concepts WHERE id=?', q.concept_id);
  const na = hold ? null : nextAction({
    mistake: diag?.kind ?? null, correctness: counted ? outcome.correctness : null, independent, confidence: confidence as 1 | 2 | 3 | null, confusedWith: diag?.confusedWith ?? null,
    missedPoints: (outcome.rubricPoints ?? []).filter((p) => !p.met).map((p) => p.point), streakIndependent: success ? (slotNow?.streak ?? 0) + 1 : 0, failuresOnConcept: fails[q.concept_id] ?? 0,
    prerequisite: wrong ? weakestPrerequisite(ctx, q.concept_id) : null, questionKind: q.kind, conceptName: concept.name,
  });
  const payload = buildFeedback(ctx, q, outcome, { hintsUsed: cur.hintsShown, revealed: revealUsed, idk, answer }, {
    diag, mistake: mrec, pattern: support && support.questions >= 2 ? { label: mrec!.label, count: support.questions } : null, na,
  });
  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO attempts (id,session_id,question_id,concept_id,answer_text,reasoning_text,confidence,hints_used,saw_answer,idk,response_ms,correctness,grade_status,grade_source,grade_confidence,feedback,diagnosis,feedback_shown,client_token,created_at,grade_model,mistake_kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, attemptId, sessionId, q.id, q.concept_id, answer, reasoning, confidence, cur.hintsShown, Number(revealUsed), Number(idk), responseMs,
      outcome.correctness, outcome.status, outcome.source, outcome.confidence, outcome.feedback, JSON.stringify(payload), Number(!hold), inp.clientToken, ctx.now(), outcome.model ?? null, diag?.kind ?? null);
    cur.attemptId = attemptId;
    // advance slot bookkeeping: failures add one more application (max +2); two independent successes in a row end a practice slot early
    const slots = slotsBefore;
    const slot = slots.find((x) => x.conceptId === cur.conceptId && x.done < x.n) ?? slots.find((x) => x.conceptId === cur.conceptId);
    if (slot) {
      slot.done++;
      const failed = idk || (outcome.status === 'graded' && (outcome.correctness ?? 1) < 0.8) || revealUsed;
      slot.streak = success ? slot.streak + 1 : 0;
      if (!hold && (slot.purpose === 'practice' || slot.purpose === 'repair') && failed && slot.extra < 2 && slot.done >= slot.n) { slot.n++; slot.extra++; }
      if (!hold && slot.purpose === 'practice' && slot.streak >= 2 && slot.done < slot.n) slot.n = slot.done; // enough independent evidence today: stop drilling
    }
    if (!hold && wrong && slot && slot.purpose === 'diagnostic' && !na?.prerequisite && (fails[q.concept_id] ?? 0) <= 1 && !slots.some((x) => x.conceptId === q.concept_id && x.priority && x.done < x.n)) slots.push({ conceptId: q.concept_id, purpose: 'practice', n: 1, done: 0, extra: 0, streak: 0, priority: true }); // a miss in a quick check gets one fresh follow-up now
    if (na?.prerequisite && !slots.some((x) => x.conceptId === na.prerequisite!.id && x.priority && x.done < x.n)) slots.push({ conceptId: na.prerequisite.id, purpose: 'diagnostic', n: 1, done: 0, extra: 0, streak: 0, priority: true });
    ctx.db.run('UPDATE sessions SET slots=?, current=?, active_ms=active_ms+?, notes=? WHERE id=?', JSON.stringify(slots), JSON.stringify(cur), Math.min(responseMs, 10 * 60_000), JSON.stringify({ next: na, fails, explained } satisfies Notes), sessionId);
    afterAttempt(ctx, attemptId, q, outcome, cur.purpose, diag);
  });
  const row = ctx.db.get<any>('SELECT * FROM attempts WHERE id=?', attemptId);
  if (hold) return { duplicate: false, held: true, attemptId, progress: await progressOf(ctx, sessionId) };
  return { duplicate: false, ...attemptResult(ctx, row) };
}

const progressOf = async (ctx: Ctx, id: string) => { const s = ctx.db.get<any>('SELECT slots FROM sessions WHERE id=?', id); const sl = parse<Slot[]>(s.slots, []); return { answered: sl.reduce((a, x) => a + x.done, 0), planned: sl.reduce((a, x) => a + x.n, 0) }; };

function attemptResult(ctx: Ctx, a: any) {
  const s = a.session_id ? ctx.db.get<any>('SELECT hold_feedback FROM sessions WHERE id=?', a.session_id) : null;
  return { attemptId: a.id, feedback: s?.hold_feedback ? null : parse(a.diagnosis, null), held: !!s?.hold_feedback };
}

export interface FeedbackPayload {
  verdict: 'correct' | 'partial' | 'incorrect' | 'unsure' | 'ungraded' | 'skipped'; headline: string; message: string;
  explanation: string | null; workedExample: string | null; correctAnswer: string | null; tags: string[]; rubricPoints: { point: string; met: boolean }[];
  gradeStatus: GradeStatus; canSelfGrade: boolean; canRetryGrading: boolean; counts: string; misconception: string | null; nextStep: string | null; yourAnswer: string;
  /** One observed mistake in THIS answer (not a claim about the student). */
  mistake: { kind: MistakeKind; label: string; why: string } | null;
  /** Set only when the same mistake was seen on at least two different questions. */
  pattern: { label: string; count: number } | null;
  /** What happens next and why, in plain words. */
  next: { type: string; reason: string } | null;
  altRepresentation: boolean;
}

function buildFeedback(ctx: Ctx, q: QuestionRow, o: Outcome, u: { hintsUsed: number; revealed: boolean; idk: boolean; answer: string },
  x: { diag?: Diagnosis | null; mistake?: { label: string; description: string } | null; pattern?: { label: string; count: number } | null; na?: NextAction | null } = {}): FeedbackPayload {
  const rev = revealPayload(q);
  const c = o.correctness ?? 0;
  const verdict: FeedbackPayload['verdict'] = u.idk || (u.revealed && !u.answer) ? 'skipped' : o.status === 'failed' ? 'ungraded' : o.status === 'uncertain' ? 'unsure' : c >= 0.8 ? 'correct' : c >= 0.4 ? 'partial' : 'incorrect';
  let counts: string;
  if (o.status === 'failed') counts = 'Not counted — grading failed. Retry grading or grade yourself.';
  else if (o.status === 'uncertain') counts = 'Not counted yet — this grade is uncertain. Confirm how you did and it will count.';
  else if (u.revealed || u.idk) counts = 'Counted as "needed help": it will not count as independent practice, and a fresh check is scheduled for later.';
  else if (u.hintsUsed > 0) counts = 'Counted as hint-assisted: partial credit as evidence, not independent mastery.';
  else counts = c >= 0.8 ? 'Counted as independent evidence.' : 'Counted — and a later fresh question will check whether the fix stuck.';
  const showExplain = verdict !== 'correct';
  const alt = !!x.na?.alternativeRepresentation;
  return {
    verdict, headline: verdict === 'correct' ? 'Correct' : verdict === 'partial' ? 'Partly right' : verdict === 'incorrect' ? 'Not yet' : verdict === 'skipped' ? 'Let’s look at it together' : verdict === 'unsure' ? 'I’m not sure about this one' : 'Saved, but not graded',
    message: o.feedback, explanation: alt ? alternativeExplanation(ctx, q) : showExplain || o.status !== 'graded' ? rev.explanation : null, workedExample: !alt && (u.idk || u.revealed || verdict === 'incorrect') ? rev.workedExample : null,
    correctAnswer: o.status === 'graded' && verdict === 'correct' ? null : rev.correctAnswer || null, tags: o.tags, rubricPoints: o.rubricPoints ?? [],
    gradeStatus: o.status, canSelfGrade: o.status === 'uncertain' || o.status === 'failed', canRetryGrading: o.status === 'failed', counts,
    misconception: x.pattern?.label ?? null, nextStep: o.nextStep ?? null, yourAnswer: displayAnswer(q, u.answer),
    mistake: x.diag && x.mistake ? { kind: x.diag.kind, label: x.mistake.label, why: x.diag.why } : x.diag?.kind === 'unreliable' ? { kind: 'unreliable', label: MISTAKE_LABEL.unreliable, why: x.diag.why } : null,
    pattern: x.pattern ?? null, next: x.na ? { type: x.na.type, reason: x.na.reason } : null, altRepresentation: alt,
  };
}

/* --------------------------- mistakes, repairs, state --------------------------- */

function afterAttempt(ctx: Ctx, attemptId: string, q: QuestionRow, o: Outcome, purpose: Purpose, diag: Diagnosis | null) {
  const now = ctx.now();
  ctx.db.run('DELETE FROM observed_mistakes WHERE attempt_id = ?', attemptId);
  if (diag && diag.kind !== 'unreliable') {
    const m = describeMistake(diag, o);
    ctx.db.run('INSERT INTO observed_mistakes (id,attempt_id,concept_id,kind,label,description,created_at) VALUES (?,?,?,?,?,?,?)', uid(), attemptId, q.concept_id, diag.kind, clip(m.label, 80), clip(m.description, 300), now);
    const sup = patternSupport(ctx, q.concept_id, m.label, now, q.id, attemptId);
    recordMistakeMemory(ctx, { conceptId: q.concept_id, attemptId, questionId: q.id, kind: diag.kind, label: m.label, description: m.description, confusedWith: diag.confusedWith, patternFormed: sup.questions >= 2, distinctQuestions: sup.questions });
    if (!NO_PATTERN.includes(diag.kind)) {
      if (sup.questions >= 2) {
        recordMisconception(ctx, q.concept_id, attemptId, { label: m.label, description: m.description, origin: m.origin }, now);
        for (const id of sup.attemptIds) ctx.db.run('INSERT OR IGNORE INTO misconception_evidence (misconception_id, attempt_id) SELECT id, ? FROM misconceptions WHERE concept_id=? AND lower(label)=lower(?) AND status != \'dismissed\'', id, q.concept_id, m.label);
      }
    }
  }
  const trace: TraceEntry[] = [];
  recomputeConcept(ctx, q.concept_id, trace);
  const mine = trace.find((t) => t.attemptId === attemptId);
  const att = ctx.db.get<any>('SELECT hints_used, saw_answer, idk FROM attempts WHERE id=?', attemptId);
  if (o.status === 'graded' && (o.correctness ?? 0) >= 0.8 && att && !att.hints_used && !att.saw_answer && !att.idk) recordImprovement(ctx, { conceptId: q.concept_id, attemptId, questionId: q.id, focus: q.focus ?? null });
  if (purpose === 'repair' && o.status === 'graded') ctx.db.run("UPDATE followups SET status='done', done_at=? WHERE concept_id=? AND kind='repair' AND status='open'", now, q.concept_id);
  if (mine?.counted && mine.kind === 'delayed_unaided') {
    ctx.db.run("UPDATE followups SET status='done', done_at=? WHERE concept_id=? AND kind='repair_check' AND status='open' AND earliest_at <= ?", now, q.concept_id, now);
    if (mine.success) {
      const repaired = ctx.db.run("UPDATE misconceptions SET status='repaired', repaired_at=? WHERE concept_id=? AND status='active' AND last_seen_at <= ?", now, q.concept_id, now - 20 * HOUR);
      if (repaired.changes) recomputeConcept(ctx, q.concept_id);
    }
  }
}

function recordMisconception(ctx: Ctx, conceptId: string, attemptId: string, m: { label: string; description: string; origin: 'observed' | 'ai_inferred' }, now: number) {
  const key = m.label.toLowerCase().trim();
  const ex = ctx.db.get<any>("SELECT id FROM misconceptions WHERE concept_id=? AND lower(label)=? AND status != 'dismissed'", conceptId, key);
  let id: string;
  if (ex) { id = ex.id; ctx.db.run("UPDATE misconceptions SET count=count+1, last_seen_at=?, status='active', repaired_at=NULL WHERE id=?", now, id); }
  else { id = uid(); ctx.db.run('INSERT INTO misconceptions (id,concept_id,label,description,status,origin,count,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)', id, conceptId, clip(m.label, 80), clip(m.description, 300), 'active', m.origin, 2, now, now); }
  ctx.db.run('INSERT OR IGNORE INTO misconception_evidence (misconception_id, attempt_id) VALUES (?,?)', id, attemptId);
  if (!ctx.db.get("SELECT 1 FROM followups WHERE misconception_id=? AND kind='repair' AND status='open'", id)) ctx.db.run("INSERT INTO followups (id,concept_id,misconception_id,kind,earliest_at,created_at) VALUES (?,?,?,?,?,?)", uid(), conceptId, id, 'repair', now, now);
  if (!ctx.db.get("SELECT 1 FROM followups WHERE misconception_id=? AND kind='repair_check' AND status='open'", id)) {
    // a later check may already be scheduled from the first observation: adopt it instead of adding a second one
    const generic = ctx.db.get<any>("SELECT id FROM followups WHERE concept_id=? AND kind='repair_check' AND status='open' AND misconception_id IS NULL ORDER BY earliest_at LIMIT 1", conceptId);
    if (generic) ctx.db.run('UPDATE followups SET misconception_id=? WHERE id=?', id, generic.id);
    else ctx.db.run("INSERT INTO followups (id,concept_id,misconception_id,kind,earliest_at,created_at) VALUES (?,?,?,?,?,?)", uid(), conceptId, id, 'repair_check', now + DAY, now);
  }
}

/** Saved notes about this student on this concept, passed to the grader and generator so memory changes teaching. */
export function knownIssuesFor(ctx: Ctx, conceptId: string): string[] {
  return ctx.db.all<any>("SELECT text FROM memories WHERE deleted_at IS NULL AND concept_id = ? ORDER BY updated_at DESC LIMIT 4", conceptId).map((r) => String(r.text).slice(0, 240));
}

/* --------------------------- clarification and unclear questions --------------------------- */

const MAX_CLARIFICATIONS = 4;
export function clarifications(ctx: Ctx, attemptId: string) {
  return ctx.db.all<any>('SELECT id, question, answer, ai, created_at FROM attempt_clarifications WHERE attempt_id = ? ORDER BY created_at, rowid', attemptId).map((r) => ({ id: r.id, ask: r.question, answer: r.answer, ai: !!r.ai, at: r.created_at }));
}

/**
 * Ask about ONE piece of feedback without leaving the question. The only context is this question, this answer, this feedback and the
 * concept's own source passages — never another question — so it cannot expose held-back questions. Not available while test-mode feedback is held.
 */
export async function clarify(ctx: Ctx, attemptId: string, text: string) {
  const a = ctx.db.get<any>('SELECT * FROM attempts WHERE id = ?', attemptId);
  if (!a) throw new HttpError(404, 'not_found', 'Attempt not found.');
  const sess = a.session_id ? ctx.db.get<any>('SELECT status, hold_feedback FROM sessions WHERE id = ?', a.session_id) : null;
  if (sess?.hold_feedback && sess.status === 'active') throw new HttpError(409, 'exam_mode', 'Questions about feedback open after the test, when feedback is shown.');
  const ask = clip(text, 500).trim();
  if (ask.length < 3) throw new HttpError(400, 'invalid', 'Type your question about this feedback.');
  if (ctx.db.get<any>('SELECT COUNT(*) n FROM attempt_clarifications WHERE attempt_id = ?', attemptId).n >= MAX_CLARIFICATIONS) throw new HttpError(409, 'limit', `You can ask up to ${MAX_CLARIFICATIONS} questions about one answer. Continue with the next question, or add a note in Memory.`);
  const q = getQuestion(ctx, a.question_id);
  const d = parse<FeedbackPayload | null>(a.diagnosis, null);
  const rev = revealPayload(q);
  const concept = ctx.db.get<any>('SELECT id, name, summary, subject_id FROM concepts WHERE id = ?', a.concept_id);
  let answer: string, ai = false;
  if (ctx.ai.live && ctx.ai.clarify) {
    const chunks = ctx.db.all<any>('SELECT ch.id, ch.label, ch.text, ch.source_id, ch.char_start FROM source_chunks ch JOIN sources s ON s.id=ch.source_id WHERE s.subject_id=? AND s.status=\'confirmed\'', concept.subject_id);
    const refIds = ctx.db.all<any>('SELECT chunk_id FROM concept_refs WHERE concept_id=? AND chunk_id IS NOT NULL AND stale=0', concept.id).map((r) => r.chunk_id);
    const context = buildContext({ concept: { ...concept, subjectId: concept.subject_id }, chunks: modelChunks(ctx, chunks), refChunkIds: refIds, memories: [], misconceptions: [], maxChars: 2000 });
    const r = await ctx.ai.clarify({ question: { prompt: q.prompt, kind: q.kind }, answer: displayAnswer(q, a.answer_text), feedback: d?.message ?? a.feedback, explanation: d?.explanation ?? null, keyPoints: rev.keyPoints, excerpts: context.sourceExcerpts.map((e) => ({ label: e.label, text: e.text })), conceptName: concept.name, ask, gradeLevel: getProfile(ctx.db).grade });
    answer = r.answer; ai = true;
  } else {
    // no AI configured: say so, and give back what is already known instead of pretending to answer
    const ref = ctx.db.get<any>('SELECT quote, label FROM concept_refs WHERE concept_id = ? AND stale = 0 ORDER BY rowid LIMIT 1', concept.id);
    answer = `I can’t answer free-form questions without an AI provider set up. What I have for this question: ${rev.explanation || concept.summary}${ref ? ` Your material says (${ref.label}): “${ref.quote}”` : ''}`;
  }
  const id = uid();
  ctx.db.run('INSERT INTO attempt_clarifications (id,attempt_id,question,answer,ai,created_at) VALUES (?,?,?,?,?,?)', id, attemptId, ask, answer, Number(ai), ctx.now());
  return { clarifications: clarifications(ctx, attemptId) };
}

/** The student says the question or grade is unclear. It stops counting as evidence and the question is never served again. */
export function reportUnclear(ctx: Ctx, attemptId: string) {
  const a = ctx.db.get<any>('SELECT * FROM attempts WHERE id = ?', attemptId);
  if (!a) throw new HttpError(404, 'not_found', 'Attempt not found.');
  ctx.db.tx(() => {
    ctx.db.run('UPDATE questions SET reported_unclear = 1, retired_at = COALESCE(retired_at, ?), retired_reason = COALESCE(retired_reason, ?) WHERE id = ?', ctx.now(), 'You reported this question or its grading as unclear.', a.question_id);
    const d = parse<FeedbackPayload | null>(a.diagnosis, null);
    if (d) {
      d.gradeStatus = 'uncertain'; d.verdict = 'unsure'; d.headline = 'Marked as unclear'; d.counts = 'Not counted — you reported this question or its grading as unclear. It will not be used again.';
      d.mistake = { kind: 'unreliable', label: MISTAKE_LABEL.unreliable, why: MISTAKE_BLURB.unreliable }; d.pattern = null; d.misconception = null; d.canSelfGrade = false;
      ctx.db.run('UPDATE attempts SET diagnosis = ? WHERE id = ?', JSON.stringify(d), attemptId);
    }
    ctx.db.run("UPDATE attempts SET grade_status = 'uncertain', mistake_kind = 'unreliable' WHERE id = ?", attemptId);
    ctx.db.run('DELETE FROM observed_mistakes WHERE attempt_id = ?', attemptId);
    recomputeConcept(ctx, a.concept_id);
  });
  return attemptResult(ctx, ctx.db.get<any>('SELECT * FROM attempts WHERE id=?', attemptId));
}

/* --------------------------- corrections & retries --------------------------- */

export function selfGrade(ctx: Ctx, attemptId: string, b: { correctness: number; note?: string }) {
  const a = ctx.db.get<any>('SELECT * FROM attempts WHERE id=?', attemptId);
  if (!a) throw new HttpError(404, 'not_found', 'Attempt not found.');
  if (![0, 0.5, 1].includes(b.correctness)) throw new HttpError(400, 'invalid', 'Choose: got it, partly, or missed it.');
  ctx.db.tx(() => {
    ctx.db.run("UPDATE attempts SET correctness=?, grade_status='graded', grade_source='student', grade_confidence='high', student_note=? WHERE id=?", b.correctness, clip(b.note, 300), attemptId);
    const d = parse<FeedbackPayload>(a.diagnosis, null as any);
    if (d) {
      d.gradeStatus = 'graded'; d.canSelfGrade = false; d.canRetryGrading = false;
      d.verdict = b.correctness >= 0.8 ? 'correct' : b.correctness >= 0.4 ? 'partial' : 'incorrect';
      d.headline = d.verdict === 'correct' ? 'Correct' : d.verdict === 'partial' ? 'Partly right' : 'Not yet';
      d.counts = 'Counted — based on your own grade (weighted a little lower than an automatic grade).';
      ctx.db.run('UPDATE attempts SET diagnosis=? WHERE id=?', JSON.stringify(d), attemptId);
    }
    recomputeConcept(ctx, a.concept_id);
  });
  return attemptResult(ctx, ctx.db.get<any>('SELECT * FROM attempts WHERE id=?', attemptId));
}

export async function regrade(ctx: Ctx, attemptId: string) {
  const a = ctx.db.get<any>('SELECT * FROM attempts WHERE id=?', attemptId);
  if (!a) throw new HttpError(404, 'not_found', 'Attempt not found.');
  if (a.grade_status === 'graded' && a.grade_source !== 'student') throw new HttpError(409, 'already_graded', 'This attempt is already graded.');
  const q = getQuestion(ctx, a.question_id);
  const o = await gradeQuestion(ctx, q, a.answer_text, a.reasoning_text);
  if (o.unparseable) throw new HttpError(422, 'unparseable', o.unparseable);
  const diag = diagnoseOutcome(ctx, q, o, { answer: a.answer_text, skipped: !!a.idk });
  const payload = buildFeedback(ctx, q, o, { hintsUsed: a.hints_used, revealed: !!a.saw_answer, idk: !!a.idk, answer: a.answer_text }, { diag, mistake: diag && diag.kind !== 'unreliable' ? describeMistake(diag, o) : null });
  ctx.db.tx(() => {
    ctx.db.run('UPDATE attempts SET correctness=?, grade_status=?, grade_source=?, grade_confidence=?, feedback=?, diagnosis=?, grade_model=?, mistake_kind=? WHERE id=?', o.correctness, o.status, o.source, o.confidence, o.feedback, JSON.stringify(payload), o.model ?? null, diag?.kind ?? null, attemptId);
    afterAttempt(ctx, attemptId, q, o, 'practice', diag);
  });
  return attemptResult(ctx, ctx.db.get<any>('SELECT * FROM attempts WHERE id=?', attemptId));
}

/* --------------------------- next / finish --------------------------- */

export async function nextQuestion(ctx: Ctx, sessionId: string, opts: { useOffline?: boolean } = {}) {
  const s = ctx.db.get<any>('SELECT * FROM sessions WHERE id=?', sessionId);
  if (!s) throw new HttpError(404, 'not_found', 'Session not found.');
  const cur = parse<Current | null>(s.current, null);
  if (cur && !cur.attemptId) throw new HttpError(409, 'unanswered', 'Answer this question (or choose “I don’t know”) first.');
  ctx.db.run('UPDATE sessions SET current=NULL WHERE id=?', sessionId);
  const slots = parse<Slot[]>(s.slots, []);
  if (!slots.some((x) => x.done < x.n)) return finishSession(ctx, sessionId);
  return sessionView(ctx, sessionId, opts);
}

export async function finishSession(ctx: Ctx, sessionId: string) {
  const s = ctx.db.get<any>('SELECT * FROM sessions WHERE id=?', sessionId);
  if (!s) throw new HttpError(404, 'not_found', 'Session not found.');
  if (s.status === 'active') {
    const summary = buildSummary(ctx, s);
    ctx.db.run("UPDATE sessions SET status='completed', ended_at=?, current=NULL, summary=? WHERE id=?", ctx.now(), JSON.stringify(summary), sessionId);
  }
  return sessionView(ctx, sessionId);
}

export function abandonSession(ctx: Ctx, sessionId: string) {
  ctx.db.run("UPDATE sessions SET status='abandoned', ended_at=? WHERE id=? AND status='active'", ctx.now(), sessionId);
}

function buildSummary(ctx: Ctx, s: any) {
  const rows = ctx.db.all<any>('SELECT a.*, c.name AS concept_name FROM attempts a JOIN concepts c ON c.id=a.concept_id WHERE a.session_id=? ORDER BY a.created_at, a.rowid', s.id);
  const by = new Map<string, { id: string; name: string; right: number; partial: number; wrong: number; notCounted: number; helped: number; n: number }>();
  for (const a of rows) {
    const e = by.get(a.concept_id) ?? { id: a.concept_id, name: a.concept_name, right: 0, partial: 0, wrong: 0, notCounted: 0, helped: 0, n: 0 };
    e.n++;
    if (a.grade_status !== 'graded') e.notCounted++;
    else if (a.hints_used > 0 || a.saw_answer || a.idk) e.helped++;
    else if (a.correctness >= 0.8) e.right++; else if (a.correctness >= 0.4) e.partial++; else e.wrong++;
    by.set(a.concept_id, e);
  }
  const concepts = [...by.values()].map((e) => ({ ...e, level: ctx.db.get<any>('SELECT level FROM concept_state WHERE concept_id=?', e.id)?.level ?? 'not_assessed' }));
  const total = rows.length;
  const independentGraded = rows.filter((a) => a.grade_status === 'graded' && !a.hints_used && !a.saw_answer && !a.idk);
  const ok = independentGraded.filter((a) => a.correctness >= 0.8).length;
  const mis = ctx.db.all<any>("SELECT DISTINCT m.label FROM misconceptions m JOIN misconception_evidence e ON e.misconception_id=m.id JOIN attempts a ON a.id=e.attempt_id WHERE a.session_id=?", s.id).map((r) => r.label);
  const minutes = Math.max(1, Math.round(rows.reduce((t, a) => t + Math.min(a.response_ms ?? 0, 10 * 60_000), 0) / 60_000));
  const nextSteps: string[] = [];
  if (mis.length) nextSteps.push(`A fix for “${mis[0]}” is queued, with a fresh check in a day or so.`);
  const uncertain = rows.filter((a) => a.grade_status === 'uncertain' || a.grade_status === 'failed').length;
  if (uncertain) nextSteps.push(`${uncertain} answer${uncertain === 1 ? '' : 's'} could not be graded with confidence — confirm them in History so they count.`);
  const due = concepts.map((c) => ctx.db.get<any>('SELECT due_at FROM concept_state WHERE concept_id=?', c.id)?.due_at).filter(Boolean).sort()[0];
  if (due) nextSteps.push(`Next review is due ${new Date(due).toISOString().slice(0, 10)}.`);
  const out: any = { answered: total, independentCorrect: ok, independentTotal: independentGraded.length, helped: rows.filter((a) => a.hints_used || a.saw_answer || a.idk).length, notCounted: uncertain, minutes, concepts, misconceptions: mis, nextSteps, mode: s.mode };
  if (s.mode === 'exam') {
    const graded = rows.filter((a) => a.grade_status === 'graded');
    const pts = graded.reduce((t, a) => t + (a.correctness ?? 0), 0);
    const w = wilson(Math.round(pts), graded.length);
    const linked = s.item_id ? ctx.db.all<any>('SELECT concept_id FROM academic_item_concepts WHERE item_id=?', s.item_id).length : concepts.length;
    out.exam = {
      questions: total, graded: graded.length, score: graded.length ? pts / graded.length : null, range: w.low === null ? null : [w.low, w.high],
      coverage: { covered: concepts.length, linked },
      note: 'This is how you did on these questions only. It is not a prediction of your test grade: the questions are a small sample and the real test may weight topics differently.',
      byConcept: concepts.map((c) => ({ id: c.id, name: c.name, right: c.right, partial: c.partial, wrong: c.wrong + c.helped, notCounted: c.notCounted, n: c.n })),
      recommendation: concepts.filter((c) => c.wrong + c.helped >= c.right).sort((a, b) => (b.wrong + b.helped) - (a.wrong + a.helped))[0]?.name ?? null,
    };
  }
  return out;
}

export function history(ctx: Ctx, limit = 40) {
  return ctx.db.all<any>(`SELECT a.id, a.created_at, a.answer_text, a.correctness, a.grade_status, a.grade_source, a.hints_used, a.saw_answer, a.idk, a.confidence, a.feedback,
    q.prompt, q.kind, c.name AS concept FROM attempts a JOIN questions q ON q.id=a.question_id JOIN concepts c ON c.id=a.concept_id
    LEFT JOIN sessions s ON s.id = a.session_id WHERE COALESCE(s.hold_feedback,0)=0 OR s.status != 'active' ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`, limit)
    .map((a) => ({ id: a.id, at: a.created_at, prompt: a.prompt, kind: a.kind, concept: a.concept, answer: a.kind === 'multiple_choice' ? '' : a.answer_text, correctness: a.correctness, gradeStatus: a.grade_status, gradeSource: a.grade_source, hints: a.hints_used, sawAnswer: !!a.saw_answer, idk: !!a.idk, confidence: a.confidence, feedback: a.feedback }));
}
export { LEVEL_LABEL, isDue };
