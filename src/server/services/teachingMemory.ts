/**
 * Saved notes about what happened, and how they change teaching.
 *
 * What a note holds: what happened, which answers support it, when, whether it was seen once (observed) or across several
 * different questions (inferred), and whether a later independent check suggests improvement. Notes describe content-specific
 * mistakes only. They never describe the student's traits, learning style or effort, and a student can dismiss or correct any of them;
 * a dismissed note stops affecting question choice, grading context and generation.
 */
import { MistakeKind } from '../../core/diagnosis';
import { NextAction } from '../../core/nextAction';
import { DAY } from '../../core/time';
import { uid } from '../db';
import { Ctx, clip, parse } from './common';

export interface MemoryProvenance {
  origin: 'app'; key: string; mistakeKind: MistakeKind; label: string; basis: 'observed' | 'inferred'; attemptIds: string[]; questionIds: string[];
  firstAt: number; lastAt: number; confusedWith?: { id: string; name: string } | null; dismissed?: boolean;
  check: { state: 'unchecked' | 'improved' | 'not_improved'; attemptId?: string; at?: number; targeted?: boolean };
}

/** Wording that describes a person rather than an answer is never saved by the app. */
const TRAIT = /learning style|visual learner|auditory|kinesthetic|\blazy\b|not smart|\bdumb\b|bad at|good at|type of (learner|student)|personality|\balways\b|\bnever\b|careless (person|student)|doesn'?t (try|care)/i;
export const looksLikeTrait = (t: string) => TRAIT.test(t);

const SAVED_KINDS: MistakeKind[] = ['concept_confusion', 'reasoning_error'];

const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);

function ensureCheckFollowup(ctx: Ctx, conceptId: string, now: number) {
  if (!ctx.db.get("SELECT 1 FROM followups WHERE concept_id=? AND kind='repair_check' AND status='open'", conceptId))
    ctx.db.run("INSERT INTO followups (id,concept_id,misconception_id,kind,earliest_at,created_at) VALUES (?,?,?,?,?,?)", uid(), conceptId, null, 'repair_check', now + DAY, now);
}

/** After a wrong answer with a content-specific mistake: remember what happened, linked to the answers that show it. */
export function recordMistakeMemory(ctx: Ctx, o: { conceptId: string; attemptId: string; questionId: string; kind: MistakeKind; label: string; description: string; confusedWith: { id: string; name: string } | null; patternFormed: boolean; distinctQuestions: number }) {
  if (!SAVED_KINDS.includes(o.kind) || looksLikeTrait(`${o.label} ${o.description}`)) return;
  const now = ctx.now();
  const concept = ctx.db.get<any>('SELECT name FROM concepts WHERE id = ?', o.conceptId);
  const key = `${o.conceptId}|${o.label.toLowerCase().trim()}`;
  const existing = ctx.db.all<any>('SELECT * FROM memories WHERE deleted_at IS NULL AND concept_id = ?', o.conceptId).find((m) => parse<MemoryProvenance | null>(m.provenance, null)?.key === key);
  const text = (n: number, at: number) => clip(`${concept.name}: ${o.label}. Seen in ${n} answer${n === 1 ? '' : 's'} on ${n === 1 ? 'one question' : `${o.distinctQuestions} different questions`}; most recent ${fmt(at)}.`, 400);
  if (existing) {
    const p = parse<MemoryProvenance>(existing.provenance, null as any);
    if (p.dismissed) return; // the student said this is wrong: do not bring it back
    const attemptIds = [...new Set([...p.attemptIds, o.attemptId])], questionIds = [...new Set([...p.questionIds, o.questionId])];
    const next: MemoryProvenance = { ...p, attemptIds, questionIds, lastAt: now, basis: questionIds.length >= 2 ? 'inferred' : 'observed', check: { state: p.check.state === 'improved' ? 'not_improved' : 'unchecked', attemptId: p.check.attemptId, at: p.check.at } };
    ctx.db.run('UPDATE memories SET text = ?, kind = ?, provenance = ?, updated_at = ? WHERE id = ?', existing.kind === 'student_stated' ? existing.text : text(attemptIds.length, now), existing.kind === 'student_stated' ? 'student_stated' : next.basis === 'inferred' ? 'ai_inferred' : 'observed', JSON.stringify(next), now, existing.id);
  } else {
    const prov: MemoryProvenance = { origin: 'app', key, mistakeKind: o.kind, label: o.label, basis: 'observed', attemptIds: [o.attemptId], questionIds: [o.questionId], firstAt: now, lastAt: now, confusedWith: o.confusedWith, check: { state: 'unchecked' } };
    ctx.db.run('INSERT INTO memories (id,kind,text,subject_id,concept_id,provenance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', uid(), 'observed', text(1, now),
      ctx.db.get<any>('SELECT subject_id FROM concepts WHERE id = ?', o.conceptId)?.subject_id ?? null, o.conceptId, JSON.stringify(prov), now, now);
  }
  ensureCheckFollowup(ctx, o.conceptId, now); // a single observation also gets a later fresh check, not just a pattern
}

/** After an independent, correct answer on a question that did not produce the note: record that a later check suggests improvement (not mastery). */
export function recordImprovement(ctx: Ctx, o: { conceptId: string; attemptId: string; questionId: string; focus: string | null }) {
  const now = ctx.now();
  for (const m of ctx.db.all<any>('SELECT * FROM memories WHERE deleted_at IS NULL AND concept_id = ?', o.conceptId)) {
    const p = parse<MemoryProvenance | null>(m.provenance, null);
    if (!p || p.origin !== 'app' || p.dismissed || p.check.state === 'improved') continue;
    if (p.questionIds.includes(o.questionId) || p.lastAt >= now) continue;
    const next: MemoryProvenance = { ...p, check: { state: 'improved', attemptId: o.attemptId, at: now, targeted: o.focus === 'discriminate' || o.focus === 'gap' } };
    ctx.db.run('UPDATE memories SET provenance = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), now, m.id);
  }
}

/** An open confusion note for this concept that no one has re-checked yet: used to choose the next question. */
export function openConfusion(ctx: Ctx, conceptId: string): { memoryId: string; confusedWith: { id: string; name: string } } | null {
  for (const m of ctx.db.all<any>('SELECT * FROM memories WHERE deleted_at IS NULL AND concept_id = ? ORDER BY updated_at DESC', conceptId)) {
    const p = parse<MemoryProvenance | null>(m.provenance, null);
    if (p?.origin === 'app' && !p.dismissed && p.mistakeKind === 'concept_confusion' && p.confusedWith && p.check.state !== 'improved')
      return { memoryId: m.id, confusedWith: p.confusedWith };
  }
  return null;
}

/** Memory changes the next question: a remembered, unchecked confusion is checked with a question that distinguishes the two ideas. */
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
