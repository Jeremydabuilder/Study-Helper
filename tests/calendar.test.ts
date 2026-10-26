import { describe, expect, it } from 'vitest';
import { classifyEvent, diffEvents, eventKey, normalizeEvent, RawGoogleEvent, NormalizedEvent } from '../src/core/calendar';
import { DEFAULT_AVAILABILITY, buildSchedule, dayCapacity, Demand } from '../src/core/schedule';
import { DAY, MIN, dayBounds, localDateKey, zonedToUtc } from '../src/core/time';

const NY = 'America/New_York';
const subjects = [{ id: 'math', name: 'Math', aliases: ['Algebra'] }, { id: 'hist', name: 'History' }];
const ev = (o: RawGoogleEvent) => normalizeEvent(o, 'cal1', NY)!;

describe('time zones & DST', () => {
  it('converts wall-clock times and handles 23h/25h days', () => {
    expect(zonedToUtc('2026-01-15', '09:00', NY).toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(zonedToUtc('2026-07-15', '09:00', NY).toISOString()).toBe('2026-07-15T13:00:00.000Z');
    const spring = dayBounds('2026-03-08', NY), fall = dayBounds('2026-11-01', NY);
    expect((spring.end.getTime() - spring.start.getTime()) / 3600000).toBe(23);
    expect((fall.end.getTime() - fall.start.getTime()) / 3600000).toBe(25);
  });
  it('localDateKey follows the user zone, not UTC', () => {
    expect(localDateKey(new Date('2026-10-26T02:30:00Z'), NY)).toBe('2026-10-25');
  });
});

describe('event normalisation', () => {
  it('all-day events use inclusive floating dates (Google end date is exclusive)', () => {
    const e = ev({ id: 'a', summary: 'Tournament', start: { date: '2026-11-07' }, end: { date: '2026-11-09' } });
    expect(e.allDay).toBe(true); expect([e.startDate, e.endDate]).toEqual(['2026-11-07', '2026-11-08']);
    expect(e.startUtc).toBeNull();
  });
  it('timed events keep the instant regardless of the event zone', () => {
    const e = ev({ id: 'b', summary: 'Quiz', start: { dateTime: '2026-11-03T08:00:00+09:00', timeZone: 'Asia/Tokyo' }, end: { dateTime: '2026-11-03T09:00:00+09:00' } });
    expect(new Date(e.startUtc!).toISOString()).toBe('2026-11-02T23:00:00.000Z');
    expect(e.tz).toBe('Asia/Tokyo');
  });
  it('keeps cancelled stubs, recurring instance ids and fingerprints that change with content', () => {
    const c = normalizeEvent({ id: 'x_20261101', status: 'cancelled', recurringEventId: 'x' }, 'cal1', NY)!;
    expect(c.status).toBe('cancelled'); expect(c.recurringEventId).toBe('x');
    const a = ev({ id: 'z', summary: 'HW', start: { dateTime: '2026-11-03T15:00:00-05:00' }, end: { dateTime: '2026-11-03T16:00:00-05:00' } });
    const b = ev({ id: 'z', summary: 'HW', start: { dateTime: '2026-11-04T15:00:00-05:00' }, end: { dateTime: '2026-11-04T16:00:00-05:00' } });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('academic detection never invents details', () => {
  it('detects a test, with a timed event interpreted as the test occurrence, and leaves topics unknown', () => {
    const c = classifyEvent(ev({ id: '1', summary: 'Math Unit 3 Test', start: { dateTime: '2026-11-05T10:00:00-05:00' }, end: { dateTime: '2026-11-05T11:00:00-05:00' } }), subjects, NY);
    expect(c.academicType).toBe('test'); expect(c.subjectId).toBe('math'); expect(c.due.date).toBe('2026-11-05');
    expect(c.topicsText).toBeNull();
  });
  it('does not treat a timed homework event start as a deadline', () => {
    const c = classifyEvent(ev({ id: '2', summary: 'English reading ch. 4', start: { dateTime: '2026-11-05T19:00:00-05:00' }, end: { dateTime: '2026-11-05T19:30:00-05:00' } }), subjects, NY);
    expect(c.academicType).toBe('homework'); expect(c.due.kind).toBe('unknown'); expect(c.subjectId).toBeNull();
  });
  it('uses "due" in the title and all-day dates only as labelled proposals', () => {
    const t = classifyEvent(ev({ id: '3', summary: 'History essay due', start: { dateTime: '2026-11-06T08:00:00-05:00' }, end: { dateTime: '2026-11-06T08:10:00-05:00' } }), subjects, NY);
    expect(t.due.kind).toBe('datetime'); expect(t.due.basis).toMatch(/confirm/i);
    const d = classifyEvent(ev({ id: '4', summary: 'Science project', start: { date: '2026-11-20' }, end: { date: '2026-11-21' } }), subjects, NY);
    expect(d.due).toMatchObject({ kind: 'date', date: '2026-11-20' }); expect(d.due.basis).toMatch(/assumed/i);
  });
  it('reads topics only when the description states them, verbatim', () => {
    const c = classifyEvent(ev({ id: '5', summary: 'History quiz', description: 'Covers: Causes of WWI, alliances\nBring a pencil', start: { date: '2026-11-09' }, end: { date: '2026-11-10' } }), subjects, NY);
    expect(c.academicType).toBe('quiz'); expect(c.topicsText).toBe('Causes of WWI, alliances');
  });
  it('does not mistake review sessions, negations, or activities for assessments', () => {
    const f = (s: string) => classifyEvent(ev({ id: s, summary: s, start: { dateTime: '2026-11-05T16:00:00-05:00' }, end: { dateTime: '2026-11-05T17:00:00-05:00' } }), subjects, NY);
    expect(f('Math test review session').academicType).toBeNull();
    expect(f('No quiz today').academicType).toBeNull();
    expect(f('Tennis practice').role).toBe('activity');
    expect(f('Final draft of essay').academicType).toBe('homework');
  });
});

describe('sync diff: updates, cancellations, duplicates', () => {
  const win = { from: Date.parse('2026-10-25T00:00:00Z'), to: Date.parse('2026-12-25T00:00:00Z') };
  const base = ev({ id: 'e1', summary: 'Quiz', start: { dateTime: '2026-11-05T15:00:00Z' }, end: { dateTime: '2026-11-05T16:00:00Z' } });
  const lite = (e: NormalizedEvent, extra = {}) => ({ key: eventKey(e.calendarId, e.eventId), fingerprint: e.fingerprint, status: e.status, startUtc: e.startUtc, startDate: e.startDate, missing: false, ...extra });
  it('detects new, unchanged, changed (moved) and cancelled events', () => {
    const moved = ev({ id: 'e1', summary: 'Quiz', start: { dateTime: '2026-11-06T15:00:00Z' }, end: { dateTime: '2026-11-06T16:00:00Z' } });
    expect(diffEvents([], [base], win, NY).added).toHaveLength(1);
    expect(diffEvents([lite(base)], [base], win, NY).unchanged).toBe(1);
    expect(diffEvents([lite(base)], [moved], win, NY).changed).toHaveLength(1);
    const cancelled = normalizeEvent({ id: 'e1', status: 'cancelled' }, 'cal1', NY)!;
    expect(diffEvents([lite(base)], [cancelled], win, NY).cancelled).toHaveLength(1);
    // an already-cancelled, never-imported event is ignored
    expect(diffEvents([], [cancelled], win, NY).added).toHaveLength(0);
  });
  it('flags events that vanish from the window, and ignores duplicates within a batch', () => {
    expect(diffEvents([lite(base)], [], win, NY).missing).toHaveLength(1);
    const outside = { ...lite(base), startUtc: Date.parse('2027-03-01T00:00:00Z') };
    expect(diffEvents([outside], [], win, NY).missing).toHaveLength(0);
    const d = diffEvents([], [base, base], win, NY);
    expect(d.added).toHaveLength(1); expect(d.duplicatesInBatch).toBe(1);
  });
});

describe('availability: busy time does not mean all other time is free', () => {
  const S = DEFAULT_AVAILABILITY;
  const day = '2026-11-02'; // Monday
  const now = zonedToUtc('2026-11-01', '12:00', NY).getTime();
  const at = (hhmm: string) => zonedToUtc(day, hhmm, NY).getTime();
  it('applies buffers around busy time, protected windows, bedtime and the daily limit', () => {
    const cap = dayCapacity(day, S, [{ start: at('16:00'), end: at('17:30'), label: 'Tennis' }], NY, now);
    const covered = (h: string) => cap.windows.some((w) => at(h) >= w.start && at(h) < w.end);
    expect(covered('15:40')).toBe(true);
    expect(covered('15:50')).toBe(false); // 15 min buffer before tennis
    expect(covered('17:40')).toBe(false); // 15 min buffer after
    expect(covered('18:30')).toBe(false); // protected dinner
    expect(covered('19:30')).toBe(true);
    expect(cap.capMin).toBe(45); // Monday limit, not "all remaining minutes"
    const late = dayCapacity(day, { ...S, preferredEnd: '23:30', bedtime: '22:00', windDownMin: 60 }, [], NY, now);
    expect(Math.max(...late.windows.map((w) => w.end))).toBe(at('21:00'));
  });
  it('lowers the cap on heavy days and clips to now for today', () => {
    const heavy = dayCapacity(day, S, [{ start: at('08:00'), end: at('13:00'), label: 'Tournament' }], NY, now);
    expect(heavy.heavy).toBe(true); expect(heavy.capMin).toBe(20);
    const t = at('17:00');
    expect(dayCapacity(day, S, [], NY, t).windows[0].start).toBeGreaterThanOrEqual(t);
  });
  it('is DST-correct: preferred hours stay at local wall-clock time', () => {
    const cap = dayCapacity('2026-11-02', S, [], NY, now);
    expect(new Date(cap.windows[0].start).toISOString()).toBe('2026-11-02T20:30:00.000Z'); // 15:30 EST
    const cap2 = dayCapacity('2026-10-26', S, [], NY, Date.parse('2026-10-25T12:00:00Z'));
    expect(new Date(cap2.windows[0].start).toISOString()).toBe('2026-10-26T19:30:00.000Z'); // 15:30 EDT
  });
});

describe('study schedule', () => {
  const S = { ...DEFAULT_AVAILABILITY, dailyLimitMin: [60, 60, 60, 60, 60, 60, 60] };
  const now = zonedToUtc('2026-11-02', '12:00', NY).getTime(); // Monday
  const test: Demand = { itemId: 't', title: 'Math test', kind: 'test_prep', totalMin: 120, doneMin: 0, lastDay: '2026-11-05', subjectId: 'math', conceptIds: [], estimateSource: 'default' };
  it('spreads test prep over the days before the test, never on the test day, within daily limits', () => {
    const r = buildSchedule({ now, tz: NY, settings: S, busy: [], demands: [test] });
    const byDay = new Map<string, number>();
    for (const b of r.blocks) byDay.set(b.dateKey, (byDay.get(b.dateKey) ?? 0) + b.minutes);
    expect([...byDay.keys()].sort()).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
    expect(Math.max(...byDay.values())).toBeLessThanOrEqual(60);
    expect(r.shortfalls).toHaveLength(0);
    expect(r.blocks.reduce((a, b) => a + b.minutes, 0)).toBe(120);
  });
  it('fits around commitments and reports an honest shortfall instead of overbooking', () => {
    const busyAll = [2, 3, 4, 5].map((d) => ({ start: zonedToUtc(`2026-11-0${d}`, '15:00', NY).getTime(), end: zonedToUtc(`2026-11-0${d}`, '20:30', NY).getTime(), label: 'Tennis' }));
    const r = buildSchedule({ now, tz: NY, settings: S, busy: busyAll, demands: [test] });
    expect(r.blocks.length).toBe(0);
    expect(r.shortfalls[0]).toMatchObject({ itemId: 't', missingMin: 120 });
  });
  it('replans when a deadline moves earlier', () => {
    const early = buildSchedule({ now, tz: NY, settings: S, busy: [], demands: [{ ...test, lastDay: '2026-11-03' }] });
    expect(new Set(early.blocks.map((b) => b.dateKey)).size).toBe(2);
    expect(early.blocks.every((b) => b.dateKey <= '2026-11-03')).toBe(true);
  });
  it('completed minutes reduce what is scheduled; homework is placed before its buffer day', () => {
    const hw: Demand = { itemId: 'h', title: 'Worksheet', kind: 'homework', totalMin: 30, doneMin: 10, lastDay: '2026-11-03', subjectId: null, conceptIds: [], estimateSource: 'user' };
    const r = buildSchedule({ now, tz: NY, settings: S, busy: [], demands: [hw] });
    expect(r.blocks.reduce((a, b) => a + b.minutes, 0)).toBe(20);
  });
});
