import { describe, expect, it } from 'vitest';
import { AttemptRecord, DEFAULT_PARAMS, classify, isDue, nextInterval, replay } from '../src/core/learning';
import { DAY, HOUR } from '../src/core/time';
import { PlanConcept, planToday, spreadOverdue } from '../src/core/priority';

const T0 = Date.UTC(2026, 9, 1, 15, 0, 0);
let n = 0;
const att = (o: Partial<AttemptRecord> & { at: number }): AttemptRecord => ({
  id: `a${n++}`, conceptId: 'c', questionId: `q${n}`, sessionId: 's1', correctness: 1, gradeStatus: 'graded', gradeSource: 'deterministic',
  hinted: false, sawAnswer: false, idk: false, confidence: null, feedbackShown: true, ...o,
});
const R = (a: AttemptRecord[], mis = 0) => replay(a, { tz: 'America/New_York', activeMisconceptions: mis });

describe('review scheduling & time boundaries', () => {
  it('first cold success schedules a 2-day review; due is inclusive at the boundary', () => {
    const s = R([att({ at: T0 })]);
    expect(s.intervalDays).toBe(2);
    expect(s.dueAt).toBe(T0 + 2 * DAY);
    expect(isDue(s, T0 + 2 * DAY - 1)).toBe(false);
    expect(isDue(s, T0 + 2 * DAY)).toBe(true);
  });
  it('delayed unaided success grows the interval; late recall earns bounded extra credit', () => {
    const onTime = R([att({ at: T0 }), att({ at: T0 + 2 * DAY, sessionId: 's2' })]);
    expect(onTime.lastKind).toBe('delayed_unaided');
    expect(onTime.intervalDays).toBeCloseTo(2 * 2.3, 1);
    const veryLate = R([att({ at: T0 }), att({ at: T0 + 30 * DAY, sessionId: 's2' })]);
    expect(veryLate.intervalDays).toBeCloseTo(4 * 2.3, 1); // credited at most 2x the scheduled interval
  });
  it('a failure resets to one day and counts a lapse', () => {
    const s = R([att({ at: T0 }), att({ at: T0 + 2 * DAY, sessionId: 's2' }), att({ at: T0 + 7 * DAY, sessionId: 's3', correctness: 0 })]);
    expect(s.intervalDays).toBe(1); expect(s.lapses).toBe(1); expect(s.level).toBe('shaky');
  });
  it('delay threshold: 19h is recent, 20h is delayed', () => {
    const p = DEFAULT_PARAMS;
    const base = att({ at: T0 + 19 * HOUR, sessionId: 's2' });
    expect(classify(base, { priorExposureAt: T0, explainedInSession: false }, p)).toBe('recent_unaided');
    expect(classify({ ...base, at: T0 + 20 * HOUR }, { priorExposureAt: T0, explainedInSession: false }, p)).toBe('delayed_unaided');
  });
});

describe('hint-assisted vs unaided attempts', () => {
  it('hinted success never counts as independent and does not extend the interval', () => {
    const s = R([att({ at: T0, hinted: true })]);
    expect(s.independentSuccesses).toBe(0); expect(s.intervalDays).toBe(1); expect(s.lastKind).toBe('hinted');
  });
  it('success right after an explanation is weaker than a delayed unaided success', () => {
    const imm = R([att({ at: T0, correctness: 0 }), att({ at: T0 + 5 * 60_000 })]);
    expect(imm.lastKind).toBe('after_explanation'); expect(imm.intervalDays).toBe(1);
    const delayed = R([att({ at: T0, correctness: 0 }), att({ at: T0 + DAY, sessionId: 's2' })]);
    expect(delayed.lastKind).toBe('delayed_unaided'); expect(delayed.intervalDays).toBeGreaterThan(imm.intervalDays);
  });
  it('"I don\'t know" and seen answers are assisted: no credit', () => {
    expect(R([att({ at: T0, idk: true, correctness: 0 })]).independentAttempts).toBe(0);
    expect(R([att({ at: T0, sawAnswer: true, correctness: 1 })]).independentSuccesses).toBe(0);
  });
});

describe('uncertain grading never changes mastery', () => {
  it('ignores uncertain/failed/pending attempts', () => {
    const s = R([att({ at: T0, gradeStatus: 'uncertain' }), att({ at: T0 + DAY, gradeStatus: 'failed', correctness: null })]);
    expect(s.level).toBe('not_assessed'); expect(s.counted).toBe(0); expect(s.ignored).toBe(2); expect(s.dueAt).toBeNull();
  });
  it('a student correction turns an uncertain grade into counted evidence (at reduced weight)', () => {
    const s = R([att({ at: T0, gradeStatus: 'graded', gradeSource: 'student' })]);
    expect(s.counted).toBe(1);
  });
});

describe('mastery is not claimed from repetition', () => {
  it('repeating one question many times never reaches solid', () => {
    const rep = Array.from({ length: 6 }, (_, i) => att({ at: T0 + i * 2 * DAY, sessionId: `s${i}`, questionId: 'same' }));
    expect(R(rep).level).not.toBe('solid');
  });
  it('same-day successes alone do not reach solid; delayed varied successes do', () => {
    const sameDay = [0, 1, 2, 3].map((i) => att({ at: T0 + i * 60_000, sessionId: 'x', questionId: `q${i}` }));
    expect(R(sameDay).level).not.toBe('solid');
    const spaced = [0, 1, 3, 7].map((d, i) => att({ at: T0 + d * DAY, sessionId: `s${i}`, questionId: `q${i}` }));
    expect(R(spaced).level).toBe('solid');
  });
  it('an active misconception blocks solid', () => {
    const spaced = [0, 1, 3, 7].map((d, i) => att({ at: T0 + d * DAY, sessionId: `s${i}`, questionId: `q${i}` }));
    expect(R(spaced, 1).level).toBe('shaky');
  });
  it('a confident wrong answer is recorded as a high-confidence error', () => {
    const s = R([att({ at: T0, correctness: 0, confidence: 3 })]);
    expect(s.highConfidenceErrors).toBe(1); expect(s.level).toBe('shaky');
  });
});

describe('daily plan', () => {
  const mk = (id: string, state = R([]), extra: Partial<PlanConcept> = {}): PlanConcept => ({
    id, name: id, subjectId: 's', subjectName: 'Math', state, prereqIds: [], activeMisconceptions: 0, openRepair: false, ...extra,
  });
  const now = T0 + 10 * DAY;
  it('separates "not assessed" from "weak" and diagnoses first', () => {
    const plan = planToday({ now, tz: 'UTC', minutes: 10, concepts: [mk('a')], deadlines: [] });
    expect(plan.tasks[0].kind).toBe('diagnose');
    expect(plan.tasks[0].components.weakness).toBe(0);
  });
  it('respects the time budget and exposes the score components', () => {
    const cs = ['a', 'b', 'c', 'd', 'e'].map((i) => mk(i));
    const plan = planToday({ now, tz: 'UTC', minutes: 10, concepts: cs, deadlines: [] });
    expect(plan.minutesPlanned).toBeLessThanOrEqual(11);
    expect(plan.tasks.every((t) => t.reasons.length > 0 && 'urgency' in t.components)).toBe(true);
  });
  it('an approaching test outranks an equally unknown topic', () => {
    const plan = planToday({
      now, tz: 'UTC', minutes: 30, concepts: [mk('a'), mk('b')],
      deadlines: [{ id: 'd', title: 'Unit test', type: 'test', dueAt: now + 2 * DAY, dueKey: null, conceptIds: ['b'], completed: false, cancelled: false }],
    });
    expect(plan.tasks[0].conceptId).toBe('b'); expect(plan.tasks[0].reasons.join(' ')).toMatch(/in 2 days/);
  });
  it('does not keep drilling a solid concept and caps overdue reviews instead of building a backlog', () => {
    const solid = R([0, 1, 3, 7].map((d, i) => att({ at: T0 + d * DAY, sessionId: `s${i}`, questionId: `q${i}` })));
    expect(planToday({ now: T0 + 8 * DAY, tz: 'UTC', minutes: 30, concepts: [mk('a', solid)], deadlines: [] }).tasks).toHaveLength(0);
    const overdue = Array.from({ length: 15 }, (_, i) => mk(`c${i}`, R([att({ at: T0, conceptId: `c${i}` })])));
    const plan = planToday({ now: T0 + 40 * DAY, tz: 'UTC', minutes: 60, concepts: overdue, deadlines: [] });
    expect(plan.tasks.length).toBeLessThanOrEqual(5);
    expect(plan.overdueDeferred).toBeGreaterThan(0); expect(plan.deferredNote).toMatch(/safe/);
  });
  it('honours skip and pin overrides, and spreads overdue work over days', () => {
    const cs = [mk('a'), mk('b')];
    expect(planToday({ now, tz: 'UTC', minutes: 30, concepts: cs, deadlines: [], overrides: [{ conceptId: 'a', action: 'skip' }] }).tasks.map((t) => t.conceptId)).toEqual(['b']);
    expect(planToday({ now, tz: 'UTC', minutes: 30, concepts: cs, deadlines: [], overrides: [{ conceptId: 'b', action: 'pin' }] }).tasks[0].conceptId).toBe('b');
    const m = spreadOverdue(Array.from({ length: 9 }, (_, i) => ({ conceptId: `c${i}`, dueAt: now - DAY, score: 9 - i })), now, 4);
    expect([...m.values()].filter((v) => v === now)).toHaveLength(4);
    expect(Math.max(...m.values())).toBe(now + 2 * DAY);
  });
});

describe('prerequisite wording keeps "not assessed" distinct from "weak"', () => {
  it('says unchecked, not shaky, for a prerequisite nobody has assessed', () => {
    const mk = (id: string, state = R([]), extra: Partial<PlanConcept> = {}): PlanConcept => ({ id, name: id, subjectId: 's', subjectName: 'Math', state, prereqIds: [], activeMisconceptions: 0, openRepair: false, ...extra });
    const plan = planToday({ now: T0, tz: 'UTC', minutes: 30, concepts: [mk('Base'), mk('Advanced', R([]), { prereqIds: ['Base'] })], deadlines: [] });
    const adv = plan.tasks.find((t) => t.conceptId === 'Advanced')!;
    expect(adv.reasons.join(' ')).toMatch(/hasn’t been checked yet/);
    expect(adv.reasons.join(' ')).not.toMatch(/shaky|weak/i);
  });
});
