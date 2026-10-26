/**
 * Evidence + spaced-review scheduling. Provider-independent and pure.
 *
 * Concept state is a *replay* of the attempt log (so correcting a grade just re-runs it) and never stores
 * "mastery" as an opaque number. Algorithm (documented in docs/ARCHITECTURE.md):
 *
 *  1. Only attempts with gradeStatus "graded" count. Uncertain / failed / pending grades change nothing.
 *  2. Each counted attempt is classified by how independent it was and how long since last exposure:
 *       delayed_unaided   >= delayHours since the concept was last seen          weight 1.0
 *       first_cold        concept never seen before (diagnostic)                 weight 0.8
 *       recent_unaided    unaided but soon after exposure (other session)        weight 0.5
 *       after_explanation unaided, but feedback/explanation was already shown
 *                         for this concept in the same session                   weight 0.35
 *       hinted            a hint was used                                        weight 0.25 (never independent)
 *       assisted          answer was shown / "I don't know"                      weight 0 (never independent)
 *  3. Review interval (days) grows only from successes, mostly delayed unaided ones; hinted/after-explanation
 *     successes schedule a re-check tomorrow rather than extending the interval; failures reset to 1 day.
 *  4. "solid" needs: >=1 delayed unaided success, >=3 independent successes on >=2 distinct questions across
 *     >=2 distinct days, the latest independent attempt a success, and no active misconception.
 *     Repeating the same question never counts twice as new evidence.
 */
import { DAY, HOUR, localDateKey } from './time';

export interface SchedulerParams {
  delayHours: number;
  weights: { delayed_unaided: number; first_cold: number; recent_unaided: number; after_explanation: number; hinted: number; assisted: number };
  studentGradeFactor: number;
  repeatQuestionFactor: number;
  growth: number;
  maxIntervalDays: number;
  firstIntervalDays: number;
  successThreshold: number;
  failThreshold: number;
}

export const DEFAULT_PARAMS: SchedulerParams = {
  delayHours: 20,
  weights: { delayed_unaided: 1, first_cold: 0.8, recent_unaided: 0.5, after_explanation: 0.35, hinted: 0.25, assisted: 0 },
  studentGradeFactor: 0.8,
  repeatQuestionFactor: 0.3,
  growth: 2.3,
  maxIntervalDays: 90,
  firstIntervalDays: 2,
  successThreshold: 0.8,
  failThreshold: 0.4,
};

export type GradeStatus = 'graded' | 'uncertain' | 'failed' | 'pending';
export type GradeSource = 'deterministic' | 'ai' | 'heuristic' | 'student';
export type EvidenceKind = 'delayed_unaided' | 'first_cold' | 'recent_unaided' | 'after_explanation' | 'hinted' | 'assisted';

export interface AttemptRecord {
  id: string;
  conceptId: string;
  questionId: string;
  sessionId: string | null;
  at: number; // epoch ms
  correctness: number | null; // 0..1
  gradeStatus: GradeStatus;
  gradeSource: GradeSource;
  hinted: boolean;
  sawAnswer: boolean;
  idk: boolean;
  confidence: 1 | 2 | 3 | null;
  feedbackShown: boolean;
  heldout?: boolean;
}

export type Level = 'not_assessed' | 'learning' | 'shaky' | 'solid';

export interface ConceptState {
  level: Level;
  intervalDays: number;
  dueAt: number | null;
  lastExposureAt: number | null;
  lastIndependentAt: number | null;
  counted: number;
  ignored: number;
  independentAttempts: number;
  independentSuccesses: number;
  delayedUnaidedSuccesses: number;
  distinctSuccessQuestions: number;
  distinctSuccessDays: number;
  lapses: number;
  highConfidenceErrors: number;
  recentAccuracy: number | null; // weighted, last 5 counted attempts
  lastKind: EvidenceKind | null;
}

export const emptyState = (): ConceptState => ({
  level: 'not_assessed', intervalDays: 0, dueAt: null, lastExposureAt: null, lastIndependentAt: null, counted: 0, ignored: 0,
  independentAttempts: 0, independentSuccesses: 0, delayedUnaidedSuccesses: 0, distinctSuccessQuestions: 0, distinctSuccessDays: 0,
  lapses: 0, highConfidenceErrors: 0, recentAccuracy: null, lastKind: null,
});

export function classify(a: AttemptRecord, ctx: { priorExposureAt: number | null; explainedInSession: boolean }, p: SchedulerParams): EvidenceKind {
  if (a.idk || a.sawAnswer) return 'assisted';
  if (a.hinted) return 'hinted';
  if (ctx.explainedInSession) return 'after_explanation';
  if (ctx.priorExposureAt === null) return 'first_cold';
  return a.at - ctx.priorExposureAt >= p.delayHours * HOUR ? 'delayed_unaided' : 'recent_unaided';
}

/** Next review interval after one counted attempt. Pure; unit-tested at the boundaries. */
export function nextInterval(
  prev: { intervalDays: number; lastExposureAt: number | null; lapses: number },
  o: { kind: EvidenceKind; correctness: number; at: number },
  p: SchedulerParams,
): { intervalDays: number; lapse: boolean } {
  const base = Math.max(prev.intervalDays, 1);
  if (o.correctness < p.failThreshold) return { intervalDays: 1, lapse: prev.intervalDays > 0 };
  if (o.correctness < p.successThreshold) return { intervalDays: Math.max(1, Math.round(base * 0.5)), lapse: false };
  switch (o.kind) {
    case 'delayed_unaided': {
      const elapsedDays = prev.lastExposureAt === null ? base : (o.at - prev.lastExposureAt) / DAY;
      const credited = Math.max(base, Math.min(elapsedDays, 2 * base)); // late recall earns some extra credit, bounded
      return { intervalDays: Math.min(p.maxIntervalDays, Math.round(credited * p.growth * 10) / 10), lapse: false };
    }
    case 'first_cold': return { intervalDays: prev.intervalDays > 0 ? Math.round(base * 1.5 * 10) / 10 : p.firstIntervalDays, lapse: false };
    case 'recent_unaided': return { intervalDays: Math.max(1, Math.round(base * 1.2 * 10) / 10), lapse: false };
    default: return { intervalDays: 1, lapse: false }; // after_explanation / hinted / assisted: verify tomorrow, no growth
  }
}

export interface TraceEntry { attemptId: string; counted: boolean; kind: EvidenceKind | null; success: boolean | null; weight: number; repeat: boolean }
export interface ReplayOptions { params?: SchedulerParams; tz: string; activeMisconceptions?: number; trace?: TraceEntry[] }

export function replay(attemptsIn: AttemptRecord[], opts: ReplayOptions): ConceptState {
  const p = opts.params ?? DEFAULT_PARAMS;
  const attempts = [...attemptsIn].sort((a, b) => a.at - b.at);
  const st = emptyState();
  const feedbackSeenInSession = new Set<string>();
  const questionSeen = new Set<string>();
  const successQs = new Set<string>();
  const successDays = new Set<string>();
  const recent: { c: number; w: number }[] = [];
  let lastIndepCorrect: boolean | null = null;
  let recentConfError = 0;

  for (const a of attempts) {
    const prior = st.lastExposureAt;
    const counts = a.gradeStatus === 'graded' && a.correctness !== null;
    const explained = a.sessionId !== null && feedbackSeenInSession.has(a.sessionId);
    const repeat = questionSeen.has(a.questionId);
    // exposure is updated regardless of grading outcome: the student saw the material
    st.lastExposureAt = a.at;
    if (a.feedbackShown && a.sessionId) feedbackSeenInSession.add(a.sessionId);
    questionSeen.add(a.questionId);
    if (!counts) { st.ignored++; opts.trace?.push({ attemptId: a.id, counted: false, kind: null, success: null, weight: 0, repeat }); continue; }

    const kind = classify(a, { priorExposureAt: prior, explainedInSession: explained }, p);
    const correctness = a.idk ? 0 : a.correctness!;
    const w = p.weights[kind] * (a.gradeSource === 'student' ? p.studentGradeFactor : 1) * (repeat ? p.repeatQuestionFactor : 1);
    const success = correctness >= p.successThreshold;
    const independent = kind !== 'hinted' && kind !== 'assisted';
    opts.trace?.push({ attemptId: a.id, counted: true, kind, success, weight: w, repeat });

    st.counted++; st.lastKind = kind;
    const nx = nextInterval({ intervalDays: st.intervalDays, lastExposureAt: prior, lapses: st.lapses }, { kind, correctness, at: a.at }, p);
    st.intervalDays = nx.intervalDays;
    if (nx.lapse) st.lapses++;
    st.dueAt = a.at + st.intervalDays * DAY;

    if (independent) {
      st.independentAttempts++; st.lastIndependentAt = a.at; lastIndepCorrect = success;
      if (success) {
        st.independentSuccesses++;
        if (kind === 'delayed_unaided') st.delayedUnaidedSuccesses++;
        if (!repeat) { successQs.add(a.questionId); successDays.add(localDateKey(new Date(a.at), opts.tz)); }
      }
    }
    if (a.confidence === 3 && correctness < p.failThreshold && !a.idk) { st.highConfidenceErrors++; recentConfError = 3; }
    else if (recentConfError > 0) recentConfError--;
    if (w > 0 || !independent) { recent.push({ c: correctness, w: Math.max(w, 0.1) }); if (recent.length > 5) recent.shift(); }
  }

  st.distinctSuccessQuestions = successQs.size;
  st.distinctSuccessDays = successDays.size;
  if (recent.length) st.recentAccuracy = recent.reduce((s, r) => s + r.c * r.w, 0) / recent.reduce((s, r) => s + r.w, 0);

  if (st.counted === 0) st.level = 'not_assessed';
  else if (
    st.delayedUnaidedSuccesses >= 1 && st.independentSuccesses >= 3 && st.distinctSuccessQuestions >= 2 &&
    st.distinctSuccessDays >= 2 && lastIndepCorrect === true && !(opts.activeMisconceptions ?? 0)
  ) st.level = 'solid';
  else if (lastIndepCorrect === false || (opts.activeMisconceptions ?? 0) > 0 || recentConfError > 0 || (st.recentAccuracy !== null && st.recentAccuracy < 0.4)) st.level = 'shaky';
  else st.level = 'learning';
  return st;
}

export const isDue = (s: ConceptState, now: number) => s.dueAt !== null && now >= s.dueAt; // inclusive boundary

export const LEVEL_LABEL: Record<Level, string> = {
  not_assessed: 'Not assessed yet', learning: 'Building', shaky: 'Needs repair', solid: 'Holding up',
};
