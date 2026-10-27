import { ConceptState, emptyState, replay, TraceEntry, isDue, LEVEL_LABEL } from '../../core/learning';
import { PlanConcept, PlanDeadline, PlanInput, planToday, spreadOverdue, TASK_VERB } from '../../core/priority';
import { wilson } from '../../core/stats';
import { DAY, addDaysKey, dayBounds, diffDaysKeys, localDateKey } from '../../core/time';
import { uid } from '../db';
import { Ctx, aiInfo, getAvailability, getProfile, getSchedulerParams, getWeights, parse } from './common';
import { computeSchedule, upcomingItems, attentionList, pendingProposalCount } from './items';
import { activeSession, loadAttempts } from './practice';
import { recommend } from './sessionPlan';

export function buildPlanInputs(ctx: Ctx, o: { minutes: number }): Omit<PlanInput, 'minutes'> & { minutes: number } {
  const now = ctx.now();
  const tz = getProfile(ctx.db).timezone;
  const today = localDateKey(new Date(now), tz);
  const rows = ctx.db.all<any>(`SELECT c.id, c.name, c.subject_id, s.name AS subject_name, cs.state FROM concepts c JOIN subjects s ON s.id=c.subject_id
    LEFT JOIN concept_state cs ON cs.concept_id=c.id WHERE c.status='confirmed' AND s.archived=0`);
  const prereqs = new Map<string, string[]>();
  for (const r of ctx.db.all<any>('SELECT concept_id, prereq_id FROM concept_prereqs')) prereqs.set(r.concept_id, [...(prereqs.get(r.concept_id) ?? []), r.prereq_id]);
  const mis = new Map(ctx.db.all<any>("SELECT concept_id, COUNT(*) n FROM misconceptions WHERE status='active' GROUP BY concept_id").map((r) => [r.concept_id, r.n]));
  const repair = new Set(ctx.db.all<any>("SELECT DISTINCT concept_id FROM followups WHERE status='open' AND earliest_at <= ?", now).map((r) => r.concept_id));
  const concepts: PlanConcept[] = rows.map((r) => ({
    id: r.id, name: r.name, subjectId: r.subject_id, subjectName: r.subject_name, state: r.state ? (parse<ConceptState>(r.state, emptyState())) : emptyState(),
    prereqIds: prereqs.get(r.id) ?? [], activeMisconceptions: mis.get(r.id) ?? 0, openRepair: repair.has(r.id),
  }));
  const items = ctx.db.all<any>("SELECT * FROM academic_items WHERE status='confirmed' AND completed_at IS NULL AND sync_state != 'source_cancelled'");
  const links = ctx.db.all<any>('SELECT item_id, concept_id FROM academic_item_concepts');
  const deadlines: PlanDeadline[] = items.map((i) => ({
    id: i.id, title: i.title, type: i.type, completed: false, cancelled: false,
    dueAt: i.due_kind === 'datetime' ? i.due_at : null, dueKey: i.due_kind === 'date' ? i.due_date : null,
    conceptIds: links.filter((l) => l.item_id === i.id).map((l) => l.concept_id),
  }));
  const overrides = ctx.db.all<any>('SELECT concept_id, action FROM plan_overrides WHERE date_key = ?', today).map((o) => ({ conceptId: o.concept_id, action: o.action }));
  return { now, tz, minutes: o.minutes, concepts, deadlines, weights: getWeights(ctx.db), overrides };
}

export function setOverride(ctx: Ctx, conceptId: string, action: 'pin' | 'skip' | null) {
  const tz = getProfile(ctx.db).timezone, day = localDateKey(new Date(ctx.now()), tz);
  ctx.db.run('DELETE FROM plan_overrides WHERE date_key=? AND concept_id=?', day, conceptId);
  if (action) ctx.db.run('INSERT INTO plan_overrides (id,date_key,concept_id,action,created_at) VALUES (?,?,?,?,?)', uid(), day, conceptId, action, ctx.now());
}

/** "Rebuild a lighter plan": spread overdue reviews over coming days instead of showing a backlog. */
export function rebuildOverdue(ctx: Ctx, perDay = 4) {
  const now = ctx.now();
  const inputs = buildPlanInputs(ctx, { minutes: 600 });
  const plan = planToday({ ...inputs, minutes: 600, maxTasks: 100, maxReviewsPerDay: 100 });
  const scores = new Map(plan.tasks.map((t) => [t.conceptId, t.score]));
  const overdue = ctx.db.all<any>(`SELECT cs.concept_id, cs.due_at FROM concept_state cs JOIN concepts c ON c.id=cs.concept_id WHERE c.status='confirmed' AND cs.due_at IS NOT NULL AND cs.due_at <= ?`, now);
  const m = spreadOverdue(overdue.map((o) => ({ conceptId: o.concept_id, dueAt: o.due_at, score: scores.get(o.concept_id) ?? 0 })), now, perDay);
  ctx.db.tx(() => {
    for (const [cid, due] of m) {
      ctx.db.run('UPDATE concept_state SET due_at=? WHERE concept_id=?', due, cid);
    }
  });
  return { rescheduled: m.size, perDay };
}

export function getToday(ctx: Ctx, o: { minutes?: number }) {
  const now = ctx.now();
  const profile = getProfile(ctx.db);
  const tz = profile.timezone, dateKey = localDateKey(new Date(now), tz);
  const minutes = Math.max(3, Math.min(180, o.minutes ?? profile.default_minutes ?? 20));
  const inputs = buildPlanInputs(ctx, { minutes });
  const plan = planToday(inputs);
  const sched = computeSchedule(ctx);
  const nSubjects = ctx.db.get<any>('SELECT COUNT(*) n FROM subjects WHERE archived=0').n;
  const nConfirmed = ctx.db.get<any>("SELECT COUNT(*) n FROM concepts WHERE status='confirmed'").n;
  const nProposed = ctx.db.get<any>("SELECT COUNT(*) n FROM concepts WHERE status='proposed'").n;
  const lastAt = ctx.db.get<any>('SELECT MAX(created_at) t FROM attempts').t as number | null;
  const gapDays = lastAt ? diffDaysKeys(localDateKey(new Date(lastAt), tz), dateKey) : null;
  const dueReviews = inputs.concepts.filter((c) => isDue(c.state, now)).length;
  const act = activeSession(ctx);
  const studiedToday = ctx.db.get<any>('SELECT COALESCE(SUM(MIN(response_ms,600000)),0) ms FROM attempts WHERE created_at >= ?', dayBounds(dateKey, tz).start.getTime()).ms;
  return {
    now, dateKey, timezone: tz, minutes, minuteOptions: [10, 20, 30], studiedTodayMin: Math.round(studiedToday / 60000),
    empty: nSubjects === 0 ? 'no_subjects' : nConfirmed === 0 ? (nProposed ? 'unconfirmed_concepts' : 'no_concepts') : null,
    plan: {
      ...plan,
      tasks: plan.tasks.map((t) => ({ ...t, verb: TASK_VERB[t.kind], levelLabel: LEVEL_LABEL[inputs.concepts.find((c) => c.id === t.conceptId)!.state.level] })),
    },
    recommendation: recommend(ctx, minutes, act ? { id: act.id } : null),
    heuristicNote: 'Priority scores are an ordering heuristic built from the rules below — not a prediction of how well you will do.',
    weights: inputs.weights,
    active: act ? { id: act.id, mode: act.mode, startedAt: act.started_at } : null,
    upcoming: upcomingItems(ctx, 21), attention: attentionList(ctx), pendingProposals: pendingProposalCount(ctx),
    schedule: { today: sched.blocks.filter((b) => b.dateKey === dateKey), next: sched.blocks.filter((b) => b.dateKey > dateKey).slice(0, 12), shortfalls: sched.shortfalls, changes: sched.changes },
    freeMinutesToday: sched.freeMinutesToday,
    dueReviews,
    welcomeBack: gapDays !== null && gapDays >= 3 ? { days: gapDays, message: `Welcome back. It has been ${gapDays} days — that happens. I have kept today's plan small and put the most useful things first; nothing is lost.` } : null,
    ai: aiInfo(ctx),
  };
}

/* --------------------------- progress / measurement --------------------------- */

export function getProgress(ctx: Ctx) {
  const now = ctx.now();
  const tz = getProfile(ctx.db).timezone;
  const params = getSchedulerParams(ctx.db);
  const concepts = ctx.db.all<any>(`SELECT c.id, c.name, s.name AS subject FROM concepts c JOIN subjects s ON s.id=c.subject_id WHERE c.status='confirmed'`);
  let delayedOk = 0, delayedN = 0;
  let heldOk = 0, heldN = 0, pracOk = 0, pracN = 0;
  const rows: any[] = [];
  const questionHeld = new Map(ctx.db.all<any>('SELECT id, heldout FROM questions').map((q) => [q.id, q.heldout]));
  for (const c of concepts) {
    const attempts = ctx.db.all<any>('SELECT a.id, a.question_id FROM attempts a WHERE concept_id=?', c.id);
    const trace: TraceEntry[] = [];
    const active = ctx.db.get<any>("SELECT COUNT(*) n FROM misconceptions WHERE concept_id=? AND status='active'", c.id).n;
    const st = replay(loadAttempts(ctx, c.id), { tz, params, activeMisconceptions: active, trace });
    for (const t of trace) {
      if (!t.counted || t.kind === 'hinted' || t.kind === 'assisted') continue;
      if (t.kind === 'delayed_unaided') { delayedN++; if (t.success) delayedOk++; }
      const qid = attempts.find((a) => a.id === t.attemptId)?.question_id;
      if (qid && !t.repeat) { if (questionHeld.get(qid)) { heldN++; if (t.success) heldOk++; } else { pracN++; if (t.success) pracOk++; } }
    }
    rows.push({ id: c.id, name: c.name, subject: c.subject, level: st.level, levelLabel: LEVEL_LABEL[st.level], counted: st.counted, ignored: st.ignored, independentSuccesses: st.independentSuccesses, independentAttempts: st.independentAttempts, dueAt: st.dueAt, activeMisconceptions: active, delayedSuccesses: st.delayedUnaidedSuccesses });
  }
  const dayMs = ctx.db.all<any>('SELECT created_at, MIN(COALESCE(response_ms,0),600000) ms FROM attempts WHERE created_at > ?', now - 30 * DAY);
  const byDay = new Map<string, number>();
  for (const r of dayMs) { const k = localDateKey(new Date(r.created_at), tz); byDay.set(k, (byDay.get(k) ?? 0) + r.ms); }
  const today = localDateKey(new Date(now), tz);
  const last14 = Array.from({ length: 14 }, (_, i) => { const k = addDaysKey(today, i - 13); return { date: k, minutes: Math.round((byDay.get(k) ?? 0) / 60000) }; });
  const sum = (from: number) => dayMs.filter((r) => r.created_at > now - from * DAY).reduce((t, r) => t + r.ms, 0);
  const mis = ctx.db.all<any>(`SELECT m.label, m.count, m.status, c.name AS concept, m.last_seen_at FROM misconceptions m JOIN concepts c ON c.id=m.concept_id ORDER BY m.count DESC, m.last_seen_at DESC`);
  const coverage = upcomingItems(ctx, 60).filter((i) => ['test', 'quiz', 'presentation', 'project'].includes(i.type)).map((i) => {
    const linked = ctx.db.all<any>('SELECT concept_id FROM academic_item_concepts WHERE item_id=?', i.id).map((r) => r.concept_id);
    const rs = rows.filter((r) => linked.includes(r.id));
    return { itemId: i.id, title: i.title, type: i.type, dueLabel: i.dueLabel, topicsKnown: linked.length > 0, linked: linked.length, assessed: rs.filter((r) => r.counted > 0).length, solid: rs.filter((r) => r.level === 'solid').length, needRepair: rs.filter((r) => r.level === 'shaky').length };
  });
  return {
    minutes: { last7: Math.round(sum(7) / 60000), last30: Math.round(sum(30) / 60000), byDay: last14 },
    delayedRecall: wilson(delayedOk, delayedN), heldoutAccuracy: wilson(heldOk, heldN), practiceAccuracy: wilson(pracOk, pracN),
    misconceptions: { active: mis.filter((m) => m.status === 'active').length, repaired: mis.filter((m) => m.status === 'repaired').length, repeated: mis.filter((m) => m.count >= 2 && m.status === 'active') },
    coverage, concepts: rows,
    notes: [
      'Rates show a plausible range (Wilson 95% interval) because small samples are noisy.',
      'Study minutes are measured from time spent answering questions — a rough proxy, not a stopwatch.',
      '“Held-back” questions are kept unseen until a review or test practice, so a result is not just remembering one question you already saw. A differently worded question still can’t prove you can apply the idea somewhere new; treat it as one more piece of evidence.',
    ],
  };
}

