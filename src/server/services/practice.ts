/**
 * The practice loop: session -> question -> (hints) -> attempt -> grade -> feedback -> next.
 * Everything that affects scheduling is derived from the attempt log by core/learning.ts.
 */
import { AIError } from '../../ai/provider';
import { checkMath, MathSpec } from '../../core/mathCheck';
import { AttemptRecord, replay, TraceEntry, isDue, LEVEL_LABEL, GradeSource, GradeStatus } from '../../core/learning';
import { planToday } from '../../core/priority';
import { buildContext } from '../../core/retrieval';
import { wilson } from '../../core/stats';
import { HOUR, DAY } from '../../core/time';
import { uid } from '../db';
import { Ctx, HttpError, clip, getProfile, getSchedulerParams, parse } from './common';
import { modelChunks } from './sourceSafety';
import { PickOpts, QuestionRow, getQuestion, pickQuestion, publicQuestion } from './questions';
import { buildPlanInputs } from './plan';

type Purpose = PickOpts['purpose'];
interface Slot { conceptId: string; purpose: Purpose; n: number; done: number; extra: number; streak: number }
interface Current { questionId: string; conceptId: string; purpose: Purpose; servedAt: number; hintsShown: number; revealed: boolean; attemptId: string | null; fallbackOffline?: boolean }

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

function chooseSlot(slots: Slot[], mode: string, lastConcept: string | null): number {
  const open = slots.map((s, i) => ({ s, i })).filter((x) => x.s.done < x.s.n);
  if (!open.length) return -1;
  if (mode === 'practice') return open[0].i; // deep practice on one concept at a time
  const other = open.filter((x) => x.s.conceptId !== lastConcept);
  const pool = other.length ? other : open;
  return pool.sort((a, b) => (b.s.n - b.s.done) - (a.s.n - a.s.done) || a.i - b.i)[0].i;
}

async function advance(ctx: Ctx, session: any, opts: { useOffline?: boolean } = {}): Promise<Current | null> {
  const slots = parse<Slot[]>(session.slots, []);
  const last = ctx.db.get<any>('SELECT concept_id, question_id FROM attempts WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', session.id);
  const idx = chooseSlot(slots, session.mode, last?.concept_id ?? null);
  if (idx < 0) return null;
  const slot = slots[idx];
  const asked = ctx.db.all<any>('SELECT question_id FROM attempts WHERE session_id = ?', session.id).map((r) => r.question_id);
  const lastKind = last ? ctx.db.get<any>('SELECT kind FROM questions WHERE id=?', last.question_id)?.kind : null;
  const lastWrong = last ? ctx.db.get<any>('SELECT correctness, idk FROM attempts WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', session.id) : null;
  const q = await pickQuestion(ctx, { conceptId: slot.conceptId, purpose: slot.done > 0 && slot.purpose === 'practice' ? 'practice' : slot.purpose, exclude: asked, lastKind, easier: !!(lastWrong && (lastWrong.idk || (lastWrong.correctness ?? 1) < 0.4)), useOffline: opts.useOffline });
  const cur: Current = { questionId: q.id, conceptId: q.concept_id, purpose: slot.purpose, servedAt: ctx.now(), hintsShown: 0, revealed: false, attemptId: null };
  ctx.db.run('UPDATE sessions SET current = ? WHERE id = ?', JSON.stringify(cur), session.id);
  return cur;
}

/* --------------------------- views --------------------------- */

const PURPOSE_LABEL: Record<Purpose, string> = {
  diagnostic: 'Quick check', practice: 'Practice', review: 'Review', repair: 'Fixing a mistake pattern', transfer: 'New situation', exam: 'Test practice',
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
    return { ...base, phase: 'feedback' as const, purpose: PURPOSE_LABEL[cur.purpose], concept, question: publicQuestion(q), hints, attemptId: a.id, answer: a.answer_text, feedback: s.hold_feedback ? null : parse(a.diagnosis, null), progress };
  }
  return { ...base, phase: 'question' as const, purpose: PURPOSE_LABEL[cur.purpose], concept, question: publicQuestion(q), hints, revealed: cur.revealed ? revealPayload(q) : null, servedAt: cur.servedAt };
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
      status: 'graded', correctness: ok ? 1 : 0, source: 'deterministic', confidence: 'high', tags: [],
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
  const chunks = ctx.db.all<any>('SELECT ch.id, ch.label, ch.text, ch.source_id, ch.char_start FROM source_chunks ch JOIN sources s ON s.id=ch.source_id WHERE s.subject_id=?', concept.subject_id);
  const refIds = ctx.db.all<any>('SELECT chunk_id FROM concept_refs WHERE concept_id=? AND chunk_id IS NOT NULL', concept.id).map((r) => r.chunk_id);
  const context = buildContext({ concept: { ...concept, subjectId: concept.subject_id }, chunks: modelChunks(ctx, chunks), refChunkIds: refIds, memories: [], misconceptions: [], maxChars: 2500 });
  try {
    const g = await ctx.ai.gradeAnswer({
      question: { prompt: q.prompt, kind: q.kind, rubric: rubric.keyPoints ?? [], sampleAnswer: rubric.sample ?? undefined },
      answer: clip(answer, MAX_ANSWER), reasoning: clip(reasoning, MAX_ANSWER), excerpts: context.sourceExcerpts.map((e) => ({ label: e.label, text: e.text })),
    });
    const sure = g.confidence !== 'low';
    return {
      model: ctx.ai.live ? ctx.ai.modelFor?.('grade') ?? null : null,
      status: sure ? 'graded' : 'uncertain', correctness: g.correctness, source: ctx.ai.live ? 'ai' : g.confidence === 'high' ? 'deterministic' : 'heuristic', confidence: g.confidence, tags: [],
      feedback: g.feedback + (sure ? '' : ' (I am not sure about this grade — please confirm how you did.)'), rubricPoints: g.points.map((p) => ({ point: p.point, met: p.met })), nextStep: g.next_step,
      misconception: g.misconception && g.correctness < 0.8 ? { label: g.misconception.label, description: g.misconception.description, origin: 'ai_inferred' } : undefined,
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
  const payload = buildFeedback(ctx, q, outcome, { hintsUsed: cur.hintsShown, revealed: revealUsed, idk, answer });
  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO attempts (id,session_id,question_id,concept_id,answer_text,reasoning_text,confidence,hints_used,saw_answer,idk,response_ms,correctness,grade_status,grade_source,grade_confidence,feedback,diagnosis,feedback_shown,client_token,created_at,grade_model)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, attemptId, sessionId, q.id, q.concept_id, answer, reasoning, confidence, cur.hintsShown, Number(revealUsed), Number(idk), responseMs,
      outcome.correctness, outcome.status, outcome.source, outcome.confidence, outcome.feedback, JSON.stringify(payload), Number(!hold), inp.clientToken, ctx.now(), outcome.model ?? null);
    cur.attemptId = attemptId;
    // advance slot bookkeeping: failures add one more application (max +2); two independent successes in a row end a practice slot early
    const slots = parse<Slot[]>(s.slots, []);
    const slot = slots.find((x) => x.conceptId === cur.conceptId && x.done < x.n) ?? slots.find((x) => x.conceptId === cur.conceptId);
    if (slot) {
      slot.done++;
      const success = outcome.status === 'graded' && (outcome.correctness ?? 0) >= 0.8 && !revealUsed && cur.hintsShown === 0;
      const failed = idk || (outcome.status === 'graded' && (outcome.correctness ?? 1) < 0.8) || revealUsed;
      slot.streak = success ? slot.streak + 1 : 0;
      if (!hold && (slot.purpose === 'practice' || slot.purpose === 'repair') && failed && slot.extra < 2 && slot.done >= slot.n) { slot.n++; slot.extra++; }
      if (!hold && slot.purpose === 'practice' && slot.streak >= 2 && slot.done < slot.n) slot.n = slot.done; // enough independent evidence today: stop drilling
    }
    ctx.db.run('UPDATE sessions SET slots=?, current=?, active_ms=active_ms+? WHERE id=?', JSON.stringify(slots), JSON.stringify(cur), Math.min(responseMs, 10 * 60_000), sessionId);
    afterAttempt(ctx, attemptId, q, outcome, cur.purpose);
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
}

function buildFeedback(ctx: Ctx, q: QuestionRow, o: Outcome, u: { hintsUsed: number; revealed: boolean; idk: boolean; answer: string }): FeedbackPayload {
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
  return {
    verdict, headline: verdict === 'correct' ? 'Correct' : verdict === 'partial' ? 'Partly right' : verdict === 'incorrect' ? 'Not yet' : verdict === 'skipped' ? 'Let’s look at it together' : verdict === 'unsure' ? 'I’m not sure about this one' : 'Saved, but not graded',
    message: o.feedback, explanation: showExplain || o.status !== 'graded' ? rev.explanation : null, workedExample: u.idk || u.revealed || verdict === 'incorrect' ? rev.workedExample : null,
    correctAnswer: o.status === 'graded' && verdict === 'correct' ? null : rev.correctAnswer || null, tags: o.tags, rubricPoints: o.rubricPoints ?? [],
    gradeStatus: o.status, canSelfGrade: o.status === 'uncertain' || o.status === 'failed', canRetryGrading: o.status === 'failed', counts,
    misconception: o.misconception?.label ?? null, nextStep: o.nextStep ?? null, yourAnswer: displayAnswer(q, u.answer),
  };
}

/* --------------------------- mistakes, repairs, state --------------------------- */

function afterAttempt(ctx: Ctx, attemptId: string, q: QuestionRow, o: Outcome, purpose: Purpose) {
  const now = ctx.now();
  const a = ctx.db.get<any>('SELECT * FROM attempts WHERE id=?', attemptId);
  if (o.status === 'graded' && o.misconception) {
    let record = true;
    if (o.slip) {
      // a one-off sign/arithmetic slip is not a misconception; a repeat within two weeks is a pattern
      const tag = o.tags[0];
      const prev = ctx.db.get<any>("SELECT COUNT(*) n FROM attempts WHERE concept_id=? AND id != ? AND created_at > ? AND diagnosis LIKE ?", q.concept_id, attemptId, now - 14 * DAY, `%"${tag}"%`);
      record = prev.n > 0;
    }
    if (record) recordMisconception(ctx, q.concept_id, attemptId, o.misconception, now);
  } else if (o.status === 'graded' && (o.correctness ?? 1) < 0.4 && a.confidence === 3 && !a.idk) {
    recordMisconception(ctx, q.concept_id, attemptId, { label: 'Confident but incorrect', description: 'Answered with high confidence but incorrectly — worth checking for a hidden misconception.', origin: 'observed' }, now);
  }
  const trace: TraceEntry[] = [];
  recomputeConcept(ctx, q.concept_id, trace);
  const mine = trace.find((t) => t.attemptId === attemptId);
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
  else { id = uid(); ctx.db.run('INSERT INTO misconceptions (id,concept_id,label,description,status,origin,count,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)', id, conceptId, clip(m.label, 80), clip(m.description, 300), 'active', m.origin, 1, now, now); }
  ctx.db.run('INSERT OR IGNORE INTO misconception_evidence (misconception_id, attempt_id) VALUES (?,?)', id, attemptId);
  if (!ctx.db.get("SELECT 1 FROM followups WHERE misconception_id=? AND kind='repair' AND status='open'", id)) ctx.db.run("INSERT INTO followups (id,concept_id,misconception_id,kind,earliest_at,created_at) VALUES (?,?,?,?,?,?)", uid(), conceptId, id, 'repair', now, now);
  if (!ctx.db.get("SELECT 1 FROM followups WHERE misconception_id=? AND kind='repair_check' AND status='open'", id)) ctx.db.run("INSERT INTO followups (id,concept_id,misconception_id,kind,earliest_at,created_at) VALUES (?,?,?,?,?,?)", uid(), conceptId, id, 'repair_check', now + DAY, now);
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
  const payload = buildFeedback(ctx, q, o, { hintsUsed: a.hints_used, revealed: !!a.saw_answer, idk: !!a.idk, answer: a.answer_text });
  ctx.db.tx(() => {
    ctx.db.run('UPDATE attempts SET correctness=?, grade_status=?, grade_source=?, grade_confidence=?, feedback=?, diagnosis=?, grade_model=? WHERE id=?', o.correctness, o.status, o.source, o.confidence, o.feedback, JSON.stringify(payload), o.model ?? null, attemptId);
    afterAttempt(ctx, attemptId, q, o, 'practice');
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
