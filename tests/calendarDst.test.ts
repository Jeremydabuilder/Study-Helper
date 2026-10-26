import { afterEach, describe, expect, it } from 'vitest';
import { RawGoogleEvent, classifyEvent, normalizeEvent } from '../src/core/calendar';
import { DEFAULT_AVAILABILITY, buildSchedule, dayCapacity } from '../src/core/schedule';
import { MIN, dayBounds, localDateKey, localParts, zonedToUtc } from '../src/core/time';
import { MemoryGateway } from '../src/server/services/calendarGoogle';
import { startServer, TestServer } from './helpers';

const NY = 'America/New_York';
const hhmm = (ms: number) => { const p = localParts(new Date(ms), NY); return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`; };
let s: TestServer;
afterEach(async () => { await s?.close(); });

describe('America/New_York daylight-saving boundaries', () => {
  it('2026 transitions: spring forward Sun Mar 8 (23h day), fall back Sun Nov 1 (25h day)', () => {
    const hours = (k: string) => { const b = dayBounds(k, NY); return (b.end.getTime() - b.start.getTime()) / 3600_000; };
    expect([hours('2026-03-07'), hours('2026-03-08'), hours('2026-03-09')]).toEqual([24, 23, 24]);
    expect([hours('2026-10-31'), hours('2026-11-01'), hours('2026-11-02')]).toEqual([24, 25, 24]);
  });
  it('events bucket into the right LOCAL day even when the UTC date differs, on both transition days', () => {
    // 23:30 EDT on Mar 8 is already Mar 9 in UTC; 23:30 EST on Nov 1 is Nov 2 in UTC
    expect(localDateKey(new Date('2026-03-09T03:30:00Z'), NY)).toBe('2026-03-08');
    expect(localDateKey(new Date('2026-11-02T04:30:00Z'), NY)).toBe('2026-11-01');
    // exact midnight boundaries (EST/EDT offsets differ either side of the change)
    expect(localDateKey(new Date('2026-11-02T04:59:59Z'), NY)).toBe('2026-11-01');
    expect(localDateKey(new Date('2026-11-02T05:00:00Z'), NY)).toBe('2026-11-02');
    expect(localDateKey(new Date('2026-03-08T04:59:59Z'), NY)).toBe('2026-03-07');
    expect(localDateKey(new Date('2026-03-08T05:00:00Z'), NY)).toBe('2026-03-08');
    // both occurrences of the repeated 01:30 on Nov 1 are the same local date
    expect(localDateKey(new Date('2026-11-01T05:30:00Z'), NY)).toBe('2026-11-01'); // 01:30 EDT
    expect(localDateKey(new Date('2026-11-01T06:30:00Z'), NY)).toBe('2026-11-01'); // 01:30 EST
  });
  it('wall-clock conversion: skipped 02:30 resolves forward, repeated 01:30 resolves deterministically', () => {
    expect(hhmm(zonedToUtc('2026-03-08', '02:30', NY).getTime())).toBe('03:30'); // does not exist -> moves forward
    const r = zonedToUtc('2026-11-01', '01:30', NY).toISOString();
    expect(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']).toContain(r);
    expect(zonedToUtc('2026-11-01', '01:30', NY).toISOString()).toBe(r); // stable
  });
  it('preferred study hours stay at the same wall-clock time across the change (15:30 local before and after)', () => {
    const now = zonedToUtc('2026-10-30', '08:00', NY).getTime();
    const r = buildSchedule({ now, tz: NY, settings: { ...DEFAULT_AVAILABILITY, dailyLimitMin: [60, 60, 60, 60, 60, 60, 60] }, busy: [], horizonDays: 6,
      demands: [{ itemId: 'a', title: 'Big test', kind: 'test_prep', totalMin: 300, doneMin: 0, firstDay: '2026-10-30', lastDay: '2026-11-04', subjectId: null, conceptIds: [], estimateSource: 'user' }] });
    const first = new Map<string, number>();
    for (const b of r.blocks) if (!first.has(b.dateKey)) first.set(b.dateKey, b.start);
    expect([...first.keys()].sort()).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    for (const [k, st] of first) expect(hhmm(st), k).toBe('15:30');
    expect(first.get('2026-10-31')! - first.get('2026-10-30')!).toBe(24 * 60 * MIN);       // both EDT
    expect(first.get('2026-11-02')! - first.get('2026-11-01')!).toBe(24 * 60 * MIN);       // both EST
    expect(first.get('2026-11-01')! - first.get('2026-10-31')!).toBe(25 * 60 * MIN);       // across the fall-back: 25h apart in real time
  });
  it('busy time is applied in real elapsed time on the 25h day (event + buffers), never overlapping a block', () => {
    const now = zonedToUtc('2026-10-31', '08:00', NY).getTime();
    const busy = [{ start: zonedToUtc('2026-11-01', '13:00', NY).getTime(), end: zonedToUtc('2026-11-01', '17:00', NY).getTime(), label: 'Match' }];
    const cap = dayCapacity('2026-11-01', DEFAULT_AVAILABILITY, busy, NY, now);
    expect(cap.busyMin).toBe(240);
    const ends = cap.windows.map((w) => hhmm(w.start));
    expect(ends).toContain('17:15'); // 15-minute buffer after a 17:00 EST end
    for (const w of cap.windows) expect(w.end <= busy[0].start - 15 * MIN || w.start >= busy[0].end + 15 * MIN).toBe(true);
    const spring = dayCapacity('2026-03-08', DEFAULT_AVAILABILITY, [{ start: zonedToUtc('2026-03-08', '16:00', NY).getTime(), end: zonedToUtc('2026-03-08', '17:30', NY).getTime(), label: 'x' }], NY, zonedToUtc('2026-03-07', '08:00', NY).getTime());
    expect(spring.windows.every((w) => w.end <= zonedToUtc('2026-03-08', '15:45', NY).getTime() || w.start >= zonedToUtc('2026-03-08', '17:45', NY).getTime())).toBe(true);
  });
  it('all-day events on transition days are floating dates (no 23/25-hour drift) and block the whole local day', () => {
    for (const d of ['2026-03-08', '2026-11-01']) {
      const e = normalizeEvent({ id: d, summary: 'Tournament', start: { date: d }, end: { date: new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10) } } as RawGoogleEvent, 'c', NY)!;
      expect([e.startDate, e.endDate]).toEqual([d, d]);
      const c = classifyEvent(normalizeEvent({ id: 'q' + d, summary: 'History quiz', start: { date: d }, end: { date: d } } as RawGoogleEvent, 'c', NY)!, [], NY);
      expect(c.due).toMatchObject({ kind: 'date', date: d });
    }
  });
  it('a timed test just after midnight on the fall-back day belongs to Nov 1, and a quiz at 23:30 on Mar 8 to Mar 8', () => {
    const t = classifyEvent(normalizeEvent({ id: 'a', summary: 'Math test', start: { dateTime: '2026-11-01T04:30:00Z' }, end: { dateTime: '2026-11-01T05:30:00Z' } } as RawGoogleEvent, 'c', NY)!, [], NY); // 00:30 EDT Nov 1
    expect(t.due.date).toBe('2026-11-01');
    const q = classifyEvent(normalizeEvent({ id: 'b', summary: 'Science quiz', start: { dateTime: '2026-03-09T03:30:00Z' }, end: { dateTime: '2026-03-09T04:00:00Z' } } as RawGoogleEvent, 'c', NY)!, [], NY);
    expect(q.due.date).toBe('2026-03-08');
  });
});

describe('recurring events (single instances with a shared recurringEventId)', () => {
  const inst = (n: number, date: string, extra: Partial<RawGoogleEvent> = {}): RawGoogleEvent => ({ id: `quiz_${n}`, recurringEventId: 'quiz', summary: 'Friday vocab quiz', status: 'confirmed', start: { dateTime: `${date}T19:00:00Z` }, end: { dateTime: `${date}T19:30:00Z` }, ...extra });
  async function boot() {
    const gw = new MemoryGateway();
    gw.calendars = [{ id: 'c', name: 'English', tz: NY, color: null, primary: true }];
    gw.events.set('c', [inst(1, '2026-10-30'), inst(2, '2026-11-06'), inst(3, '2026-11-13'), inst(4, '2026-11-20')]);
    s = await startServer({ gateway: gw });
    await s.call('POST', '/api/calendar/connect', {});
    await s.call('PUT', '/api/calendar/calendars', { calendars: [{ id: 'c', selected: true, label: 'tests' }] });
    await s.call('POST', '/api/calendar/sync', {});
    return gw;
  }
  it('imports each instance once, groups them for confirmation, and confirms the whole series at once', async () => {
    await boot();
    const p = (await s.call('GET', '/api/items?status=proposed')).body;
    expect(p).toHaveLength(4); expect(new Set(p.map((x: any) => x.event.recurringId))).toEqual(new Set(['quiz']));
    await s.call('POST', '/api/items/bulk', { ids: p.map((x: any) => x.id), action: 'confirm' });
    expect((await s.call('GET', '/api/items?status=confirmed')).body).toHaveLength(4);
    await s.call('POST', '/api/calendar/sync', {});
    expect(s.rt.ctx('real').db.get<any>('SELECT COUNT(*) n FROM academic_items').n).toBe(4);
  });
  it('an exception to one instance (moved / cancelled) affects only that instance', async () => {
    const gw = await boot();
    for (const x of (await s.call('GET', '/api/items?status=proposed')).body) await s.call('POST', `/api/items/${x.id}/confirm`, {});
    gw.events.set('c', [inst(1, '2026-10-30'), inst(2, '2026-11-09'), { id: 'quiz_3', status: 'cancelled', recurringEventId: 'quiz' } as RawGoogleEvent, inst(4, '2026-11-20')]);
    const r = (await s.call('POST', '/api/calendar/sync', {})).body;
    expect(r).toMatchObject({ changed: 1, cancelled: 1, added: 0 });
    const by = Object.fromEntries((await s.call('GET', '/api/items?status=confirmed')).body.map((i: any) => [i.event.whenLabel.split(',')[0] + i.dueDate, i]));
    const states = (await s.call('GET', '/api/items?status=confirmed')).body.map((i: any) => [i.dueDate, i.syncState]).sort();
    expect(states).toEqual([['2026-10-30', 'ok'], ['2026-11-09', 'source_changed'], ['2026-11-13', 'source_cancelled'], ['2026-11-20', 'ok']]);
    void by;
  });
  it('a new instance appearing later is proposed once; a dismissed one is never re-proposed', async () => {
    const gw = await boot();
    const [first] = (await s.call('GET', '/api/items?status=proposed')).body;
    await s.call('POST', `/api/items/${first.id}/dismiss`, {});
    gw.events.set('c', [...gw.events.get('c')!, inst(5, '2026-11-27')]);
    await s.call('POST', '/api/calendar/sync', {}); await s.call('POST', '/api/calendar/sync', {});
    expect((await s.call('GET', '/api/items?status=proposed')).body).toHaveLength(4); // 3 old + 1 new
    expect((await s.call('GET', '/api/items?status=dismissed')).body).toHaveLength(1);
  });
});
