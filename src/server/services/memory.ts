import { Ctx, HttpError, clip, getProfile, parse } from './common';
import { uid } from '../db';
import { recomputeConcept } from './practice';

export type MemoryKind = 'student_stated' | 'observed' | 'ai_inferred';
const KINDS: MemoryKind[] = ['student_stated', 'observed', 'ai_inferred'];

export function listMemory(ctx: Ctx) {
  const memories = ctx.db.all<any>('SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC').map((m) => {
    const prov = parse<any>(m.provenance, {});
    const ids: string[] = Array.isArray(prov.attemptIds) ? prov.attemptIds : [];
    // what happened and which answers support it, so a note can be checked rather than trusted
    const evidence = ids.length ? ctx.db.all<any>(`SELECT a.id, a.created_at, a.answer_text, a.correctness, q.prompt, q.kind FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.id IN (${ids.map(() => '?').join(',')}) ORDER BY a.created_at DESC LIMIT 6`, ...ids)
      .map((a) => ({ attemptId: a.id, at: a.created_at, prompt: a.prompt, answer: a.kind === 'multiple_choice' ? '(a choice)' : String(a.answer_text).slice(0, 200) })) : [];
    const concept = m.concept_id ? ctx.db.get<any>('SELECT name FROM concepts WHERE id = ?', m.concept_id)?.name ?? null : null;
    return {
      id: m.id, kind: m.kind as MemoryKind, text: m.text, subjectId: m.subject_id, conceptId: m.concept_id, concept, provenance: prov, createdAt: m.created_at, updatedAt: m.updated_at,
      appMade: prov.origin === 'app', basis: prov.basis ?? null, dismissed: !!prov.dismissed, check: prov.check ?? null, evidence,
      effect: prov.origin === 'app' && !prov.dismissed ? (prov.mistakeKind === 'concept_confusion' ? 'Used to choose a question that tells the two ideas apart, to word grading checks, and to schedule a later check.' : 'Used to word grading checks and to schedule a later check.') : null,
    };
  });
  const misconceptions = ctx.db.all<any>(`SELECT m.*, c.name AS concept FROM misconceptions m JOIN concepts c ON c.id=m.concept_id WHERE m.status != 'dismissed' ORDER BY m.last_seen_at DESC`).map((m) => ({
    id: m.id, label: m.label, description: m.description, concept: m.concept, conceptId: m.concept_id, status: m.status, count: m.count, kind: m.origin === 'ai_inferred' ? 'ai_inferred' : 'observed',
    firstSeenAt: m.first_seen_at, lastSeenAt: m.last_seen_at, repairedAt: m.repaired_at,
    evidence: ctx.db.all<any>(`SELECT a.id, a.created_at, a.answer_text, a.confidence, q.prompt, q.kind FROM misconception_evidence e JOIN attempts a ON a.id=e.attempt_id JOIN questions q ON q.id=a.question_id WHERE e.misconception_id=? ORDER BY a.created_at DESC LIMIT 5`, m.id)
      .map((a) => ({ attemptId: a.id, at: a.created_at, prompt: a.prompt, answer: a.kind === 'multiple_choice' ? '(choice)' : a.answer_text.slice(0, 200), confidence: a.confidence })),
  }));
  const summaries = ctx.db.all<any>("SELECT id, mode, started_at, ended_at, summary FROM sessions WHERE status='completed' ORDER BY ended_at DESC LIMIT 10").map((s) => {
    const sm = parse<any>(s.summary, {});
    return { id: s.id, mode: s.mode, at: s.ended_at, text: `${sm.answered ?? 0} question${sm.answered === 1 ? '' : 's'}, ${sm.independentCorrect ?? 0}/${sm.independentTotal ?? 0} independently correct, ${sm.helped ?? 0} with help.${(sm.misconceptions ?? []).length ? ` Mistake pattern: ${sm.misconceptions.join(', ')}.` : ''}` };
  });
  return { profile: getProfile(ctx.db), memories, misconceptions, summaries };
}

export function addMemory(ctx: Ctx, b: { text: string; subjectId?: string | null; conceptId?: string | null }) {
  const text = clip(b.text, 400).trim();
  if (text.length < 3) throw new HttpError(400, 'invalid', 'Write a short note (at least a few characters).');
  const id = uid(), now = ctx.now();
  ctx.db.run('INSERT INTO memories (id,kind,text,subject_id,concept_id,provenance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'student_stated', text, b.subjectId ?? null, b.conceptId ?? null, JSON.stringify({ origin: 'student', note: 'Typed by you', at: now }), now, now);
  return { id };
}

/** Editing an inferred or observed memory turns it into something the student stated, and says so in its provenance. */
export function updateMemory(ctx: Ctx, id: string, b: { text: string }) {
  const m = ctx.db.get<any>('SELECT * FROM memories WHERE id=? AND deleted_at IS NULL', id);
  if (!m) throw new HttpError(404, 'not_found', 'Memory not found.');
  const text = clip(b.text, 400).trim();
  if (text.length < 3) throw new HttpError(400, 'invalid', 'Write a short note.');
  const prov = parse<any>(m.provenance, {});
  ctx.db.run('UPDATE memories SET text=?, kind=?, provenance=?, updated_at=? WHERE id=?', text, 'student_stated', JSON.stringify({ ...prov, correctedByStudent: true, previousKind: m.kind, correctedAt: ctx.now() }), ctx.now(), id);
}
export function deleteMemory(ctx: Ctx, id: string) { ctx.db.run('DELETE FROM memories WHERE id=?', id); }

export function setMisconceptionStatus(ctx: Ctx, id: string, status: 'active' | 'dismissed' | 'repaired') {
  const m = ctx.db.get<any>('SELECT concept_id FROM misconceptions WHERE id=?', id);
  if (!m) throw new HttpError(404, 'not_found', 'Not found.');
  ctx.db.tx(() => {
    ctx.db.run('UPDATE misconceptions SET status=?, repaired_at=? WHERE id=?', status, status === 'repaired' ? ctx.now() : null, id);
    if (status !== 'active') ctx.db.run("UPDATE followups SET status='dismissed' WHERE misconception_id=? AND status='open'", id);
    recomputeConcept(ctx, m.concept_id);
  });
}
export function deleteMisconception(ctx: Ctx, id: string) {
  const m = ctx.db.get<any>('SELECT concept_id FROM misconceptions WHERE id=?', id);
  if (!m) return;
  ctx.db.tx(() => { ctx.db.run('DELETE FROM misconceptions WHERE id=?', id); recomputeConcept(ctx, m.concept_id); });
}

export function updateProfile(ctx: Ctx, b: { name?: string; grade?: string; timezone?: string; defaultMinutes?: number; about?: string }) {
  const p = getProfile(ctx.db);
  if (b.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); } catch { throw new HttpError(400, 'invalid', 'Unknown time zone.'); } }
  ctx.db.run('UPDATE profile SET name=?, grade=?, timezone=?, default_minutes=?, about=?, updated_at=? WHERE id=1',
    b.name === undefined ? p.name : clip(b.name, 60), b.grade === undefined ? p.grade : clip(b.grade, 30), b.timezone ?? p.timezone,
    b.defaultMinutes === undefined ? p.default_minutes : Math.max(5, Math.min(120, Math.round(b.defaultMinutes))), b.about === undefined ? p.about : clip(b.about, 600), ctx.now());
}
export { KINDS };
