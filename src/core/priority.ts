/**
 * "What should I study next?" — transparent, configurable ordering heuristic.
 * Output score is a relative ordering aid (0–100), NOT a prediction of performance. Each component is exposed.
 */
import { ConceptState, isDue } from './learning';
import { DAY, localDateKey, diffDaysKeys } from './time';

export interface PriorityWeights { urgency: number; weakness: number; overdue: number; prereq: number; unassessed: number; repair: number }
export const DEFAULT_WEIGHTS: PriorityWeights = { urgency: 3, weakness: 2, overdue: 2, prereq: 1.5, unassessed: 1.5, repair: 2 };
export const WEIGHT_HELP: Record<keyof PriorityWeights, string> = {
  urgency: 'How much an approaching test/deadline pulls a topic forward.',
  weakness: 'How much demonstrated difficulty (failed or hinted attempts) pulls a topic forward.',
  overdue: 'How much a review that is past due pulls a topic forward.',
  prereq: 'How much a weak prerequisite of an upcoming topic is prioritised.',
  unassessed: 'How much "we do not know yet" pulls a topic forward (assess before assigning practice).',
  repair: 'How much an unresolved mistake pattern pulls a topic forward.',
};

export type TaskKind = 'diagnose' | 'repair' | 'review' | 'practice' | 'check';
export const TASK_MINUTES: Record<TaskKind, number> = { diagnose: 4, repair: 6, review: 3, practice: 8, check: 3 };
export const TASK_VERB: Record<TaskKind, string> = { diagnose: 'Quick check', repair: 'Fix a mistake pattern', review: 'Review', practice: 'Practice', check: 'Light check' };

export interface PlanConcept {
  id: string; name: string; subjectId: string; subjectName: string;
  state: ConceptState; prereqIds: string[];
  activeMisconceptions: number; openRepair: boolean;
}
export interface PlanDeadline { id: string; title: string; type: string; dueAt: number | null; dueKey: string | null; conceptIds: string[]; completed: boolean; cancelled: boolean }
export type PlanAction = 'pin' | 'skip';
export interface PlanOverride { conceptId: string; action: PlanAction }

export interface PlanTask {
  conceptId: string; conceptName: string; subjectId: string; subjectName: string;
  kind: TaskKind; minutes: number; score: number;
  components: Record<keyof PriorityWeights, number>;
  reasons: string[]; pinned: boolean;
}
export interface DailyPlan {
  tasks: PlanTask[]; minutesAvailable: number; minutesPlanned: number;
  overdueTotal: number; overdueDeferred: number; deferredNote: string | null;
  skipped: string[];
}

export interface PlanInput {
  now: number; tz: string; minutes: number; concepts: PlanConcept[]; deadlines: PlanDeadline[];
  weights?: PriorityWeights; overrides?: PlanOverride[]; maxTasks?: number; maxReviewsPerDay?: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function daysUntil(d: PlanDeadline, now: number, tz: string): number | null {
  if (d.dueKey) return diffDaysKeys(localDateKey(new Date(now), tz), d.dueKey);
  if (d.dueAt !== null) return Math.max(0, diffDaysKeys(localDateKey(new Date(now), tz), localDateKey(new Date(d.dueAt), tz)));
  return null;
}

export function planToday(inp: PlanInput): DailyPlan {
  const w = inp.weights ?? DEFAULT_WEIGHTS;
  const maxTasks = inp.maxTasks ?? 5;
  const maxReviews = inp.maxReviewsPerDay ?? 6;
  const byId = new Map(inp.concepts.map((c) => [c.id, c]));
  const dependents = new Map<string, string[]>();
  for (const c of inp.concepts) for (const p of c.prereqIds) dependents.set(p, [...(dependents.get(p) ?? []), c.id]);
  const live = inp.deadlines.filter((d) => !d.completed && !d.cancelled);
  const wsum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const skip = new Set((inp.overrides ?? []).filter((o) => o.action === 'skip').map((o) => o.conceptId));
  const pin = new Set((inp.overrides ?? []).filter((o) => o.action === 'pin').map((o) => o.conceptId));

  const urgencyOf = (conceptId: string): { u: number; why: string | null } => {
    let best = 0, why: string | null = null;
    for (const d of live) {
      if (!d.conceptIds.includes(conceptId)) continue;
      const days = daysUntil(d, inp.now, inp.tz);
      if (days === null || days < 0) continue;
      const u = 1 / (1 + days / 3);
      if (u > best) { best = u; why = `${d.title} ${days === 0 ? 'is today' : days === 1 ? 'is tomorrow' : `is in ${days} days`}.`; }
    }
    return { u: best, why };
  };

  const cands: PlanTask[] = [];
  let overdueTotal = 0;
  for (const c of inp.concepts) {
    const s = c.state;
    const due = isDue(s, inp.now);
    const { u, why: urgencyWhy } = urgencyOf(c.id);
    let kind: TaskKind | null = null;
    if (s.level === 'not_assessed') kind = 'diagnose';
    else if (c.openRepair || c.activeMisconceptions > 0) kind = 'repair';
    else if (due) kind = 'review';
    else if (s.level === 'shaky' || s.level === 'learning') kind = 'practice';
    else if (u >= 0.5) kind = 'check'; // solid, but a test is close: one light check, not more drilling
    if (!kind) continue;
    if (kind === 'practice' && s.level === 'learning' && u === 0 && s.recentAccuracy !== null && s.recentAccuracy >= 0.8 && !due) continue; // doing fine; review will bring it back
    if (due && s.dueAt !== null && inp.now - s.dueAt > 0) overdueTotal++;

    const overdueDays = due && s.dueAt !== null ? (inp.now - s.dueAt) / DAY : 0;
    const weak = s.level === 'shaky' ? 0.9 : s.level === 'learning' ? (s.recentAccuracy !== null ? clamp01(1 - s.recentAccuracy) : 0.5) : s.level === 'solid' ? 0.05 : 0;
    const depWeak = (dependents.get(c.id) ?? []).some((id) => {
      const d = byId.get(id); if (!d) return false;
      return urgencyOf(id).u > 0 && (s.level === 'shaky' || s.level === 'learning' || s.level === 'not_assessed');
    });
    const comp = {
      urgency: u,
      weakness: weak,
      overdue: due ? clamp01(0.3 + overdueDays / Math.max(1, s.intervalDays)) : 0,
      prereq: depWeak ? 0.8 : 0,
      unassessed: s.level === 'not_assessed' ? 1 : 0,
      repair: c.openRepair || c.activeMisconceptions > 0 ? 1 : 0,
    };
    let raw = (Object.keys(comp) as (keyof PriorityWeights)[]).reduce((a, k) => a + comp[k] * w[k], 0) / wsum;
    // prerequisite gap: demote a concept while one of its own prerequisites is not yet holding up
    const gaps = c.prereqIds.map((id) => byId.get(id)).filter((p): p is PlanConcept => !!p && (p.state.level === 'shaky' || p.state.level === 'not_assessed'));
    if (gaps.length) raw *= 0.7;

    const reasons: string[] = [];
    if (urgencyWhy) reasons.push(urgencyWhy);
    if (comp.repair) reasons.push('A mistake pattern here is still unresolved — a targeted fix comes before more practice.');
    if (due) reasons.push(overdueDays >= 1 ? `Review was due ${Math.floor(overdueDays)} day${Math.floor(overdueDays) === 1 ? '' : 's'} ago.` : 'Review is due now — recalling it unaided is what makes it last.');
    if (comp.unassessed) reasons.push('Not assessed yet — a short check finds out what you already know before assigning practice.');
    if (!comp.unassessed && comp.weakness >= 0.5 && !comp.repair) reasons.push(s.lastKind === 'hinted' || s.lastKind === 'assisted' ? 'You needed help last time; independent practice is next.' : 'Recent attempts show this is not solid yet.');
    if (comp.prereq) reasons.push('It underpins an upcoming topic.');
    if (gaps.length) {
      const unchecked = gaps.filter((g) => g.state.level === 'not_assessed'), shaky = gaps.filter((g) => g.state.level === 'shaky');
      if (shaky.length) reasons.push(`Builds on ${shaky.map((g) => g.name).join(', ')}, which needs repair first.`);
      if (unchecked.length) reasons.push(`Builds on ${unchecked.map((g) => g.name).join(', ')}, which hasn’t been checked yet.`);
    }
    if (kind === 'check') reasons.push('Holding up well — just one light check, no extra drilling.');

    cands.push({
      conceptId: c.id, conceptName: c.name, subjectId: c.subjectId, subjectName: c.subjectName, kind, minutes: TASK_MINUTES[kind],
      score: Math.round(raw * 100), components: comp, reasons, pinned: pin.has(c.id),
    });
  }

  cands.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score || a.conceptName.localeCompare(b.conceptName));
  const chosen: PlanTask[] = [];
  let used = 0, reviews = 0, deferredReviews = 0;
  const slack = Math.max(1, Math.round(inp.minutes * 0.1));
  for (const t of cands) {
    if (skip.has(t.conceptId)) continue;
    if (chosen.length >= maxTasks) { if (t.kind === 'review') deferredReviews++; continue; }
    if (t.kind === 'review' && reviews >= maxReviews) { deferredReviews++; continue; }
    if (used + t.minutes <= inp.minutes + slack) { chosen.push(t); used += t.minutes; if (t.kind === 'review') reviews++; }
    else if (t.kind === 'review') deferredReviews++;
  }
  if (!chosen.length) {
    const first = cands.find((t) => !skip.has(t.conceptId));
    if (first) { chosen.push({ ...first, minutes: Math.min(first.minutes, Math.max(2, inp.minutes)) }); used = chosen[0].minutes; }
  }
  const overdueDeferred = Math.max(0, overdueTotal - chosen.filter((t) => t.kind === 'review').length);
  return {
    tasks: chosen, minutesAvailable: inp.minutes, minutesPlanned: used, overdueTotal, overdueDeferred,
    deferredNote: overdueDeferred > 0 ? `${overdueDeferred} more review${overdueDeferred === 1 ? ' is' : 's are'} waiting. They stay safe — only what fits today is shown, and you can spread the rest over the coming days.` : null,
    skipped: cands.filter((t) => skip.has(t.conceptId)).map((t) => t.conceptName),
  };
}

/** Spread overdue reviews so at most `perDay` come due per day, most valuable first. Pure; returns new dueAt per concept. */
export function spreadOverdue(items: { conceptId: string; dueAt: number; score: number }[], now: number, perDay = 4): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...items].filter((i) => i.dueAt <= now).sort((a, b) => b.score - a.score);
  sorted.forEach((it, i) => out.set(it.conceptId, now + Math.floor(i / perDay) * DAY));
  return out;
}
