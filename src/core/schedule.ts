/**
 * Fit study time around real commitments. Pure: takes busy intervals + settings, returns blocks.
 * Busy time does NOT mean every other minute is free: preferred hours, bedtime, protected time, buffers and
 * a daily study limit all apply, and heavy (e.g. tournament) days get a lower cap.
 */
import { DAY, MIN, addDaysKey, diffDaysKeys, dowOfKey, localDateKey, parseHHMM, zonedToUtc } from './time';

export interface ProtectedWindow { label: string; days: number[]; start: string; end: string }
export interface AvailabilitySettings {
  dailyLimitMin: number[];           // index 0 = Sunday
  preferredStart: string; preferredEnd: string; bedtime: string; windDownMin: number;
  bufferBeforeMin: number; bufferAfterMin: number;
  protected: ProtectedWindow[];
  minBlockMin: number; maxBlockMin: number; breakMin: number;
  heavyDayBusyMin: number; heavyDayLimitMin: number;
  testPrepDays: number; defaultTestPrepMin: number; defaultHomeworkMin: number; homeworkBufferDays: number;
}
export const DEFAULT_AVAILABILITY: AvailabilitySettings = {
  dailyLimitMin: [60, 45, 60, 60, 60, 45, 30],
  preferredStart: '15:30', preferredEnd: '20:30', bedtime: '22:00', windDownMin: 45,
  bufferBeforeMin: 15, bufferAfterMin: 15,
  protected: [{ label: 'Dinner & family time', days: [0, 1, 2, 3, 4, 5, 6], start: '18:00', end: '19:00' }],
  minBlockMin: 10, maxBlockMin: 40, breakMin: 5,
  heavyDayBusyMin: 240, heavyDayLimitMin: 20,
  testPrepDays: 5, defaultTestPrepMin: 120, defaultHomeworkMin: 30, homeworkBufferDays: 1,
};

/** `heavy: false` marks routine time (classes) that blocks study but does not make a day a "heavy" day (match/tournament). */
export interface BusyInterval { start: number; end: number; label: string; heavy?: boolean }
export interface Win { start: number; end: number }

const mergeWins = (w: Win[]) => {
  const s = [...w].sort((a, b) => a.start - b.start); const out: Win[] = [];
  for (const x of s) { const l = out[out.length - 1]; if (l && x.start <= l.end) l.end = Math.max(l.end, x.end); else out.push({ ...x }); }
  return out;
};
function subtract(wins: Win[], cut: Win[]): Win[] {
  let cur = wins;
  for (const c of mergeWins(cut)) {
    const next: Win[] = [];
    for (const w of cur) {
      if (c.end <= w.start || c.start >= w.end) next.push(w);
      else { if (c.start > w.start) next.push({ start: w.start, end: c.start }); if (c.end < w.end) next.push({ start: c.end, end: w.end }); }
    }
    cur = next;
  }
  return cur;
}

export interface DayCapacity { dateKey: string; windows: Win[]; capMin: number; busyMin: number; loadMin: number; heavy: boolean; why: string[] }

export function dayCapacity(dateKey: string, s: AvailabilitySettings, busy: BusyInterval[], tz: string, now: number): DayCapacity {
  const why: string[] = [];
  const dow = dowOfKey(dateKey);
  const bedEnd = zonedToUtc(dateKey, s.bedtime, tz).getTime() - s.windDownMin * MIN;
  const start = Math.max(zonedToUtc(dateKey, s.preferredStart, tz).getTime(), now);
  const end = Math.min(zonedToUtc(dateKey, s.preferredEnd, tz).getTime(), bedEnd);
  if (end <= start) return { dateKey, windows: [], capMin: 0, busyMin: 0, loadMin: 0, heavy: false, why: ['Outside your preferred study hours / bedtime.'] };
  const dayStart = zonedToUtc(dateKey, '00:00', tz).getTime(), dayEnd = zonedToUtc(addDaysKey(dateKey, 1), '00:00', tz).getTime();
  const todays = busy.filter((b) => b.end > dayStart && b.start < dayEnd);
  const busyMin = Math.round(todays.reduce((a, b) => a + (Math.min(b.end, dayEnd) - Math.max(b.start, dayStart)), 0) / MIN);
  const loadMin = Math.round(todays.filter((b) => b.heavy !== false).reduce((a, b) => a + (Math.min(b.end, dayEnd) - Math.max(b.start, dayStart)), 0) / MIN);
  const cuts: Win[] = todays.map((b) => ({ start: b.start - s.bufferBeforeMin * MIN, end: b.end + s.bufferAfterMin * MIN }));
  for (const p of s.protected) if (p.days.includes(dow)) {
    cuts.push({ start: zonedToUtc(dateKey, p.start, tz).getTime(), end: zonedToUtc(dateKey, p.end, tz).getTime() });
  }
  const windows = subtract([{ start, end }], cuts).filter((w) => (w.end - w.start) / MIN >= s.minBlockMin);
  const heavy = loadMin >= s.heavyDayBusyMin; // classes alone never make a heavy day
  let cap = s.dailyLimitMin[dow] ?? 0;
  if (heavy && s.heavyDayLimitMin < cap) { cap = s.heavyDayLimitMin; why.push(`Heavy day (${Math.round(loadMin / 60 * 10) / 10}h of matches/commitments outside school): study capped at ${cap} min.`); }
  return { dateKey, windows, capMin: cap, busyMin, loadMin, heavy, why };
}

export type DemandKind = 'test_prep' | 'homework' | 'project';
export interface Demand {
  itemId: string; title: string; kind: DemandKind; totalMin: number; doneMin: number;
  /** first/last day work may be scheduled (inclusive) */ firstDay?: string; lastDay: string; subjectId: string | null; conceptIds: string[];
  estimateSource: 'user' | 'default';
}
export interface Block { itemId: string; title: string; kind: DemandKind; dateKey: string; start: number; end: number; minutes: number; conceptIds: string[]; subjectId: string | null }
export interface Shortfall { itemId: string; title: string; missingMin: number; reason: string }

export interface ScheduleInput { now: number; tz: string; settings: AvailabilitySettings; busy: BusyInterval[]; demands: Demand[]; horizonDays?: number; alreadyScheduledToday?: number; studiedTodayMin?: number }
export interface ScheduleResult { blocks: Block[]; shortfalls: Shortfall[]; days: DayCapacity[] }

export function buildSchedule(inp: ScheduleInput): ScheduleResult {
  const { now, tz, settings: s } = inp;
  const today = localDateKey(new Date(now), tz);
  const horizon = inp.horizonDays ?? 21;
  const days: DayCapacity[] = [];
  for (let i = 0; i < horizon; i++) days.push(dayCapacity(addDaysKey(today, i), s, inp.busy, tz, now));
  const remainingCap = new Map(days.map((d) => [d.dateKey, d.capMin - (d.dateKey === today ? (inp.studiedTodayMin ?? 0) : 0)]));
  const winsByDay = new Map(days.map((d) => [d.dateKey, d.windows.map((w) => ({ ...w }))]));
  const blocks: Block[] = [], shortfalls: Shortfall[] = [];

  const place = (d: Demand, dateKey: string, want: number): number => {
    let left = Math.min(want, remainingCap.get(dateKey) ?? 0), placed = 0;
    const wins = winsByDay.get(dateKey) ?? [];
    for (const w of wins) {
      while (left > 0) {
        const room = Math.floor((w.end - w.start) / MIN);
        const len = Math.min(left, s.maxBlockMin, room);
        if (len <= 0 || len < Math.min(s.minBlockMin, left)) break;
        blocks.push({ itemId: d.itemId, title: d.title, kind: d.kind, dateKey, start: w.start, end: w.start + len * MIN, minutes: len, conceptIds: d.conceptIds, subjectId: d.subjectId });
        w.start += (len + s.breakMin) * MIN; left -= len; placed += len;
        remainingCap.set(dateKey, (remainingCap.get(dateKey) ?? 0) - len);
      }
    }
    return placed;
  };

  const ordered = [...inp.demands].filter((d) => d.totalMin - d.doneMin > 0).sort((a, b) => a.lastDay.localeCompare(b.lastDay) || (a.kind === 'test_prep' ? -1 : 1));
  for (const d of ordered) {
    let remaining = d.totalMin - d.doneMin;
    const usable = days.filter((x) => x.dateKey <= d.lastDay && (!d.firstDay || x.dateKey >= d.firstDay));
    if (!usable.length) { shortfalls.push({ itemId: d.itemId, title: d.title, missingMin: remaining, reason: 'The deadline has already passed or leaves no study days.' }); continue; }
    // pass 1: spread evenly (spacing beats cramming), pass 2: fill leftover capacity
    for (let i = 0; i < usable.length && remaining > 0; i++) {
      const target = Math.max(s.minBlockMin, Math.ceil(remaining / (usable.length - i)));
      remaining -= place(d, usable[i].dateKey, target);
    }
    for (let i = 0; i < usable.length && remaining > 0; i++) remaining -= place(d, usable[i].dateKey, remaining);
    if (remaining > 0) shortfalls.push({ itemId: d.itemId, title: d.title, missingMin: remaining, reason: 'Not enough free study time before the deadline with your current limits, hours and commitments.' });
  }
  blocks.sort((a, b) => a.start - b.start);
  return { blocks, shortfalls, days };
}

/** Last day work may be scheduled for an item, and when prep should begin. */
export function demandWindow(kind: 'test_prep' | 'homework' | 'project', dueKey: string, s: AvailabilitySettings): { lastDay: string } {
  return { lastDay: kind === 'test_prep' ? addDaysKey(dueKey, -1) : addDaysKey(dueKey, -s.homeworkBufferDays) };
}

export const daysBetween = diffDaysKeys;
export { DAY };
