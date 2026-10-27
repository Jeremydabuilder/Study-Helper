/**
 * Saved notes about what happened, and how they change teaching.
 *
 * A note holds: what happened, which answers support it, when, whether it was seen once (observed) or on several different questions
 * (inferred), and what later evidence says. It describes content-specific mistakes only, never the student's traits, and the student can
 * dismiss or correct it.
 *
 * Evidence that a mistake has improved is deliberately hard to get and is kept in three separate stages:
 *   1. corrected_now — a TARGETED question (one written to test this very confusion, or whose wrong option was this mix-up) was answered
 *      correctly and independently soon after the mistake. Encouraging; it does NOT close the later review.
 *   2. improved — the same, but at least the scheduler's delay (default 20 h, the same threshold learning.ts uses for "delayed unaided")
 *      after the mistake, on a different question, counted as evidence by the scheduler. Still "suggests improvement", never "mastered".
 *   3. came_back — the mistake showed up again after either.
 * An unrelated correct answer on the same concept changes nothing. Every change is appended to `history` (provenance), and a regraded or
 * invalidated attempt reverses exactly the conclusions that depended on it.
 */
import { MistakeKind } from '../../core/diagnosis';
import { NextAction } from '../../core/nextAction';
import { DAY, HOUR } from '../../core/time';
import { uid } from '../db';
import { Ctx, clip, getSchedulerParams, parse } from './common';

export type CheckState = 'unchecked' | 'corrected_now' | 'improved' | 'came_back';
export interface Evidence { attemptId: string; at: number; targeted: true }
export interface MemoryEvent { type: 'mistake' | 'corrected_now' | 'improved' | 'came_back' | 'revoked' | 'reopened' | 'invalidated'; at: number; attemptId?: string; note?: string }
export interface MemoryProvenance {
  origin: 'app'; key: string; mistakeKind: MistakeKind; label: string; basis: 'observed' | 'inferred'; attemptIds: string[]; questionIds: string[];
  firstAt: number; lastAt: number; confusedWith?: { id: string; name: string } | null; dismissed?: boolean; invalidated?: boolean;
  /** what a question must test to count as a check of THIS note: 'confusion:<conceptId>' or 'label:<label>' */
  target?: string;
  check: { state: CheckState | 'not_improved'; now?: Evidence; later?: Evidence; attemptId?: string; at?: number; targeted?: boolean };
  history?: MemoryEvent[];
}

/** Wording that describes a person rather than an answer is never saved by the app. */
const TRAIT = /learning style|visual learner|auditory|kinesthetic|\blazy\b|not smart|\bdumb\b|bad at|good at|type of (learner|student)|personality|\balways\b|\bnever\b|careless (person|student)|doesn'?t (try|care)/i;
export const looksLikeTrait = (t: string) => TRAIT.test(t);

const SAVED_KINDS: MistakeKind[] = ['concept_confusion', 'reasoning_error'];
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export const targetOf = (p: MemoryProvenance) => p.target ?? (p.confusedWith ? `confusion:${p.confusedWith.id}` : `label:${norm(p.label)}`);
const stateOf = (p: MemoryProvenance): CheckState => (p.check.state === 'not_improved' ? 'came_back' : p.check.state);
const push = (p: MemoryProvenance, e: MemoryEvent) => { p.history = [...(p.history ?? []), e]; };
const active = (p: MemoryProvenance | null): p is MemoryProvenance => !!p && p.origin === 'app' && !p.dismissed && !p.invalidated;

export const testsKeyFor = (conceptId: string, o: { contrastConceptId?: string | null; label?: string | null }) =>
  o.contrastConceptId ? `${conceptId}|confusion:${o.contrastConceptId}` : o.label ? `${conceptId}|label:${norm(o.label)}` : null;

/** Does this question test this note? A targeted question, a question contrasting the same two concepts, or a multiple-choice question whose wrong option is this very mix-up. */
export function questionTests(q: { concept_id: string; tests_key?: string | null; contrast_id?: string | null; choices?: string | null }, p: MemoryProvenance): boolean {
  const t = targetOf(p);
  if (q.tests_key && q.tests_key === `${q.concept_id}|${t}`) return true;
  if (p.confusedWith && q.contrast_id && q.contrast_id === p.confusedWith.id) return true;
  const ch = parse<{ misconception?: string }[] | null>(q.choices ?? null, null);
  return !!ch?.some((c) => c.misconception && norm(c.misconception) === norm(p.label));
}

function ensureCheckFollowup(ctx: Ctx, conceptId: string, now: number) {
  if (!ctx.db.get("SELECT 1 FROM followups WHERE concept_id=? AND kind='repair_check' AND status='open'", conceptId))
    ctx.db.run("INSERT INTO followups (id,concept_id,misconception_id,kind,earliest_at,created_at) VALUES (?,?,?,?,?,?)", uid(), conceptId, null, 'repair_check', now + DAY, now);
}
const save = (ctx: Ctx, id: string, p: MemoryProvenance, text?: string) => {
  if (text !== undefined) ctx.db.run('UPDATE memories SET text = ?, kind = ?, provenance = ?, updated_at = ? WHERE id = ?', text, p.basis === 'inferred' ? 'ai_inferred' : 'observed', JSON.stringify(p), ctx.now(), id);
  else ctx.db.run('UPDATE memories SET provenance = ?, updated_at = ? WHERE id = ?', JSON.stringify(p), ctx.now(), id);
};
const noteText = (conceptName: string, p: MemoryProvenance) => clip(`${conceptName}: ${p.label}. Seen in ${p.attemptIds.length} answer${p.attemptIds.length === 1 ? '' : 's'} on ${p.questionIds.length === 1 ? 'one question' : `${p.questionIds.length} different questions`}; most recent ${fmt(p.lastAt)}.`, 400);

/** After a wrong answer with a content-specific mistake: remember what happened, linked to the answers that show it. */
export function recordMistakeMemory(ctx: Ctx, o: { conceptId: string; attemptId: string; questionId: string; kind: MistakeKind; label: string; description: string; confusedWith: { id: string; name: string } | null; patternFormed: boolean; distinctQuestions: number }) {
  if (!SAVED_KINDS.includes(o.kind) || looksLikeTrait(`${o.label} ${o.description}`)) return;
  const now = ctx.now();
  const concept = ctx.db.get<any>('SELECT name FROM concepts WHERE id = ?', o.conceptId);
  const key = `${o.conceptId}|${norm(o.label)}`;
  const existing = ctx.db.all<any>('SELECT * FROM memories WHERE deleted_at IS NULL AND concept_id = ?', o.conceptId).find((m) => parse<MemoryProvenance | null>(m.provenance, null)?.key === key);
  if (existing) {
    const p = parse<MemoryProvenance>(existing.provenance, null as any);
    if (p.dismissed) return; // the student said this is wrong: do not bring it back
    p.attemptIds = [...new Set([...p.attemptIds, o.attemptId])]; p.questionIds = [...new Set([...p.questionIds, o.questionId])]; p.lastAt = now;
    p.basis = p.questionIds.length >= 2 ? 'inferred' : 'observed'; p.invalidated = false;
    const prev = stateOf(p);
    push(p, { type: 'mistake', at: now, attemptId: o.attemptId });
    if (prev === 'improved') { p.check = { state: 'came_back' }; push(p, { type: 'came_back', at: now, attemptId: o.attemptId }); } else p.check = { state: prev === 'came_back' ? 'came_back' : 'unchecked' };
    save(ctx, existing.id, p, existing.kind === 'student_stated' ? existing.text : noteText(concept.name, p));
  } else {
    const p: MemoryProvenance = { origin: 'app', key, mistakeKind: o.kind, label: o.label, basis: 'observed', attemptIds: [o.attemptId], questionIds: [o.questionId], firstAt: now, lastAt: now, confusedWith: o.confusedWith,
      target: o.confusedWith ? `confusion:${o.confusedWith.id}` : `label:${norm(o.label)}`, check: { state: 'unchecked' }, history: [{ type: 'mistake', at: now, attemptId: o.attemptId }] };
    ctx.db.run('INSERT INTO memories (id,kind,text,subject_id,concept_id,provenance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', uid(), 'observed', noteText(concept.name, p),
      ctx.db.get<any>('SELECT subject_id FROM concepts WHERE id = ?', o.conceptId)?.subject_id ?? null, o.conceptId, JSON.stringify(p), now, now);
  }
  ensureCheckFollowup(ctx, o.conceptId, now); // a single observation also gets a later fresh check
}

export interface EvidenceInput {
  conceptId: string; attemptId: string; question: { id: string; concept_id: string; tests_key?: string | null; contrast_id?: string | null; choices?: string | null };
  /** graded, correct (≥ 0.8), no hint, answer not seen, not "I don't know" */
  independentSuccess: boolean; wrong: boolean;
  /** the scheduler counted this attempt as evidence (learning.ts), so uncertain, repeated or after-explanation answers don't qualify as the later check */
  counted: boolean;
}
export interface MemoryOutcome { memoryId: string; label: string; event: 'corrected_now' | 'improved' | 'came_back' | 'reopened' }

/**
 * Update only the notes THIS question tests. An unrelated correct answer on the same concept does nothing.
 * Returns what changed so the feedback can say it plainly (and encourage without closing the later review).
 */
export function recordEvidence(ctx: Ctx, o: EvidenceInput): MemoryOutcome[] {
  const now = ctx.now(), delay = getSchedulerParams(ctx.db).delayHours * HOUR;
  const out: MemoryOutcome[] = [];
  for (const m of ctx.db.all<any>('SELECT * FROM memories WHERE deleted_at IS NULL AND concept_id = ?', o.conceptId)) {
    const p = parse<MemoryProvenance | null>(m.provenance, null);
    if (!active(p) || !questionTests(o.question, p) || p.questionIds.includes(o.question.id)) continue;
    const st = stateOf(p);
    if (o.independentSuccess) {
      const later = now - p.lastAt >= delay && o.counted;
      if (later && st !== 'improved') { p.check = { state: 'improved', now: p.check.now, later: { attemptId: o.attemptId, at: now, targeted: true } }; push(p, { type: 'improved', at: now, attemptId: o.attemptId }); out.push({ memoryId: m.id, label: p.label, event: 'improved' }); }
      else if (!later && (st === 'unchecked' || st === 'came_back')) { p.check = { state: 'corrected_now', now: { attemptId: o.attemptId, at: now, targeted: true } }; push(p, { type: 'corrected_now', at: now, attemptId: o.attemptId }); out.push({ memoryId: m.id, label: p.label, event: 'corrected_now' }); }
      else continue;
    } else if (o.wrong && (st === 'corrected_now' || st === 'improved')) {
      p.check = { state: st === 'improved' ? 'came_back' : 'unchecked' }; push(p, { type: st === 'improved' ? 'came_back' : 'mistake', at: now, attemptId: o.attemptId }); p.lastAt = now;
      out.push({ memoryId: m.id, label: p.label, event: 'came_back' });
    } else continue;
    save(ctx, m.id, p);
  }
  settleFollowups(ctx, o.conceptId, now);
  return out;
}

/** The later check on a concept is closed only when every active note on it has been improved by targeted, delayed evidence. */
function settleFollowups(ctx: Ctx, conceptId: string, now: number) {
  const open = ctx.db.all<any>('SELECT provenance FROM memories WHERE deleted_at IS NULL AND concept_id = ?', conceptId).map((m) => parse<MemoryProvenance | null>(m.provenance, null)).filter(active);
  if (open.length && open.every((p) => stateOf(p) === 'improved')) ctx.db.run("UPDATE followups SET status='done', done_at=? WHERE concept_id=? AND kind='repair_check' AND status='open' AND misconception_id IS NULL", now, conceptId);
  else if (open.some((p) => stateOf(p) !== 'improved')) ensureCheckFollowup(ctx, conceptId, now);
  if (!open.length) ctx.db.run("UPDATE followups SET status='dismissed' WHERE concept_id=? AND kind='repair_check' AND status='open' AND misconception_id IS NULL", conceptId); // nothing left to check
}

/** An attempt was regraded, marked unclear or otherwise invalidated: reverse exactly the conclusions that depended on it, and keep the trail. */
export function reconcileAttempt(ctx: Ctx, attemptId: string, validity: { wrong: boolean; success: boolean }) {
  const now = ctx.now();
  const changedConcepts = new Set<string>();
  for (const m of ctx.db.all<any>('SELECT * FROM memories WHERE deleted_at IS NULL')) {
    const p = parse<MemoryProvenance | null>(m.provenance, null);
    if (!p || p.origin !== 'app') continue;
    let touched = false;
    if (p.attemptIds.includes(attemptId) && !validity.wrong) {
      p.attemptIds = p.attemptIds.filter((x) => x !== attemptId); push(p, { type: 'revoked', at: now, attemptId, note: 'The answer behind this note was regraded or marked unclear.' }); touched = true;
      if (!p.attemptIds.length) { p.invalidated = true; push(p, { type: 'invalidated', at: now, note: 'No supporting answers remain.' }); }
      else { const qs = new Set(ctx.db.all<any>(`SELECT question_id FROM attempts WHERE id IN (${p.attemptIds.map(() => '?').join(',')})`, ...p.attemptIds).map((r) => r.question_id)); p.questionIds = [...qs]; p.basis = qs.size >= 2 ? 'inferred' : 'observed'; }
    }
    for (const stage of ['now', 'later'] as const) {
      if (p.check[stage]?.attemptId === attemptId && !validity.success) {
        delete p.check[stage]; touched = true; push(p, { type: 'revoked', at: now, attemptId, note: `The ${stage === 'now' ? 'immediate' : 'later'} success was regraded or marked unclear.` });
        p.check.state = p.check.later ? 'improved' : p.check.now ? 'corrected_now' : 'unchecked';
      }
    }
    if (touched) { save(ctx, m.id, p, p.invalidated ? m.text : undefined); changedConcepts.add(m.concept_id); }
  }
  // patterns (misconceptions) lose supporting evidence the same way; a pattern needs two different questions
  for (const mc of ctx.db.all<any>('SELECT m.id, m.concept_id FROM misconceptions m JOIN misconception_evidence e ON e.misconception_id = m.id WHERE e.attempt_id = ?', attemptId)) {
    if (!validity.wrong) ctx.db.run('DELETE FROM misconception_evidence WHERE misconception_id = ? AND attempt_id = ?', mc.id, attemptId);
    const left = ctx.db.get<any>("SELECT COUNT(DISTINCT a.question_id) n FROM misconception_evidence e JOIN attempts a ON a.id = e.attempt_id WHERE e.misconception_id = ? AND a.grade_status='graded' AND a.correctness < 0.8", mc.id).n;
    if (left < 2) {
      ctx.db.run("UPDATE misconceptions SET status='dismissed', note=? WHERE id = ? AND status != 'dismissed'", `Withdrawn ${fmt(now)}: its supporting answers were regraded or marked unclear, so it no longer shows the same mistake on two different questions.`, mc.id);
      ctx.db.run("UPDATE followups SET status='dismissed' WHERE misconception_id = ? AND status = 'open'", mc.id);
    }
    changedConcepts.add(mc.concept_id);
  }
  for (const c of changedConcepts) settleFollowups(ctx, c, now);
  return [...changedConcepts];
}

/** An open confusion note for this concept that no one has settled: used to choose the next question. */
export function openConfusion(ctx: Ctx, conceptId: string): { memoryId: string; confusedWith: { id: string; name: string } } | null {
  for (const m of ctx.db.all<any>('SELECT * FROM memories WHERE deleted_at IS NULL AND concept_id = ? ORDER BY updated_at DESC', conceptId)) {
    const p = parse<MemoryProvenance | null>(m.provenance, null);
    if (active(p) && p.mistakeKind === 'concept_confusion' && p.confusedWith && stateOf(p) !== 'improved') return { memoryId: m.id, confusedWith: p.confusedWith };
  }
  return null;
}

/**
 * Memory changes the next question. A remembered confusion gets a question that tells the two ideas apart: right after the mistake that is a
 * follow-up, and once the delay has passed it is the later check (a different, unseen question aimed at the same confusion).
 */
export function memoryAction(ctx: Ctx, conceptId: string, alreadyAskedDiscrimination: boolean): NextAction | null {
  if (alreadyAskedDiscrimination) return null;
  const c = openConfusion(ctx, conceptId);
  if (!c) return null;
  const name = ctx.db.get<any>('SELECT name FROM concepts WHERE id = ?', conceptId)?.name ?? 'this idea';
  return { type: 'discriminate', focus: 'discriminate', contrast: c.confusedWith, reason: `You mixed up “${name}” with “${c.confusedWith.name}” before (saved in Memory). Checking it again with a fresh question that tells them apart.` };
}

export function memoryStatus(ctx: Ctx, id: string, status: 'active' | 'dismissed') {
  const m = ctx.db.get<any>('SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL', id);
  if (!m) return false;
  const p = parse<any>(m.provenance, {});
  ctx.db.run('UPDATE memories SET provenance = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...p, dismissed: status === 'dismissed', dismissedAt: status === 'dismissed' ? ctx.now() : null }), ctx.now(), id);
  return true;
}

/** Concepts with a remembered note that later, targeted evidence has not yet settled: they go first in later sessions. */
export function conceptsWithOpenNotes(ctx: Ctx): Set<string> {
  const out = new Set<string>();
  for (const m of ctx.db.all<any>('SELECT concept_id, provenance FROM memories WHERE deleted_at IS NULL AND concept_id IS NOT NULL')) {
    const p = parse<MemoryProvenance | null>(m.provenance, null);
    if (active(p) && stateOf(p) !== 'improved') out.add(m.concept_id);
  }
  return out;
}
