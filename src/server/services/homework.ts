/**
 * Homework helper. One workspace per assignment: the instructions as given, the questions the student confirmed, their working (every version kept),
 * the help they asked for, and what checking found.
 *
 * Rules this file enforces:
 *  - nothing is invented: questions come from visible numbering, dates only from stated dates, unreadable text is shown and must be fixed or acknowledged first
 *  - a status ("working", "stuck", "completed") is the student's own statement. It is separate from whether an answer was found correct and from understanding
 *  - the smallest useful help comes first; a full worked solution needs an explicit confirmation and is recorded as shown
 *  - homework NEVER writes attempts or concept state: finishing it, with or without help, is not independent evidence of understanding
 *  - a check is exact where the app can be exact (math), labelled as the assistant's opinion where not, and always lists what it did not check
 *  - the app never submits work, contacts anyone, or changes anything outside this student's own data
 */
import { checkWorking, describeFirstIncorrect, extractProblemMath, StepCheckResult } from '../../core/stepcheck';
import { UNREADABLE, checkQuotations, dueHints, guessKind, safeForModel, splitSheet, taskWordsIn } from '../../core/homeworkParse';
import { findQuote } from '../../core/sources';
import { rank } from '../../core/retrieval';
import { localDateKey } from '../../core/time';
import { uid } from '../db';
import { Ctx, HttpError, clip, getProfile, parse } from './common';
import { buildStudyContext } from './chat';
import { stripInventedQuotes } from './annotations';
import { createItem, computeSchedule, confirmProposal, listItems, serializeItem } from './items';
import { addConcept } from './content';
import { looksLikeTrait } from './teachingMemory';
import { HomeworkCheck, HomeworkReply } from '../../ai/schemas';

const MAX_HOMEWORK = 150, MAX_QUESTIONS = 40, MAX_WORK = 20_000, MAX_ASK = 1_000, MAX_PROMPT = 4_000, MAX_VERSIONS = 200;
export type Kind = 'math' | 'science' | 'history' | 'english' | 'other';
export type WorkStatus = 'not_started' | 'working' | 'stuck' | 'completed';
export type Action = 'explain_instructions' | 'start' | 'hint' | 'concept' | 'worked_solution' | 'draft_help';
const ACTIONS: Action[] = ['explain_instructions', 'start', 'hint', 'concept', 'worked_solution', 'draft_help'];
const KINDS: Kind[] = ['math', 'science', 'history', 'english', 'other'];
const STATUSES: WorkStatus[] = ['not_started', 'working', 'stuck', 'completed'];

/** What a help action does to the record of how independent the student's work was. */
export type Assistance = 'none' | 'hint' | 'explanation_viewed' | 'ai_helped_draft' | 'worked_answer_shown';
const ASSIST_OF: Record<Action, Assistance> = { explain_instructions: 'none', start: 'hint', hint: 'hint', concept: 'explanation_viewed', draft_help: 'ai_helped_draft', worked_solution: 'worked_answer_shown' };
const ASSIST_RANK: Assistance[] = ['none', 'hint', 'explanation_viewed', 'ai_helped_draft', 'worked_answer_shown'];
export const ASSIST_LABEL: Record<Assistance, string> = { none: 'Independent so far', hint: 'Used a hint', explanation_viewed: 'Viewed an explanation', ai_helped_draft: 'AI helped with wording', worked_answer_shown: 'Worked answer shown' };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const fold = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

/* ------------------------------ loading ------------------------------ */

function hwRow(ctx: Ctx, id: string) {
  const h = ctx.db.get<any>('SELECT * FROM homework WHERE id = ?', id);
  if (!h) throw new HttpError(404, 'not_found', 'Homework not found.');
  return h;
}
function qRow(ctx: Ctx, id: string) {
  const q = ctx.db.get<any>('SELECT * FROM homework_questions WHERE id = ?', id);
  if (!q) throw new HttpError(404, 'not_found', 'Question not found.');
  return q;
}
const currentWork = (ctx: Ctx, qid: string) => ctx.db.get<any>('SELECT * FROM homework_work WHERE question_id = ? ORDER BY version DESC LIMIT 1', qid) ?? null;
const subjectOf = (ctx: Ctx, id: string | null) => (id ? ctx.db.get<any>('SELECT id, name FROM subjects WHERE id = ?', id) ?? null : null);
function unreadableOf(prompt: string) { return UNREADABLE.test(prompt) || /\[(?:diagram|figure|graph|image|picture)[^\]]*\]/i.test(prompt); }
const modelPrompt = (prompt: string) => safeForModel(prompt);

export function assistanceOf(ctx: Ctx, qid: string) {
  const rows = ctx.db.all<{ action: string; assistance: Assistance; level: number; created_at: number }>('SELECT action, assistance, level, created_at FROM homework_help WHERE question_id = ? ORDER BY created_at', qid);
  let top: Assistance = 'none';
  for (const r of rows) if (ASSIST_RANK.indexOf(r.assistance) > ASSIST_RANK.indexOf(top)) top = r.assistance;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.action] = (counts[r.action] ?? 0) + 1;
  return { level: top, label: ASSIST_LABEL[top], independent: top === 'none', counts, helpCount: rows.length };
}

/* ------------------------------ intake ------------------------------ */

/** Turn a confirmed source (pasted or uploaded and reviewed) into a DRAFT assignment: proposed questions and date hints. Nothing is scheduled until the student confirms. */
export function createDraft(ctx: Ctx, b: { sourceId: string; title?: string }) {
  const s = ctx.db.get<any>('SELECT s.*, sub.name AS subject_name FROM sources s JOIN subjects sub ON sub.id = s.subject_id WHERE s.id = ?', b.sourceId);
  if (!s) throw new HttpError(404, 'not_found', 'That material was not found.');
  if (s.status !== 'confirmed') throw new HttpError(409, 'review_first', 'Check what was read from the file first (the review page), then use it as homework.');
  const existing = ctx.db.get<any>('SELECT id FROM homework WHERE source_id = ?', s.id);
  if (existing) return { id: existing.id, duplicate: true };
  if (ctx.db.get<any>('SELECT COUNT(*) n FROM homework').n >= MAX_HOMEWORK) throw new HttpError(409, 'limit', 'You have a lot of homework saved. Delete some you no longer need first.');
  const sheet = splitSheet(s.text);
  if (sheet.questions.length > MAX_QUESTIONS) throw new HttpError(413, 'too_many', `This sheet seems to have more than ${MAX_QUESTIONS} questions. Add it in parts.`);
  const today = localDateKey(new Date(ctx.now()), getProfile(ctx.db).timezone);
  const hints = dueHints(s.text, today);
  const id = uid(), now = ctx.now();
  const kind = guessKind(s.subject_name, sheet.questions[0]?.prompt ?? '');
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO homework (id,subject_id,source_id,title,instructions,preamble,kind,state,split,due_hints,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, s.subject_id, s.id, clip(b.title, 120).trim() || clip(s.title, 120), s.text, sheet.preamble, kind, 'draft', sheet.split, JSON.stringify(hints), now, now);
    sheet.questions.forEach((q, i) => {
      const mp = modelPrompt(q.prompt);
      ctx.db.run('INSERT INTO homework_questions (id,homework_id,position,label,prompt,model_prompt,masked,kind,unreadable,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        uid(), id, i, q.label, clip(q.prompt, MAX_PROMPT), clip(mp.text, MAX_PROMPT), Number(mp.masked), guessKind(s.subject_name, q.prompt), Number(unreadableOf(q.prompt)), now, now);
    });
  });
  return { id, duplicate: false };
}

/** Plan items that probably are this assignment, so the same homework is never planned twice. */
export function planMatches(ctx: Ctx, h: any) {
  const t = new Set(norm(h.title).split(' ').filter((w) => w.length > 2 && !['homework', 'worksheet', 'assignment', 'the', 'and'].includes(w)));
  return listItems(ctx, 'confirmed').concat(listItems(ctx, 'proposed')).filter((i) => i.type === 'homework' && !i.completed && !ctx.db.get('SELECT 1 FROM homework WHERE item_id = ? AND id != ?', i.id, h.id))
    .map((i) => {
      const w = new Set(norm(i.title).split(' ').filter((x) => x.length > 2));
      const common = [...t].filter((x) => w.has(x)).length;
      const overlap = t.size && w.size ? common / Math.min(t.size, w.size) : 0;
      const sameSubject = !!h.subject_id && i.subjectId === h.subject_id;
      return { item: i, score: overlap + (sameSubject ? 0.25 : 0) };
    }).filter((m) => m.score >= 0.6).sort((a, b) => b.score - a.score).slice(0, 3)
    .map((m) => ({ id: m.item.id, title: m.item.title, subjectName: m.item.subjectName, dueLabel: m.item.dueLabel, status: m.item.status, source: m.item.source }));
}

export interface ConfirmInput {
  title?: string; subjectId?: string; kind?: string; dueDate?: string | null; dueTime?: string | null; estMin?: number | null;
  /** an existing Plan item to attach to, or 'new' to create one */
  plan?: string; acknowledgeUnsplit?: boolean; assessment?: boolean;
  questions?: { id?: string; label?: string; prompt?: string; remove?: boolean }[];
}

/** The student reviews the split, subject, date and the Plan link, then confirms. Only then does the homework exist in the Plan and get help. */
export function confirmHomework(ctx: Ctx, id: string, b: ConfirmInput) {
  const h = hwRow(ctx, id);
  const now = ctx.now();
  if (b.subjectId !== undefined && b.subjectId && !subjectOf(ctx, b.subjectId)) throw new HttpError(404, 'not_found', 'Subject not found.');
  if (b.kind !== undefined && !KINDS.includes(b.kind as Kind)) throw new HttpError(400, 'invalid', 'Unknown homework kind.');
  if (b.estMin != null && !(b.estMin >= 1 && b.estMin <= 1200)) throw new HttpError(400, 'invalid', 'Estimates are between 1 and 1200 minutes.');
  if (b.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate)) throw new HttpError(400, 'invalid', 'Dates must look like 2026-11-05.');
  const subjectId = b.subjectId ?? h.subject_id;
  const title = clip(b.title ?? h.title, 120).trim();
  if (!title) throw new HttpError(400, 'invalid', 'Give the homework a title.');
  if (!subjectId) throw new HttpError(400, 'invalid', 'Choose the subject.');
  ctx.db.tx(() => {
    if (h.state === 'draft') {
      for (const e of b.questions ?? []) {
        if (e.id) {
          const q = ctx.db.get<any>('SELECT * FROM homework_questions WHERE id = ? AND homework_id = ?', e.id, id);
          if (!q) throw new HttpError(404, 'not_found', 'Question not found.');
          if (e.remove) { ctx.db.run('DELETE FROM homework_questions WHERE id = ?', q.id); continue; }
          if (e.prompt !== undefined || e.label !== undefined) setPrompt(ctx, q, e.prompt ?? q.prompt, e.label);
        } else if (e.prompt && e.prompt.trim()) {
          if (ctx.db.get<any>('SELECT COUNT(*) n FROM homework_questions WHERE homework_id = ?', id).n >= MAX_QUESTIONS) throw new HttpError(409, 'limit', 'Too many questions.');
          const mp = modelPrompt(e.prompt);
          ctx.db.run('INSERT INTO homework_questions (id,homework_id,position,label,prompt,model_prompt,masked,kind,unreadable,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            uid(), id, 999, clip(e.label, 12) || '?', clip(e.prompt, MAX_PROMPT), clip(mp.text, MAX_PROMPT), Number(mp.masked), (b.kind as Kind) ?? h.kind, Number(unreadableOf(e.prompt)), now, now);
        }
      }
      ctx.db.all<any>('SELECT id FROM homework_questions WHERE homework_id = ? ORDER BY position, created_at', id).forEach((r, i) => ctx.db.run('UPDATE homework_questions SET position = ? WHERE id = ?', i, r.id));
    }
    const n = ctx.db.get<any>('SELECT COUNT(*) n FROM homework_questions WHERE homework_id = ?', id).n as number;
    if (!n) throw new HttpError(400, 'no_questions', 'Add at least one question.');
    if (h.state === 'draft' && h.split === 'none' && !b.acknowledgeUnsplit) throw new HttpError(409, 'unsplit', 'I could not find numbered questions, so the whole text is one question. Split it yourself (add each question), or confirm that it really is a single question.', { needs: 'acknowledgeUnsplit' });

    // the Plan: attach to an existing entry or create one — never both, never silently
    let itemId = h.item_id as string | null;
    if (!itemId) {
      const matches = planMatches(ctx, { ...h, title, subject_id: subjectId });
      if (matches.length && !b.plan) throw new HttpError(409, 'plan_match', 'This looks like something already in your Plan. Attach to it, or choose to add a separate entry.', { matches });
      if (b.plan && b.plan !== 'new') {
        const it = ctx.db.get<any>('SELECT * FROM academic_items WHERE id = ? AND type = ?', b.plan, 'homework');
        if (!it) throw new HttpError(404, 'not_found', 'That Plan entry was not found.');
        if (ctx.db.get('SELECT 1 FROM homework WHERE item_id = ? AND id != ?', it.id, id)) throw new HttpError(409, 'taken', 'That Plan entry already belongs to other homework.');
        if (it.status === 'proposed') confirmProposal(ctx, it.id, {});
        itemId = it.id;
      } else {
        itemId = createItem(ctx, { title, type: 'homework', subjectId, dueDate: b.dueDate ?? null, dueTime: b.dueTime ?? null, estimateMin: b.estMin ?? null, notes: 'Created from a homework sheet.' }).id;
      }
    }
    const hw = hwRow(ctx, id);
    const est = b.estMin !== undefined ? b.estMin : hw.est_min ?? suggestEstimate(ctx, { ...hw, subject_id: subjectId, kind: (b.kind as Kind) ?? hw.kind }, n).minutes;
    ctx.db.run('UPDATE homework SET title=?, subject_id=?, kind=?, state=?, item_id=?, est_min=?, assessment_mode=?, updated_at=? WHERE id=?', title, subjectId, b.kind ?? h.kind, 'active', itemId, est, b.assessment === undefined ? h.assessment_mode : Number(b.assessment), now, id);
    if (itemId) ctx.db.run('UPDATE academic_items SET estimate_min = COALESCE(estimate_min, ?), subject_id = COALESCE(subject_id, ?), updated_at = ? WHERE id = ?', est, subjectId, now, itemId);
    splitEstimates(ctx, id);
  });
  return getHomework(ctx, id);
}

function setPrompt(ctx: Ctx, q: any, prompt: string, label?: string) {
  const p = clip(prompt, MAX_PROMPT);
  if (!p.trim()) throw new HttpError(400, 'invalid', 'A question cannot be empty. Remove it instead.');
  const mp = modelPrompt(p);
  const unread = unreadableOf(p);
  ctx.db.run('UPDATE homework_questions SET prompt=?, model_prompt=?, masked=?, unreadable=?, acknowledged=CASE WHEN ? THEN acknowledged ELSE 0 END, label=?, updated_at=? WHERE id=?',
    p, clip(mp.text, MAX_PROMPT), Number(mp.masked), Number(unread), q.unreadable && p === q.prompt ? 1 : 0, label !== undefined ? clip(label, 12) || q.label : q.label, ctx.now(), q.id);
}

/** Split the assignment's time estimate over its questions by how long each one is, so the Plan has small tasks. Questions the student estimated themselves are left alone unless `all`. */
function splitEstimates(ctx: Ctx, id: string, all = false) {
  const h = hwRow(ctx, id); if (!h.est_min) return;
  const qs = ctx.db.all<any>('SELECT id, prompt, est_min FROM homework_questions WHERE homework_id = ? ORDER BY position', id);
  const w = qs.map((q) => Math.max(20, q.prompt.length));
  const total = w.reduce((a, b) => a + b, 0) || 1;
  qs.forEach((q, i) => { if (all || q.est_min == null) ctx.db.run('UPDATE homework_questions SET est_min = ? WHERE id = ?', Math.max(2, Math.round((h.est_min * w[i]) / total)), q.id); });
}

/* ------------------------------ estimates ------------------------------ */

const DEFAULT_PER_QUESTION: Record<Kind, number> = { math: 6, science: 8, history: 10, english: 20, other: 8 };
/**
 * A suggestion, never applied silently. With at least three finished assignments of the same kind that have logged ACTIVE time (idle time is not counted by the page),
 * it uses the median minutes per question; otherwise a plain default per question, labelled as a guess.
 */
export function suggestEstimate(ctx: Ctx, h: any, nQuestions: number) {
  const rows = ctx.db.all<any>(`SELECT h.id, (SELECT COUNT(*) FROM homework_questions q WHERE q.homework_id = h.id) AS n, (SELECT COALESCE(SUM(minutes),0) FROM homework_time t WHERE t.homework_id = h.id) AS mins
    FROM homework h WHERE h.completed_at IS NOT NULL AND h.kind = ? AND h.id != ?`, h.kind, h.id ?? '').filter((r) => r.n > 0 && r.mins >= 3);
  if (rows.length >= 3) {
    const per = rows.map((r) => r.mins / r.n).sort((a, b) => a - b);
    const med = per[Math.floor(per.length / 2)];
    return { minutes: Math.max(5, Math.round(med * nQuestions)), basis: `The median of your last ${rows.length} finished ${h.kind} assignments (${Math.round(med)} min per question of active time). Change it if this one is different.`, learned: true };
  }
  return { minutes: Math.max(5, DEFAULT_PER_QUESTION[h.kind as Kind] * nQuestions), basis: `A default guess of ${DEFAULT_PER_QUESTION[h.kind as Kind]} minutes per question. It improves after you finish a few assignments. Change it if you know better.`, learned: false };
}

/* ------------------------------ reading ------------------------------ */

function questionView(ctx: Ctx, q: any) {
  const w = currentWork(ctx, q.id);
  const last = ctx.db.get<any>('SELECT * FROM homework_checks WHERE question_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', q.id);
  const checks = ctx.db.get<any>('SELECT COUNT(*) n FROM homework_checks WHERE question_id = ?', q.id).n as number;
  const concepts = ctx.db.all<any>('SELECT c.id, c.name, hc.origin FROM homework_concepts hc JOIN concepts c ON c.id = hc.concept_id WHERE hc.question_id = ?', q.id);
  const a = assistanceOf(ctx, q.id);
  const worked = ctx.db.get<any>("SELECT 1 FROM homework_help WHERE question_id = ? AND assistance = 'worked_answer_shown'", q.id);
  return {
    id: q.id, label: q.label, position: q.position, prompt: q.prompt, kind: q.kind as Kind, masked: !!q.masked,
    unreadable: !!q.unreadable, acknowledged: !!q.acknowledged, blockedUntilLooked: !!q.unreadable && !q.acknowledged,
    status: q.work_status as WorkStatus, estMin: q.est_min,
    work: w ? { id: w.id, version: w.version, text: w.text, origin: w.origin, sourceId: w.source_id, savedAt: w.created_at } : null,
    versions: ctx.db.get<any>('SELECT COUNT(*) n FROM homework_work WHERE question_id = ?', q.id).n as number,
    assistance: a, concepts, workedShown: !!worked,
    // correctness is separate from status and from understanding; it comes only from a check of the CURRENT working
    lastCheck: last ? { id: last.id, verdict: last.verdict, at: last.created_at, method: last.method, forCurrentWork: !!w && last.work_id === w.id, challenged: !!last.challenge } : null, checks,
  };
}

export function listHomework(ctx: Ctx) {
  return ctx.db.all<any>('SELECT * FROM homework ORDER BY (state = \'draft\') DESC, (work_status = \'completed\'), updated_at DESC LIMIT 200').map((h) => {
    const qs = ctx.db.all<any>('SELECT work_status FROM homework_questions WHERE homework_id = ?', h.id);
    const it = h.item_id ? ctx.db.get<any>('SELECT * FROM academic_items WHERE id = ?', h.item_id) : null;
    const s = it ? serializeItem(ctx, it) : null;
    return {
      id: h.id, title: h.title, state: h.state, status: h.work_status as WorkStatus, subject: subjectOf(ctx, h.subject_id)?.name ?? null, subjectId: h.subject_id, kind: h.kind,
      questions: qs.length, done: qs.filter((q) => q.work_status === 'completed').length, stuck: qs.filter((q) => q.work_status === 'stuck').length,
      dueLabel: s?.dueLabel ?? null, daysLeft: s?.daysLeft ?? null, assessment: !!h.assessment_mode, updatedAt: h.updated_at,
    };
  });
}

export function getHomework(ctx: Ctx, id: string) {
  const h = hwRow(ctx, id);
  const qs = ctx.db.all<any>('SELECT * FROM homework_questions WHERE homework_id = ? ORDER BY position, created_at', id).map((q) => questionView(ctx, q));
  const it = h.item_id ? ctx.db.get<any>('SELECT * FROM academic_items WHERE id = ?', h.item_id) : null;
  const src = h.source_id ? ctx.db.get<any>('SELECT s.id, s.title, s.file_id, s.page_count, s.origin, s.ocr, s.text FROM sources s WHERE s.id = ?', h.source_id) : null;
  const time = ctx.db.get<any>('SELECT COALESCE(SUM(minutes),0) m FROM homework_time WHERE homework_id = ?', id).m as number;
  const rubric = rubricSource(ctx, h);
  return {
    id: h.id, title: h.title, state: h.state as 'draft' | 'active', status: h.work_status as WorkStatus, kind: h.kind as Kind, subject: subjectOf(ctx, h.subject_id), instructions: h.instructions, preamble: h.preamble,
    split: h.split as string, assessment: !!h.assessment_mode, estMin: h.est_min, completedAt: h.completed_at, createdAt: h.created_at,
    original: src ? { sourceId: src.id, title: src.title, fileId: src.file_id, pageCount: src.page_count, origin: src.origin, readFromScan: !!src.ocr } : null,
    plan: it ? { itemId: it.id, ...pickItem(ctx, it) } : null,
    dueHints: parse<any[]>(h.due_hints, []),
    matches: h.state === 'draft' || !h.item_id ? planMatches(ctx, h) : [],
    questions: qs, summary: assignmentSummary(qs),
    estimate: suggestEstimate(ctx, h, Math.max(1, qs.length)), activeMinutes: Math.round(time),
    rubric: rubric ? { sourceId: rubric.id, title: rubric.title } : null,
    taskWords: taskWordsIn(`${h.preamble}\n${qs.map((q) => q.prompt).join('\n')}`),
  };
}
const pickItem = (ctx: Ctx, it: any) => { const s = serializeItem(ctx, it); return { title: s.title, dueLabel: s.dueLabel, daysLeft: s.daysLeft, dueDate: s.dueDate, completed: s.completed, unknown: s.unknown }; };
function rubricSource(ctx: Ctx, h: any) {
  const id = parse<any>(ctx.db.get<any>('SELECT value FROM settings WHERE key = ?', `hw_rubric_${h.id}`)?.value, null) as string | null;
  return id ? ctx.db.get<any>("SELECT id, title, text FROM sources WHERE id = ? AND status = 'confirmed'", id) ?? null : null;
}
export function setRubric(ctx: Ctx, id: string, sourceId: string | null) {
  hwRow(ctx, id);
  if (sourceId && !ctx.db.get("SELECT 1 FROM sources WHERE id = ? AND status = 'confirmed'", sourceId)) throw new HttpError(404, 'not_found', 'That material was not found.');
  if (sourceId) ctx.db.run('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', `hw_rubric_${id}`, JSON.stringify(sourceId), ctx.now());
  else ctx.db.run('DELETE FROM settings WHERE key = ?', `hw_rubric_${id}`);
  return { ok: true };
}

/**
 * The assignment view NEVER says the whole assignment is correct. It reports how many questions were checked, what those checks found, and what was not checked.
 */
export function assignmentSummary(qs: ReturnType<typeof questionView>[]) {
  const n = qs.length;
  const withCheck = qs.filter((q) => q.lastCheck && q.lastCheck.forCurrentWork);
  const c = (v: string) => withCheck.filter((q) => q.lastCheck!.verdict === v).length;
  const stale = qs.filter((q) => q.lastCheck && !q.lastCheck.forCurrentWork).length;
  const noWork = qs.filter((q) => !q.work).length;
  const parts = [`${withCheck.length} of ${n} question${n === 1 ? '' : 's'} checked on your current working`];
  if (withCheck.length) parts.push(`${c('correct')} found correct, ${c('needs_revision')} need revision, ${c('uncertain') + c('unchecked')} could not be fully checked`);
  if (stale) parts.push(`${stale} changed since they were checked`);
  if (noWork) parts.push(`${noWork} have no working yet`);
  const all = n > 0 && withCheck.length === n && c('correct') === n;
  return {
    text: parts.join('; ') + '.',
    note: all ? 'Every question was checked and each check found the answer correct. That is this app’s check, not your teacher’s grade, and a check can miss things.' : 'This is not a prediction of your grade.',
    checked: withCheck.length, correct: c('correct'), needsRevision: c('needs_revision'), uncertain: c('uncertain') + c('unchecked'), unchecked: n - withCheck.length, total: n,
    completed: qs.filter((q) => q.status === 'completed').length, stuck: qs.filter((q) => q.status === 'stuck').length,
    assisted: qs.filter((q) => !q.assistance.independent).length,
  };
}

/* ------------------------------ working, statuses ------------------------------ */

export function updateQuestion(ctx: Ctx, qid: string, b: { prompt?: string; label?: string; acknowledge?: boolean; estMin?: number | null; kind?: string }) {
  const q = qRow(ctx, qid);
  if (b.kind !== undefined && !KINDS.includes(b.kind as Kind)) throw new HttpError(400, 'invalid', 'Unknown kind.');
  if (b.estMin != null && !(b.estMin >= 1 && b.estMin <= 600)) throw new HttpError(400, 'invalid', 'Estimates are between 1 and 600 minutes.');
  ctx.db.tx(() => {
    if (b.prompt !== undefined || b.label !== undefined) setPrompt(ctx, q, b.prompt ?? q.prompt, b.label);
    if (b.acknowledge) ctx.db.run('UPDATE homework_questions SET acknowledged = 1 WHERE id = ?', qid);
    if (b.estMin !== undefined) ctx.db.run('UPDATE homework_questions SET est_min = ?, updated_at = ? WHERE id = ?', b.estMin, ctx.now(), qid);
    if (b.kind) ctx.db.run('UPDATE homework_questions SET kind = ? WHERE id = ?', b.kind, qid);
  });
  return questionView(ctx, qRow(ctx, qid));
}

/** Saves the student's working as a new version. The same text again is a no-op (a double submit or a reload never makes noise); `baseVersion` stops one tab overwriting another. */
export function saveWork(ctx: Ctx, qid: string, b: { text: string; origin?: 'typed' | 'pasted'; baseVersion?: number }) {
  const q = qRow(ctx, qid); const h = hwRow(ctx, q.homework_id);
  if (h.state !== 'active') throw new HttpError(409, 'draft', 'Confirm the question list first.');
  const text = String(b.text ?? '').replace(/\r\n/g, '\n');
  if (text.length > MAX_WORK) throw new HttpError(413, 'too_long', `That is too long (limit ${MAX_WORK.toLocaleString()} characters). Keep the rest in a second question.`);
  const cur = currentWork(ctx, qid);
  if (cur && b.baseVersion !== undefined && b.baseVersion !== cur.version) throw new HttpError(409, 'conflict', 'This question changed in another window or tab. Reload to see the newest version; your text was not saved over it.', { current: { version: cur.version, text: cur.text } });
  if (cur && cur.text === text) return { version: cur.version, saved: false, question: questionView(ctx, q) };
  if (!cur && !text.trim()) return { version: 0, saved: false, question: questionView(ctx, q) };
  const version = (cur?.version ?? 0) + 1;
  if (version > MAX_VERSIONS) throw new HttpError(409, 'limit', 'This question has a very long history. Start a new question for further work.');
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO homework_work (id,question_id,version,text,origin,source_id,created_at) VALUES (?,?,?,?,?,?,?)', uid(), qid, version, text, b.origin ?? 'typed', null, ctx.now());
    if (q.work_status === 'not_started' && text.trim()) ctx.db.run("UPDATE homework_questions SET work_status = 'working', updated_at = ? WHERE id = ?", ctx.now(), qid);
    touch(ctx, h.id);
  });
  return { version, saved: true, question: questionView(ctx, qRow(ctx, qid)) };
}

/** Use a reviewed photo transcription (an uploaded picture that was read and confirmed in the usual review page) as the student's working. */
export function useTranscribedWork(ctx: Ctx, qid: string, sourceId: string) {
  const q = qRow(ctx, qid); const h = hwRow(ctx, q.homework_id);
  const s = ctx.db.get<any>("SELECT id, text, ocr, status FROM sources WHERE id = ?", sourceId);
  if (!s) throw new HttpError(404, 'not_found', 'That upload was not found.');
  if (s.status !== 'confirmed') throw new HttpError(409, 'review_first', 'Check what was read from the photo first, then use it.');
  const cur = currentWork(ctx, qid), version = (cur?.version ?? 0) + 1;
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO homework_work (id,question_id,version,text,origin,source_id,created_at) VALUES (?,?,?,?,?,?,?)', uid(), qid, version, clip(s.text, MAX_WORK), 'photo', s.id, ctx.now());
    if (q.work_status === 'not_started') ctx.db.run("UPDATE homework_questions SET work_status = 'working', updated_at = ? WHERE id = ?", ctx.now(), qid);
    touch(ctx, h.id);
  });
  return questionView(ctx, qRow(ctx, qid));
}

function touch(ctx: Ctx, hid: string) {
  const qs = ctx.db.all<any>('SELECT work_status FROM homework_questions WHERE homework_id = ?', hid).map((r) => r.work_status as WorkStatus);
  const h = hwRow(ctx, hid);
  const status: WorkStatus = h.work_status === 'completed' ? 'completed' : qs.includes('stuck') ? 'stuck' : qs.some((s) => s === 'working' || s === 'completed') ? 'working' : 'not_started';
  ctx.db.run('UPDATE homework SET work_status = ?, updated_at = ? WHERE id = ?', status, ctx.now(), hid);
}

/** The student's own statement about a question. Saying "stuck" with a note keeps that note as something the student said. */
export function setQuestionStatus(ctx: Ctx, qid: string, status: string, note?: string) {
  if (!STATUSES.includes(status as WorkStatus)) throw new HttpError(400, 'invalid', 'Choose not started, working, stuck or completed.');
  const q = qRow(ctx, qid); const h = hwRow(ctx, q.homework_id);
  ctx.db.tx(() => {
    ctx.db.run('UPDATE homework_questions SET work_status = ?, updated_at = ? WHERE id = ?', status, ctx.now(), qid);
    if (h.work_status === 'completed' && status !== 'completed') ctx.db.run("UPDATE homework SET work_status = 'working', completed_at = NULL WHERE id = ?", h.id);
    touch(ctx, h.id);
    const text = clip(note, 300).trim();
    if (status === 'stuck' && text.length >= 3 && !looksLikeTrait(text)) saveHomeworkMemory(ctx, q, h, { basis: 'student', label: `Stuck on ${q.label}`, text: `Homework “${h.title}”, question ${q.label}: I said I was stuck — “${text}”.`, key: `stuck|${q.id}`, assistance: assistanceOf(ctx, q.id).level });
  });
  return getHomework(ctx, h.id);
}

export function setAssessmentMode(ctx: Ctx, id: string, on: boolean) {
  hwRow(ctx, id);
  ctx.db.run('UPDATE homework SET assessment_mode = ?, updated_at = ? WHERE id = ?', Number(on), ctx.now(), id);
  return getHomework(ctx, id);
}

/** Done is the student's statement. Unfinished questions need an explicit "finish anyway"; checks and help do not change it. */
export function completeHomework(ctx: Ctx, id: string, b: { force?: boolean } = {}) {
  const h = hwRow(ctx, id);
  if (h.state !== 'active') throw new HttpError(409, 'draft', 'Confirm the question list first.');
  const open = ctx.db.all<any>("SELECT label FROM homework_questions WHERE homework_id = ? AND work_status != 'completed'", id).map((q) => q.label);
  if (open.length && !b.force) throw new HttpError(409, 'unfinished', `Question${open.length === 1 ? '' : 's'} ${open.join(', ')} ${open.length === 1 ? 'is' : 'are'} not marked completed. Finish ${open.length === 1 ? 'it' : 'them'}, or choose to mark the homework done anyway.`, { open });
  ctx.db.tx(() => {
    ctx.db.run("UPDATE homework SET work_status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", ctx.now(), ctx.now(), id);
    if (h.item_id) ctx.db.run('UPDATE academic_items SET completed_at = ?, updated_at = ? WHERE id = ?', ctx.now(), ctx.now(), h.item_id);
  });
  return getHomework(ctx, id);
}
export function reopenHomework(ctx: Ctx, id: string) {
  const h = hwRow(ctx, id);
  ctx.db.tx(() => {
    ctx.db.run("UPDATE homework SET work_status = 'working', completed_at = NULL, updated_at = ? WHERE id = ?", ctx.now(), id);
    if (h.item_id) ctx.db.run('UPDATE academic_items SET completed_at = NULL, updated_at = ? WHERE id = ?', ctx.now(), h.item_id);
  });
  return getHomework(ctx, id);
}
export function deleteHomework(ctx: Ctx, id: string) {
  hwRow(ctx, id);
  ctx.db.tx(() => { ctx.db.run('DELETE FROM homework WHERE id = ?', id); ctx.db.run('DELETE FROM settings WHERE key = ?', `hw_rubric_${id}`); });
  return { ok: true };
}
export function updateHomework(ctx: Ctx, id: string, b: { title?: string; estMin?: number | null; prioritize?: boolean; kind?: string }) {
  const h = hwRow(ctx, id);
  if (b.estMin != null && !(b.estMin >= 1 && b.estMin <= 1200)) throw new HttpError(400, 'invalid', 'Estimates are between 1 and 1200 minutes.');
  if (b.kind !== undefined && !KINDS.includes(b.kind as Kind)) throw new HttpError(400, 'invalid', 'Unknown kind.');
  ctx.db.tx(() => {
    if (b.title !== undefined && b.title.trim()) ctx.db.run('UPDATE homework SET title = ? WHERE id = ?', clip(b.title, 120).trim(), id);
    if (b.kind) ctx.db.run('UPDATE homework SET kind = ? WHERE id = ?', b.kind, id);
    if (b.estMin !== undefined) {
      ctx.db.run('UPDATE homework SET est_min = ? WHERE id = ?', b.estMin, id);
      if (h.item_id) ctx.db.run('UPDATE academic_items SET estimate_min = ?, updated_at = ? WHERE id = ?', b.estMin, ctx.now(), h.item_id);
      if (b.estMin) splitEstimates(ctx, id, true);
    }
    if (b.prioritize !== undefined) ctx.db.run('UPDATE homework SET priority_at = ? WHERE id = ?', b.prioritize ? ctx.now() : null, id);
    ctx.db.run('UPDATE homework SET updated_at = ? WHERE id = ?', ctx.now(), id);
  });
  return getHomework(ctx, id);
}

/** Active minutes, reported by the page with idle time already left out. Clamped, so a stuck timer cannot invent hours. Also counts toward the Plan's "done so far". */
export function logTime(ctx: Ctx, id: string, b: { minutes: number; questionId?: string }) {
  const h = hwRow(ctx, id);
  const m = Math.max(0, Math.min(10, Number(b.minutes) || 0));
  if (m <= 0) return { logged: 0 };
  const day = ctx.db.get<any>('SELECT COALESCE(SUM(minutes),0) m FROM homework_time WHERE at > ?', ctx.now() - 86_400_000).m as number;
  if (day > 16 * 60) return { logged: 0 };
  const qid = b.questionId && ctx.db.get('SELECT 1 FROM homework_questions WHERE id = ? AND homework_id = ?', b.questionId, id) ? b.questionId : null;
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO homework_time (id,homework_id,question_id,minutes,at) VALUES (?,?,?,?,?)', uid(), id, qid, m, ctx.now());
    if (h.item_id) ctx.db.run('UPDATE academic_items SET done_min = MIN(done_min + ?, 6000), updated_at = ? WHERE id = ?', Math.round(m), ctx.now(), h.item_id);
  });
  return { logged: m };
}

/* ------------------------------ topics ------------------------------ */

/** Suggest which of the student's topics a question touches (word overlap only). Suggestions are shown, never applied. */
export function suggestConcepts(ctx: Ctx, qid: string) {
  const q = qRow(ctx, qid); const h = hwRow(ctx, q.homework_id);
  const cs = ctx.db.all<any>("SELECT id, name, summary FROM concepts WHERE status = 'confirmed' AND (? IS NULL OR subject_id = ?)", h.subject_id, h.subject_id);
  return rank(`${q.prompt}`, cs, (c: any) => `${c.name} ${c.summary}`, 3).map((x: any) => ({ id: x.item.id, name: x.item.name }));
}
export function setQuestionConcepts(ctx: Ctx, qid: string, b: { conceptIds?: string[]; newTopic?: string }) {
  const q = qRow(ctx, qid); const h = hwRow(ctx, q.homework_id);
  ctx.db.tx(() => {
    let ids = b.conceptIds ?? ctx.db.all<any>('SELECT concept_id FROM homework_concepts WHERE question_id = ?', qid).map((r) => r.concept_id);
    if (b.newTopic && b.newTopic.trim()) {
      const subjectId = h.subject_id; if (!subjectId) throw new HttpError(400, 'invalid', 'Choose the subject first.');
      const existing = ctx.db.get<any>('SELECT id FROM concepts WHERE subject_id = ? AND lower(name) = lower(?)', subjectId, clip(b.newTopic, 90).trim());
      ids = [...ids, existing ? existing.id : addConcept(ctx, subjectId, { name: b.newTopic, summary: `Added from homework “${h.title}”.` }).id];
    }
    ctx.db.run('DELETE FROM homework_concepts WHERE question_id = ?', qid);
    for (const c of new Set(ids)) if (ctx.db.get('SELECT 1 FROM concepts WHERE id = ?', c)) ctx.db.run('INSERT INTO homework_concepts (question_id, concept_id, origin) VALUES (?,?,?)', qid, c, 'student');
  });
  return questionView(ctx, qRow(ctx, qid));
}

/** Optional: ask for a later, independent check on a topic. It is an ordinary follow-up in Study with a NEW question; the homework question itself is never reused. */
export function requestFreshCheck(ctx: Ctx, qid: string) {
  const q = qRow(ctx, qid);
  const c = ctx.db.get<any>('SELECT concept_id FROM homework_concepts WHERE question_id = ? ORDER BY origin DESC LIMIT 1', qid);
  if (!c) throw new HttpError(409, 'no_topic', 'Link this question to a topic first (or add one), so the later check knows what to ask about.');
  const open = ctx.db.get("SELECT 1 FROM followups WHERE concept_id = ? AND kind = 'repair_check' AND status = 'open'", c.concept_id);
  if (!open) ctx.db.run("INSERT INTO followups (id,concept_id,misconception_id,kind,earliest_at,created_at) VALUES (?,?,?,?,?,?)", uid(), c.concept_id, null, 'repair_check', ctx.now() + 86_400_000, ctx.now());
  return { ok: true, note: 'Added. In Study, a new question on this topic will be offered from tomorrow. It will not repeat this homework question.', questionLabel: q.label };
}

/* ------------------------------ memory ------------------------------ */

function saveHomeworkMemory(ctx: Ctx, q: any, h: any, o: { basis: 'observed' | 'inferred' | 'student'; label: string; text: string; key: string; assistance: Assistance; checkId?: string }) {
  if (looksLikeTrait(o.text)) return;
  const key = `hw|${o.key}`;
  const existing = ctx.db.all<any>('SELECT * FROM memories WHERE deleted_at IS NULL').find((m) => parse<any>(m.provenance, {}).key === key);
  const concept = ctx.db.get<any>('SELECT concept_id FROM homework_concepts WHERE question_id = ? LIMIT 1', q.id)?.concept_id ?? null;
  const prov = { origin: 'homework', basis: o.basis, key, label: o.label, homeworkId: h.id, questionId: q.id, checkId: o.checkId ?? null, assistance: o.assistance, assisted: o.assistance !== 'none', at: ctx.now(), history: [{ at: ctx.now(), note: 'saved from homework' }] };
  if (existing) { const p = parse<any>(existing.provenance, {}); if (p.dismissed) return; ctx.db.run('UPDATE memories SET text = ?, provenance = ?, updated_at = ? WHERE id = ?', o.text, JSON.stringify({ ...p, ...prov, history: [...(p.history ?? []), { at: ctx.now(), note: 'seen again' }] }), ctx.now(), existing.id); return; }
  ctx.db.run('INSERT INTO memories (id,kind,text,subject_id,concept_id,provenance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', uid(), o.basis === 'student' ? 'student_stated' : o.basis === 'inferred' ? 'ai_inferred' : 'observed', clip(o.text, 400), h.subject_id, concept, JSON.stringify(prov), ctx.now(), ctx.now());
}

/* ------------------------------ help ------------------------------ */

const inflight = new Map<string, Promise<unknown>>();
const singleFlight = <T>(key: string, run: () => Promise<T>): Promise<T> => {
  const running = inflight.get(key) as Promise<T> | undefined; if (running) return running;
  const p = run().finally(() => inflight.delete(key)); inflight.set(key, p); return p;
};

function guard(ctx: Ctx, q: any, h: any, action: Action | 'check') {
  if (h.state !== 'active') throw new HttpError(409, 'draft', 'Confirm the question list first.');
  if (h.assessment_mode && action !== 'concept') throw new HttpError(409, 'assessment', 'You marked this as a test or quiz in progress, so I can only explain general concepts right now (ask about the concept, not the question). Turn that off when it is over.');
  if (q.unreadable && !q.acknowledged && action !== 'explain_instructions') throw new HttpError(409, 'unreadable', 'Part of this question could not be read (look for the marked part and compare with the original). Fix the text, or confirm that you have looked at the original and the text is complete, and then I can help.');
}

function mathNote(q: any, working: string): { exact: StepCheckResult | null; note: string | null } {
  if (q.kind !== 'math' || !working.trim()) return { exact: null, note: null };
  const exact = checkWorking(q.prompt, working);
  const f = describeFirstIncorrect(exact);
  const note = f ? `First line that does not follow: ${f}` : exact.final.verdict === 'correct' ? 'All readable lines follow and the final answer is correct.' : exact.checked ? `Lines checked: ${exact.checked}; no invalid line found. ${exact.final.why}` : null;
  return { exact, note };
}

function offlineHelp(ctx: Ctx, q: any, h: any, a: Action, level: number, working: string, ask: string | null) {
  const words = taskWordsIn(`${h.preamble}\n${q.prompt}`);
  const { exact } = mathNote(q, working);
  const lines: string[] = [];
  let basis: 'source' | 'general' | 'none' = 'none';
  if (a === 'explain_instructions') {
    lines.push(`The question says: “${clip(q.prompt, 600)}”`);
    if (words.length) lines.push('Task words in it:\n' + words.map((w) => `• “${w.word}” means: ${w.meaning}.`).join('\n'));
    else lines.push('I did not find a common task word (like “explain” or “compare”). Read it again and underline what you are asked to produce.');
    lines.push('The study assistant is not available right now, so this is a plain reading aid, not a full explanation.');
  } else if (a === 'start' || a === 'hint') {
    if (q.kind === 'math') {
      const parsed = extractProblemMath(q.prompt);
      if (exact && exact.firstIncorrect !== null) {
        const s = exact.steps[exact.firstIncorrect - 1];
        lines.push(level <= 1 ? `Look again at line ${s.index} of your working (“${clip(s.text, 80)}”) and compare it with the line before.` : `Line ${s.index} (“${clip(s.text, 80)}”): ${s.why}`);
        basis = 'general';
      } else if (parsed) lines.push(`Write the problem on its own line: ${parsed.math}. Then ask: what is being done to the unknown, and what operation undoes it? Do one operation to BOTH sides and write the new line.`);
      else lines.push('Write the problem on its own line, say what you are asked to find, and do one small step. Then use “Check my work”.');
    } else {
      lines.push('Try this: (1) underline the task word in the question; (2) write one sentence saying what a good answer must contain; (3) find where in your notes or the reading that is discussed; (4) write your first sentence, even roughly.');
    }
    lines.push('The study assistant is not available right now, so this is a general checklist' + (q.kind === 'math' ? ' plus the app’s exact checking of your working.' : '.'));
  } else if (a === 'concept') {
    const ctxBlock = buildStudyContext(ctx, { query: `${ask ?? ''} ${h.assessment_mode ? '' : q.prompt}`, subjectId: h.subject_id, homework: true });
    if (ctxBlock.used.length) { lines.push('From your own materials:\n' + ctxBlock.block); basis = 'source'; } else lines.push('Nothing in your own materials matched. The study assistant is not available right now to explain from general knowledge.');
  }
  return { text: lines.join('\n\n'), basis, ai: false, used: [] as { type: string; label: string }[], clarifying: null as string | null, uncertain: null as string | null, final: null as string | null };
}

export async function help(ctx: Ctx, qid: string, b: { action: string; level?: number; ask?: string; confirm?: boolean }) {
  if (!ACTIONS.includes(b.action as Action)) throw new HttpError(400, 'invalid', 'Unknown help action.');
  const action = b.action as Action;
  return singleFlight(`${ctx.db.path}|${qid}|${action}`, () => helpOnce(ctx, qid, action, b));
}

async function helpOnce(ctx: Ctx, qid: string, action: Action, b: { level?: number; ask?: string; confirm?: boolean }) {
  const q = qRow(ctx, qid); const h = hwRow(ctx, q.homework_id);
  guard(ctx, q, h, action);
  const ask = b.ask ? clip(b.ask, MAX_ASK).trim() : null;
  if (action === 'worked_solution' && b.confirm !== true) throw new HttpError(409, 'confirm_needed', 'A full worked solution shows the whole answer. If you want it, confirm below. It will be recorded as “worked answer shown”, and it will not count as showing you understand it.', { needs: 'confirm' });
  if (h.assessment_mode && (!ask || ask.length < 3)) throw new HttpError(400, 'ask_needed', 'Tell me which concept you want explained (not the question itself).');
  const work = currentWork(ctx, qid);
  const working = h.assessment_mode ? '' : work?.text ?? '';
  const priorHints = ctx.db.get<any>("SELECT COUNT(*) n FROM homework_help WHERE question_id = ? AND action = 'hint'", qid).n as number;
  // the smallest useful help by default; asking for more raises the level one step at a time
  const level = (action === 'hint' ? Math.max(1, Math.min(3, Math.round(b.level ?? priorHints + 1))) : 1) as 1 | 2 | 3;
  const { exact, note } = mathNote(q, working);
  const rubric = rubricSource(ctx, h);
  const retrieved = h.assessment_mode ? { used: [] as any[], block: '' } : buildStudyContext(ctx, { query: `${q.prompt} ${ask ?? ''}`, subjectId: h.subject_id, homework: true });
  const prior = ctx.db.all<any>('SELECT action, response FROM homework_help WHERE question_id = ? ORDER BY created_at DESC LIMIT 3', qid).reverse().map((r) => ({ action: r.action as string, text: clip(r.response, 500) }));
  const live = ctx.ai.live && !!ctx.ai.homeworkHelp;
  if (!live && action === 'worked_solution' && q.kind !== 'math') throw new HttpError(409, 'no_ai', 'A worked solution needs the study assistant, which is not available right now. Your work is saved; the assistant may be back later.');
  if (!live && action === 'draft_help') throw new HttpError(409, 'no_ai', 'Help with wording needs the study assistant, which is not available right now. Your work is saved.');

  let reply: { text: string; basis: string; ai: boolean; used: { type: string; label: string }[]; clarifying: string | null; uncertain: string | null; final: string | null };
  let removed = 0;
  if (live) {
    const r: HomeworkReply = await ctx.ai.homeworkHelp!({
      action, level, kind: q.kind, subjectName: subjectOf(ctx, h.subject_id)?.name ?? 'unknown', gradeLevel: getProfile(ctx.db).grade || undefined, label: q.label,
      instructions: h.assessment_mode ? '' : clip(safeForModel(h.preamble).text, 1500), question: h.assessment_mode ? '(withheld: assessment in progress)' : q.model_prompt, working: clip(working, 6000), context: retrieved.block,
      rubric: rubric ? clip(rubric.text, 2500) : null, ask, verifiedNote: note, priorHelp: prior,
    });
    const hay = `${retrieved.block}\n${q.prompt}\n${working}\n${ask ?? ''}`;
    const c = stripInventedQuotes(r.text, hay); removed = c.removed;
    reply = { text: c.text, basis: r.basis, ai: true, used: retrieved.used, clarifying: r.clarifying_question, uncertain: r.uncertain, final: r.final_answer };
  } else {
    reply = action === 'worked_solution' ? { text: '', basis: 'none', ai: false, used: [], clarifying: null, uncertain: null, final: null } : offlineHelp(ctx, q, h, action, level, working, ask);
  }

  // a worked solution for a math question: the final answer is computed by the app; steps written by a model are shown only if they reach that same answer
  let verification: { verified: boolean | null; answer: string | null } | null = null;
  if (action === 'worked_solution' && q.kind === 'math') {
    const parsed = extractProblemMath(q.prompt);
    const sol = parsed ? solutionText(q.prompt) : null;
    if (sol) {
      const reached = reply.final ? checkWorking(q.prompt, reply.final).final.verdict : null;
      if (reply.ai && reached === 'correct') verification = { verified: true, answer: sol };
      else { verification = { verified: reply.ai ? false : null, answer: sol }; reply = { ...reply, text: `${reply.ai ? 'The steps the assistant wrote did not reach the answer the app computed, so they are not shown. ' : 'The study assistant is not available, so there are no written steps. '}The exact answer, computed by the app, is: ${sol}.`, uncertain: 'Steps unavailable' }; }
    } else if (reply.ai) verification = { verified: null, answer: null };
    else throw new HttpError(409, 'no_ai', 'I could not solve this one automatically and the study assistant is not available right now.');
  }

  const assistance = ASSIST_OF[action];
  const id = uid();
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO homework_help (id,homework_id,question_id,action,level,assistance,ask,response,basis,ai,used,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, h.id, qid, action, level, assistance, ask, reply.text, reply.basis, Number(reply.ai), JSON.stringify(reply.used), ctx.now());
    if (action === 'worked_solution') {
      const concept = ctx.db.get<any>('SELECT c.name FROM homework_concepts hc JOIN concepts c ON c.id = hc.concept_id WHERE hc.question_id = ? LIMIT 1', qid)?.name;
      saveHomeworkMemory(ctx, q, h, { basis: 'observed', label: `Needed the worked answer for ${q.label}`, key: `worked|${qid}`, assistance, text: `Homework “${h.title}”, question ${q.label}${concept ? ` (${concept})` : ''}: I looked at the worked answer. That is not evidence I can do it myself yet.` });
    }
    touch(ctx, h.id);
  });
  return {
    id, action, level, text: reply.text, basis: reply.basis, ai: reply.ai, uncertain: reply.uncertain, clarifyingQuestion: reply.clarifying,
    used: reply.used, removedQuotes: removed, verification, assistance: assistanceOf(ctx, qid),
    note: reply.ai ? 'Written by an AI model: it can be wrong. Check it against your materials.' : 'Not written by an AI model.',
    offerFreshCheck: action === 'worked_solution', nextHintLevel: action === 'hint' || action === 'start' ? Math.min(3, level + 1) : null, maxHint: level >= 3,
  };
}

function solutionText(prompt: string): string | null {
  // the app's own answer for a solvable math prompt: solve it by checking the problem against itself
  const p = extractProblemMath(prompt); if (!p) return null;
  const r = checkWorking(prompt, p.math);
  return r.problem.solution ?? null;
}

export function helpHistory(ctx: Ctx, qid: string) {
  qRow(ctx, qid);
  return ctx.db.all<any>('SELECT * FROM homework_help WHERE question_id = ? ORDER BY created_at, rowid', qid).map((r) => ({ id: r.id, action: r.action, level: r.level, assistance: r.assistance, ask: r.ask, text: r.response, basis: r.basis, ai: !!r.ai, used: parse<any[]>(r.used, []), at: r.created_at }));
}

/* ------------------------------ checking ------------------------------ */

const inWork = (excerpt: string, work: string) => { const e = fold(excerpt); return e.length >= 2 && fold(work).includes(e); };

export async function check(ctx: Ctx, qid: string, b: { recheck?: boolean } = {}) {
  return singleFlight(`${ctx.db.path}|${qid}|check`, () => checkOnce(ctx, qid, b));
}

async function checkOnce(ctx: Ctx, qid: string, b: { recheck?: boolean }) {
  const q = qRow(ctx, qid); const h = hwRow(ctx, q.homework_id);
  guard(ctx, q, h, 'check');
  const work = currentWork(ctx, qid);
  if (!work || !work.text.trim()) throw new HttpError(400, 'no_work', 'Write your working or answer first, then check it.');
  if (!b.recheck) {
    const same = ctx.db.get<any>('SELECT id FROM homework_checks WHERE question_id = ? AND work_id = ? ORDER BY created_at DESC LIMIT 1', qid, work.id);
    if (same) return { ...checkView(ctx, same.id), duplicate: true };
  }
  const text = work.text;
  const rubric = rubricSource(ctx, h);
  const sourceText = ctx.db.all<any>("SELECT s.text FROM sources s WHERE s.subject_id = ? AND s.status = 'confirmed' AND s.kind IN ('passage','textbook','notes','review_packet','other') AND s.id != COALESCE(?, '')", h.subject_id, h.source_id).map((r) => r.text as string).join('\n');
  const quotations = q.kind === 'english' || q.kind === 'history' ? checkQuotations(text, sourceText || null) : [];
  const { exact, note } = mathNote(q, text);
  const live = ctx.ai.live && !!ctx.ai.homeworkCheck;
  const exactDecisive = !!exact && exact.kind !== 'unknown' && exact.unchecked === 0 && exact.final.verdict !== 'unverified';
  let ai: HomeworkCheck | null = null; let aiDropped = 0; const dropped: string[] = [];
  const retrieved = buildStudyContext(ctx, { query: `${q.prompt} ${clip(text, 400)}`, subjectId: h.subject_id, homework: true });
  if (live && !(q.kind === 'math' && exactDecisive)) {
    const raw = await ctx.ai.homeworkCheck!({
      kind: q.kind, subjectName: subjectOf(ctx, h.subject_id)?.name ?? 'unknown', gradeLevel: getProfile(ctx.db).grade || undefined, label: q.label, instructions: clip(safeForModel(h.preamble).text, 1500), question: q.model_prompt,
      working: clip(text, 8000), context: retrieved.block, rubric: rubric ? clip(rubric.text, 2500) : null, quotations, verifiedNote: note,
    });
    const hay = `${retrieved.block}\n${q.prompt}\n${rubric?.text ?? ''}`;
    const parts = raw.parts.filter((p) => { const ok = inWork(p.excerpt, text); if (!ok) { aiDropped++; } return ok; }).map((p) => {
      let evidence = p.evidence_quote, basis = p.basis;
      if (evidence && !findQuote(hay, evidence)) { evidence = undefined; if (basis === 'source') basis = 'general'; }
      if (basis === 'source' && !evidence) basis = 'general';
      const c = stripInventedQuotes(p.why, `${hay}\n${text}`);
      return { ...p, why: c.text, evidence_quote: evidence, basis };
    });
    ai = { ...raw, parts, suggested_edits: raw.suggested_edits.filter((e) => inWork(e.original, text)) };
    if (aiDropped) dropped.push(`${aiDropped} comment${aiDropped === 1 ? '' : 's'} could not be tied to your exact words and ${aiDropped === 1 ? 'was' : 'were'} left out.`);
  }
  const nothing = !(exact && exact.checked > 0) && !ai && !quotations.length;
  if (nothing) return { unavailable: true, message: q.kind === 'math' ? 'I could not read this as math to check it exactly, and the study assistant is not available right now. Your work is saved.' : 'Checking this kind of answer needs the study assistant, which is not available right now. Your work is saved.', quotations: [] };

  // verdict: exact findings win for math; an assistant-only verdict is labelled as the assistant's opinion and is never "correct" while anything was left unchecked
  let verdict: 'correct' | 'needs_revision' | 'uncertain' | 'unchecked' = 'unchecked';
  const aiParts = ai?.parts ?? [];
  if (exact && (exact.firstIncorrect !== null || exact.final.verdict === 'incorrect')) verdict = 'needs_revision';
  else if (exactDecisive && exact!.final.verdict === 'correct') verdict = 'correct';
  else if (aiParts.length) {
    verdict = aiParts.some((p) => p.verdict === 'needs_revision') ? 'needs_revision' : aiParts.every((p) => p.verdict === 'correct') && !(ai!.not_checked.length) && !dropped.length ? 'correct' : 'uncertain';
    if (exact && exact.checked && verdict === 'correct' && !exactDecisive) verdict = 'uncertain';
  } else if (exact?.checked) verdict = 'uncertain';
  const badQuotes = quotations.filter((x) => x.inSource === false);
  if (verdict === 'correct' && badQuotes.length) verdict = 'needs_revision';
  const coverage = { exactLines: exact?.checked ?? 0, exactUnchecked: exact?.unchecked ?? 0, assistantParts: aiParts.length, notChecked: [...(ai?.not_checked ?? []), ...dropped, ...(exact?.steps.filter((s) => s.status === 'unchecked').map((s) => `Line ${s.index}: ${clip(s.text, 60)} (${s.why})`) ?? [])].slice(0, 12) };
  const summary = checkSummary(verdict, exact, aiParts.length, coverage, badQuotes.length);
  const result = {
    summary, exact: exact ? { kind: exact.kind, problem: exact.problem, steps: exact.steps, firstIncorrect: exact.firstIncorrect, final: exact.final, notes: exact.notes } : null,
    assistant: ai ? { parts: aiParts, overall: ai.overall, suggestedEdits: ai.suggested_edits } : null, quotations, coverage, assistantUsed: !!ai,
    nextAction: nextAction(verdict, exact, aiParts), basis: ai ? 'Parts marked “assistant” are an AI opinion and can be wrong. Parts marked “exact” were computed by the app.' : 'Computed by the app, not by an AI model.',
  };
  const id = uid();
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO homework_checks (id,question_id,work_id,work_text,method,verdict,result,created_at) VALUES (?,?,?,?,?,?,?,?)', id, qid, work.id, text, exact && ai ? 'both' : exact ? 'exact' : ai ? 'assistant' : 'none', verdict, JSON.stringify(result), ctx.now());
    // an exact finding about a specific kind of slip is worth remembering; it is tentative and the student can dismiss it
    if (exact && exact.firstIncorrect !== null) {
      const step = exact.steps[exact.firstIncorrect - 1]; const tag = step.tags[0];
      const label = tag === 'sign_error' ? 'a sign slip' : tag === 'flipped_inequality' ? 'flipping an inequality' : tag === 'endpoint_inclusion' ? 'including or excluding an endpoint' : tag === 'missing_solution' ? 'losing a solution' : tag === 'extraneous_solution' ? 'checking for extra solutions' : tag === 'arithmetic_slip' ? 'an arithmetic slip' : 'a step that did not follow';
      const a = assistanceOf(ctx, qid).level;
      saveHomeworkMemory(ctx, q, h, { basis: 'observed', label, key: `step|${qid}|${tag ?? 'x'}`, assistance: a, checkId: id, text: `Homework “${h.title}”, question ${q.label}: an exact check found ${label} at line ${step.index} of my working${a !== 'none' ? ` (I had used help: ${ASSIST_LABEL[a].toLowerCase()})` : ''}.` });
    }
  });
  return { ...checkView(ctx, id), duplicate: false };
}

function checkSummary(v: string, exact: StepCheckResult | null, aiParts: number, cov: { exactLines: number; exactUnchecked: number; notChecked: string[] }, badQuotes: number) {
  const bits: string[] = [];
  if (exact) bits.push(exact.firstIncorrect !== null ? `Exact check: line ${exact.firstIncorrect} is the first line that does not follow.` : exact.checked ? `Exact check: ${exact.checked} line${exact.checked === 1 ? '' : 's'} follow${exact.checked === 1 ? 's' : ''} from the one before.` : 'Exact check: nothing could be checked.');
  if (exact && exact.final.verdict !== 'unverified') bits.push(`Final answer: ${exact.final.verdict === 'correct' ? 'correct' : 'not correct'} (${exact.final.why})`);
  else if (exact) bits.push(`Final answer: not verified (${exact.final.why})`);
  if (aiParts) bits.push(`The assistant commented on ${aiParts} part${aiParts === 1 ? '' : 's'} of your answer (its opinion).`);
  if (badQuotes) bits.push(`${badQuotes} quotation${badQuotes === 1 ? '' : 's'} not found word for word in your source.`);
  if (cov.notChecked.length || cov.exactUnchecked) bits.push(`Not checked: ${Math.max(cov.notChecked.length, cov.exactUnchecked)} item${Math.max(cov.notChecked.length, cov.exactUnchecked) === 1 ? '' : 's'} (listed below).`);
  return `${v === 'correct' ? 'Looks correct' : v === 'needs_revision' ? 'Needs revision' : v === 'uncertain' ? 'Not certain' : 'Not checked'}. ${bits.join(' ')}`.trim();
}
function nextAction(v: string, exact: StepCheckResult | null, parts: { verdict: string; next_action: string }[]) {
  if (exact && exact.firstIncorrect !== null) return `Look at line ${exact.firstIncorrect} first, fix it, then re-check. Lines after it may then change.`;
  const p = parts.find((x) => x.verdict === 'needs_revision' && x.next_action); if (p) return p.next_action;
  if (v === 'correct') return 'Look it over once more yourself, then mark the question completed if you are done.';
  return 'Add or clarify the parts marked not checked, then check again, or ask for a hint.';
}

function checkView(ctx: Ctx, id: string) {
  const c = ctx.db.get<any>('SELECT * FROM homework_checks WHERE id = ?', id);
  const cur = currentWork(ctx, c.question_id);
  return { id: c.id, questionId: c.question_id, verdict: c.verdict, method: c.method, at: c.created_at, forCurrentWork: !!cur && cur.id === c.work_id, workVersion: ctx.db.get<any>('SELECT version FROM homework_work WHERE id = ?', c.work_id)?.version ?? null, workText: c.work_text, challenge: parse<any>(c.challenge, null), ...parse<any>(c.result, {}) };
}
export function checkHistory(ctx: Ctx, qid: string) {
  qRow(ctx, qid);
  return ctx.db.all<any>('SELECT id FROM homework_checks WHERE question_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 30', qid).map((r) => checkView(ctx, r.id));
}

/** The student disagrees with a check ("my answer is right", "the key/problem is wrong", "you misread my work"). The check and the student's answer stay as they were; the dispute is recorded on it and the result is shown as disputed. */
export function challengeCheck(ctx: Ctx, checkId: string, b: { reason: string; note?: string }) {
  const c = ctx.db.get<any>('SELECT * FROM homework_checks WHERE id = ?', checkId);
  if (!c) throw new HttpError(404, 'not_found', 'Check not found.');
  const reasons = ['my_answer_is_right', 'the_key_is_wrong', 'misread_my_work'];
  if (!reasons.includes(b.reason)) throw new HttpError(400, 'invalid', 'Choose a reason.');
  const note = clip(b.note, 600).trim();
  ctx.db.run('UPDATE homework_checks SET challenge = ?, challenged_at = ? WHERE id = ?', JSON.stringify({ reason: b.reason, note, at: ctx.now() }), ctx.now(), checkId);
  return checkView(ctx, checkId);
}

/* ------------------------------ plan: what next ------------------------------ */

/**
 * One realistic next task from deadlines and estimates: the homework the student pinned, else the one due soonest; inside it, the question already in progress, else the next
 * one not started. Conflicts come from the same schedule the Plan page uses, and the student decides what comes first.
 */
export function nextHomeworkTask(ctx: Ctx) {
  const act = ctx.db.all<any>("SELECT * FROM homework WHERE state = 'active' AND work_status != 'completed'");
  if (!act.length) return { task: null, conflicts: [] as any[] };
  const rows = act.map((h) => {
    const it = h.item_id ? ctx.db.get<any>('SELECT * FROM academic_items WHERE id = ?', h.item_id) : null;
    const s = it ? serializeItem(ctx, it) : null;
    const qs = ctx.db.all<any>("SELECT * FROM homework_questions WHERE homework_id = ? AND work_status != 'completed' ORDER BY position", h.id);
    return { h, s, qs };
  }).filter((r) => r.qs.length && !(r.s?.completed));
  if (!rows.length) return { task: null, conflicts: [] };
  rows.sort((a, b) => (b.h.priority_at ?? 0) - (a.h.priority_at ?? 0) || (a.s?.daysLeft ?? 9999) - (b.s?.daysLeft ?? 9999) || a.h.created_at - b.h.created_at);
  const top = rows[0];
  const q = top.qs.find((x: any) => x.work_status === 'working') ?? top.qs.find((x: any) => x.work_status === 'stuck') ?? top.qs[0];
  const session = getProfile(ctx.db).default_minutes;
  const left = top.qs.reduce((a: number, x: any) => a + (x.est_min ?? 8), 0);
  const minutes = Math.min(q.est_min ?? 8, session);
  const when = top.s?.daysLeft == null ? 'with no due date set' : top.s.daysLeft === 0 ? 'due today' : top.s.daysLeft === 1 ? 'due tomorrow' : `due in ${top.s.daysLeft} days`;
  const why = top.h.priority_at ? 'You put this first.' : top.s?.daysLeft != null ? `It is the homework due soonest (${when}).` : 'It is the only unfinished homework without a later deadline.';
  let conflicts: any[] = [];
  try {
    const sched = computeSchedule(ctx);
    const byItem = new Map(rows.map((r) => [r.h.item_id, r.h]));
    conflicts = sched.shortfalls.filter((s) => byItem.has(s.itemId)).map((s) => { const hh = byItem.get(s.itemId); return { homeworkId: hh.id, title: hh.title, missingMin: s.missingMin, reason: s.reason }; });
  } catch { /* the schedule needs a profile; without one there is nothing to compare */ }
  return {
    task: { homeworkId: top.h.id, title: top.h.title, questionId: q.id, label: q.label, status: q.work_status as WorkStatus, minutes, remainingMin: left, dueLabel: top.s?.dueLabel ?? null, daysLeft: top.s?.daysLeft ?? null, reason: why,
      split: q.est_min && q.est_min > session ? `This question is estimated at ${q.est_min} minutes; do the first ${session} and come back.` : null },
    others: rows.slice(1, 4).map((r) => ({ homeworkId: r.h.id, title: r.h.title, dueLabel: r.s?.dueLabel ?? null, daysLeft: r.s?.daysLeft ?? null })),
    conflicts,
  };
}

/** Homework in the account export: the student's own record, including every version of their working and each check. */
export function exportHomework(ctx: Ctx) {
  return ctx.db.all<any>('SELECT * FROM homework').map((h) => ({
    id: h.id, title: h.title, state: h.state, status: h.work_status, kind: h.kind, assessment: !!h.assessment_mode, instructions: h.instructions, createdAt: h.created_at, completedAt: h.completed_at,
    questions: ctx.db.all<any>('SELECT * FROM homework_questions WHERE homework_id = ? ORDER BY position', h.id).map((q) => ({
      label: q.label, prompt: q.prompt, status: q.work_status,
      work: ctx.db.all<any>('SELECT version, text, origin, created_at FROM homework_work WHERE question_id = ? ORDER BY version', q.id),
      help: ctx.db.all<any>('SELECT action, level, assistance, ask, response, created_at FROM homework_help WHERE question_id = ? ORDER BY created_at', q.id),
      checks: ctx.db.all<any>('SELECT verdict, method, result, challenge, created_at FROM homework_checks WHERE question_id = ? ORDER BY created_at', q.id).map((c) => ({ ...c, result: parse(c.result, null), challenge: parse(c.challenge, null) })),
    })),
  }));
}
