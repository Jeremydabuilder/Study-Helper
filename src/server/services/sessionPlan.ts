/**
 * Builds one study session for a goal and a time budget.
 *
 *   open  — a brief diagnostic or the reviews that are due (find out where things stand)
 *   core  — focused practice on the most useful gaps, adapted question by question
 *   check — at least one fresh, unseen question near the end, when there is room, so the session shows more than short-term recall
 *
 * The budget is soft: it sizes the plan (about two minutes per question including reading feedback) but never interrupts an answer.
 */
import { planToday } from '../../core/priority';
import { Ctx, HttpError, getProfile } from './common';
import { buildPlanInputs } from './plan';
import { readingTask } from './readingPlan';
import { conceptsWithOpenNotes } from './teachingMemory';

export type Goal = 'test' | 'understand' | 'wrong' | 'review';
export const GOAL_LABEL: Record<Goal, string> = { test: 'Prepare for a test', understand: 'Understand this material', wrong: 'Review what I keep getting wrong', review: 'Review what’s due' };
export type Phase = 'open' | 'core' | 'check';
export type Purpose = 'diagnostic' | 'practice' | 'review' | 'repair' | 'transfer' | 'exam';
export interface PlanSlot { conceptId: string; purpose: Purpose; n: number; done: number; extra: number; streak: number; phase: Phase; priority?: boolean }

export const SECONDS_PER_QUESTION = 115; // answering + reading feedback; a planning estimate, not a timer
export const questionBudget = (minutes: number) => Math.max(4, Math.round((minutes * 60) / SECONDS_PER_QUESTION));

const mk = (conceptId: string, purpose: Purpose, n: number, phase: Phase): PlanSlot => ({ conceptId, purpose, n, done: 0, extra: 0, streak: 0, phase });

/** Concepts relevant to a goal, in a sensible order, with the reason each is included. */
export function goalPool(ctx: Ctx, o: { goal: Goal; subjectId?: string | null; itemId?: string | null; sourceId?: string | null }) {
  const now = ctx.now();
  const rows = ctx.db.all<any>(`SELECT c.id, c.name, c.subject_id, c.source_id FROM concepts c JOIN subjects s ON s.id = c.subject_id WHERE c.status = 'confirmed' AND s.archived = 0 ${o.subjectId ? 'AND c.subject_id = ?' : ''} ORDER BY c.created_at`, ...(o.subjectId ? [o.subjectId] : []));
  let ids = rows.map((r) => r.id as string);
  let title = GOAL_LABEL[o.goal];
  if (o.goal === 'test') {
    const item = o.itemId ? ctx.db.get<any>('SELECT id, title FROM academic_items WHERE id = ?', o.itemId) : null;
    if (item) {
      const linked = ctx.db.all<any>('SELECT concept_id FROM academic_item_concepts WHERE item_id = ?', item.id).map((r) => r.concept_id as string);
      if (linked.length) { ids = ids.filter((id) => linked.includes(id)); title = `Prepare for ${item.title}`; }
    }
  } else if (o.goal === 'understand' && o.sourceId) {
    const own = rows.filter((r) => r.source_id === o.sourceId).map((r) => r.id as string);
    if (own.length) ids = own;
  } else if (o.goal === 'wrong') {
    const since = now - 30 * 24 * 3600_000;
    const bad = new Set<string>([
      ...ctx.db.all<any>('SELECT DISTINCT concept_id FROM observed_mistakes WHERE created_at > ?', since).map((r) => r.concept_id as string),
      ...ctx.db.all<any>("SELECT DISTINCT concept_id FROM misconceptions WHERE status = 'active'").map((r) => r.concept_id as string),
      ...ctx.db.all<any>("SELECT DISTINCT concept_id FROM followups WHERE status = 'open'").map((r) => r.concept_id as string),
      ...ctx.db.all<any>("SELECT DISTINCT concept_id FROM attempts WHERE created_at > ? AND grade_status = 'graded' AND correctness < 0.8 AND hints_used = 0 AND idk = 0 AND saw_answer = 0", since).map((r) => r.concept_id as string),
    ]);
    ids = ids.filter((id) => bad.has(id));
  } else if (o.goal === 'review') {
    const due = new Set(ctx.db.all<any>('SELECT concept_id FROM concept_state WHERE due_at IS NOT NULL AND due_at <= ?', now).map((r) => r.concept_id as string));
    ids = ids.filter((id) => due.has(id));
  }
  return { ids, title };
}

export function buildGoalSession(ctx: Ctx, o: { goal: Goal; minutes: number; subjectId?: string | null; itemId?: string | null; sourceId?: string | null }) {
  const minutes = Math.max(5, Math.min(120, Math.round(o.minutes || getProfile(ctx.db).default_minutes || 20)));
  const { ids, title } = goalPool(ctx, o);
  if (!ids.length) {
    const msg: Record<Goal, string> = {
      test: 'There are no confirmed concepts to prepare. Upload or select material and confirm its concepts first.',
      understand: 'There are no confirmed concepts for this material yet. Confirm the concepts first.',
      wrong: 'Nothing is marked as a recent mistake yet. Study something first, and the answers you miss will show up here.',
      review: 'Nothing is due for review right now.',
    };
    throw new HttpError(409, o.goal === 'wrong' || o.goal === 'review' ? 'nothing_to_review' : 'no_concepts', msg[o.goal]);
  }
  const inputs = buildPlanInputs(ctx, { minutes: 600 });
  const pool = new Set(ids);
  const plan = planToday({ ...inputs, minutes: 600, concepts: inputs.concepts.filter((c) => pool.has(c.id)), maxTasks: 12, maxReviewsPerDay: 6 });
  const order = plan.tasks.map((t) => t.conceptId);
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const noted = conceptsWithOpenNotes(ctx); // memory shapes later sessions: remembered, unchecked mistakes come first
  order.sort((a, b) => Number(noted.has(b)) - Number(noted.has(a)));
  const stateOf = new Map(ctx.db.all<any>('SELECT concept_id, level, due_at FROM concept_state').map((r) => [r.concept_id as string, r]));
  const now = ctx.now();
  const Q = questionBudget(minutes);
  const checkQ = Q >= 8 ? Math.min(3, Math.max(2, Math.round(Q * 0.2))) : Q >= 5 ? 1 : 0;
  let openQ = Math.min(2, Math.max(1, Math.round(Q * 0.2)));
  const coreQ = Math.max(2, Q - openQ - checkQ);

  const slots: PlanSlot[] = [];
  // open: due reviews first, then a quick check of the highest-priority concept nobody has assessed
  const dueIds = order.filter((id) => { const st = stateOf.get(id); return st?.due_at != null && st.due_at <= now; });
  for (const id of dueIds.slice(0, openQ)) { slots.push(mk(id, 'review', 1, 'open')); }
  const openedWith = new Set(slots.map((s) => s.conceptId));
  if (slots.length < openQ) for (const id of order) {
    if (slots.length >= openQ) break;
    const lvl = stateOf.get(id)?.level ?? 'not_assessed';
    if (lvl === 'not_assessed' && !openedWith.has(id)) { slots.push(mk(id, 'diagnostic', 1, 'open')); openedWith.add(id); }
  }
  openQ = slots.length;
  // core: the most useful gaps (planner order), a few questions each; unresolved mistakes are repairs
  const repair = new Set(plan.tasks.filter((t) => t.kind === 'repair').map((t) => t.conceptId));
  const coreIds = order.filter((id) => !(stateOf.get(id)?.level === 'solid' && !repair.has(id) && o.goal !== 'test')).slice(0, Math.max(1, Math.min(3, Math.ceil(coreQ / 2))));
  if (!coreIds.length) coreIds.push(order[0]);
  const per = Math.max(2, Math.round(coreQ / coreIds.length));
  for (const id of coreIds) {
    const opened = slots.find((s) => s.conceptId === id && s.phase === 'open');
    slots.push(mk(id, repair.has(id) || o.goal === 'wrong' ? 'repair' : 'practice', opened ? Math.max(1, per - 1) : per, 'core'));
  }
  // check: fresh, unseen questions for what was just practised (a later check is still scheduled; this one only shows near-term transfer of the same concept)
  for (const id of coreIds.slice(0, Math.max(0, checkQ))) slots.push(mk(id, 'transfer', 1, 'check'));
  if (checkQ > coreIds.length) for (const id of order) { if (slots.filter((s) => s.phase === 'check').length >= checkQ) break; if (!slots.some((s) => s.phase === 'check' && s.conceptId === id)) slots.push(mk(id, 'transfer', 1, 'check')); }
  const subjectId = o.subjectId ?? ctx.db.get<any>('SELECT subject_id FROM concepts WHERE id = ?', slots[0].conceptId)?.subject_id ?? null;
  const subjectName = subjectId ? ctx.db.get<any>('SELECT name FROM subjects WHERE id = ?', subjectId)?.name ?? null : null;
  return { slots, subjectId: subjectId as string | null, minutes, title, subjectName, questions: slots.reduce((a, s) => a + s.n, 0) };
}

/* ------------------------------ Today's single recommendation ------------------------------ */

export interface Recommendation {
  kind: 'resume' | 'study' | 'annotate' | 'set_up' | 'confirm_concepts' | 'caught_up';
  /** annotate only: the reading to open */
  readingId?: string | null;
  goal: Goal | null; itemId: string | null; subjectId: string | null; subjectName: string | null; sessionId: string | null;
  title: string; reason: string; minutes: number; conceptNames: string[];
  options: { goal: Goal; label: string; available: boolean; detail: string }[];
}

/** One recommended action with a short reason and an estimated duration. The student can change goal, subject and time. */
export function recommend(ctx: Ctx, minutes: number, active: { id: string } | null): Recommendation {
  const now = ctx.now();
  const nSubjects = ctx.db.get<any>('SELECT COUNT(*) n FROM subjects WHERE archived = 0').n;
  const nConfirmed = ctx.db.get<any>("SELECT COUNT(*) n FROM concepts WHERE status = 'confirmed'").n;
  const nProposed = ctx.db.get<any>("SELECT COUNT(*) n FROM concepts WHERE status = 'proposed'").n;
  const count = (goal: Goal, extra: { itemId?: string } = {}) => { try { return goalPool(ctx, { goal, ...extra }).ids.length; } catch { return 0; } };
  const dueN = count('review'), wrongN = count('wrong'), allN = count('understand');
  const unassessed = ctx.db.get<any>("SELECT COUNT(*) n FROM concepts c LEFT JOIN concept_state cs ON cs.concept_id = c.id WHERE c.status='confirmed' AND (cs.level IS NULL OR cs.level='not_assessed')").n;
  // the soonest test/quiz within two weeks that has topics linked
  const tests = ctx.db.all<any>("SELECT i.id, i.title, i.subject_id, i.due_kind, i.due_at, i.due_date FROM academic_items i WHERE i.status='confirmed' AND i.completed_at IS NULL AND i.sync_state != 'source_cancelled' AND i.type IN ('test','quiz','exam') AND EXISTS (SELECT 1 FROM academic_item_concepts l WHERE l.item_id = i.id)");
  const day = 24 * 3600_000;
  const soon = tests.map((t) => ({ ...t, at: t.due_kind === 'datetime' ? t.due_at : t.due_kind === 'date' ? Date.parse(`${t.due_date}T12:00:00Z`) : null })).filter((t) => t.at !== null && t.at >= now - day && t.at - now <= 14 * day).sort((a, b) => a.at - b.at)[0];
  const options: Recommendation['options'] = [
    { goal: 'test', label: GOAL_LABEL.test, available: allN > 0, detail: soon ? `${soon.title} is coming up` : 'Mixed practice over everything confirmed, with fresh checks at the end' },
    { goal: 'understand', label: GOAL_LABEL.understand, available: allN > 0, detail: unassessed ? `${unassessed} concept${unassessed === 1 ? ' has' : 's have'} not been checked yet` : 'Check and practise what you added' },
    { goal: 'wrong', label: GOAL_LABEL.wrong, available: wrongN > 0, detail: wrongN ? `${wrongN} concept${wrongN === 1 ? '' : 's'} with recent mistakes` : 'Nothing marked as a recent mistake yet' },
    ...(dueN ? [{ goal: 'review' as Goal, label: GOAL_LABEL.review, available: true, detail: `${dueN} due` }] : []),
  ];
  const base = { goal: null as Goal | null, itemId: null as string | null, subjectId: null as string | null, subjectName: null as string | null, sessionId: null as string | null, conceptNames: [] as string[], minutes, options };
  const rt = readingTask(ctx);
  const annotate = (why: string): Recommendation => ({ ...base, kind: 'annotate', readingId: rt!.sourceId, subjectName: rt!.subjectName, itemId: rt!.itemId, title: `Annotate “${rt!.title}”`, reason: why, minutes: Math.min(minutes, 15), conceptNames: [] });
  const dueWhen = rt ? (rt.daysLeft === 0 ? 'today' : rt.daysLeft === 1 ? 'tomorrow' : `in ${rt.daysLeft} days`) : '';
  const rtReason = rt ? `“${rt.itemTitle}” (${rt.subjectName}) is due ${dueWhen}, and this reading in the same subject has ${rt.annotations === 0 ? 'no highlights' : `only ${rt.annotations} highlight${rt.annotations === 1 ? '' : 's'}`} yet. About 15 minutes is an estimate; the app does not know this reading belongs to that assignment.` : '';
  if (active) return { ...base, kind: 'resume', sessionId: active.id, title: 'Pick up where you left off', reason: 'You have a session in progress. Your answers so far are saved.' };
  if (!nSubjects) return { ...base, kind: 'set_up', title: 'Upload your review packet', reason: 'Add a PDF, a screenshot or pasted notes. You will check what was read, then study for about 20 minutes.' };
  if (!nConfirmed && rt) return annotate(rtReason);
  if (!nConfirmed) return { ...base, kind: 'confirm_concepts', title: nProposed ? 'Confirm what you want to learn' : 'Add some class material', reason: nProposed ? 'Concepts were found in your material. Nothing is assigned until you confirm them.' : 'Add a review packet or notes so there is something to study.' };
  if (rt && rt.daysLeft <= 3 && !soon) return annotate(rtReason);
  let goal: Goal, reason: string, itemId: string | null = null;
  if (soon) { goal = 'test'; itemId = soon.id; const days = Math.max(0, Math.round((soon.at - now) / day)); reason = `${soon.title} is ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}. This covers its topics and ends with fresh questions.`; }
  else if (wrongN) { goal = 'wrong'; reason = `${wrongN} topic${wrongN === 1 ? '' : 's'} had recent mistakes. Fixing those first is the most useful use of the time.`; }
  else if (dueN) { goal = 'review'; reason = `${dueN} review${dueN === 1 ? ' is' : 's are'} due. A short check on questions you have not seen shows what stuck.`; }
  else if (rt) return annotate(rtReason);
  else if (unassessed) { goal = 'understand'; reason = `${unassessed} concept${unassessed === 1 ? ' has' : 's have'} not been checked yet. A short check shows where you stand before you practise.`; }
  else return { ...base, kind: 'caught_up', title: 'You’re caught up', reason: 'Nothing is due and nothing needs fixing. You can still practise something you choose, or add material.' };
  const g = buildGoalSession(ctx, { goal, minutes, itemId });
  const names = g.slots.map((s) => ctx.db.get<any>('SELECT name FROM concepts WHERE id = ?', s.conceptId)?.name as string).filter(Boolean);
  const est = Math.max(5, Math.min(minutes, Math.round((g.questions * SECONDS_PER_QUESTION) / 60)));
  return { ...base, kind: 'study', goal, itemId, subjectId: g.subjectId, subjectName: g.subjectName, title: g.title, reason, minutes: est, conceptNames: [...new Set(names)].slice(0, 4) };
}
