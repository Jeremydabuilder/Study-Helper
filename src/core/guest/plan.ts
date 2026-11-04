/**
 * Today's plan from what the profile holds: deadlines first, inside the time that is really free. Nothing here is hidden: every block says why it is there,
 * dates that were guesses are flagged, and anything that does not fit is listed instead of squeezed in. Only CONFIRMED profile items are used (saving = confirming).
 */
import { addDaysKey, diffDaysKeys, dowOfKey } from '../time';
import { dueCards } from './practice';
import { AssignmentItem, Profile } from './types';

export type Action = { type: 'homework'; assignmentId: string } | { type: 'quiz'; assignmentId: string | null } | { type: 'review' } | { type: 'none' };
export interface Block { id: string; start: string; end: string; minutes: number; kind: 'work' | 'prep' | 'practice' | 'review'; title: string; why: string; flags: string[]; assignmentId: string | null; action: Action }
export interface Plan {
  date: string; availableMin: number; plannedMin: number; blocks: Block[];
  later: { assignmentId: string; title: string; why: string }[]; notes: string[]; basis: string[]; unconfirmedDates: number;
}
const pad = (n: number) => String(n).padStart(2, '0');
export const hmToMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export const minToHm = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
export const fmtClock = (hm: string) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}${m ? ':' + pad(m) : ''} ${h < 12 ? 'am' : 'pm'}`; };

/** The free stretches of the day: from the earliest sensible start to an hour before bed, minus commitments. */
export function freeIntervals(p: Profile, today: string, nowMin: number | null): { start: number; end: number }[] {
  const dow = dowOfKey(today), weekend = dow === 0 || dow === 6;
  const sleep = p.preferences.sleepHours ?? 8;
  const bed = p.preferences.bedtime ? hmToMin(p.preferences.bedtime) : (7 * 60 - Math.round(sleep * 60) + 24 * 60) % (24 * 60);
  let end = (bed < 5 * 60 ? bed + 24 * 60 : bed) - 60; // study ends an hour before bed; a bedtime just after midnight counts as late the same evening
  end = Math.min(end, 23 * 60);
  let start = weekend ? 10 * 60 : 15 * 30 + 0; // 15:30 on school days
  if (!weekend) start = 15 * 60 + 30;
  if (nowMin !== null) start = Math.max(start, Math.ceil(nowMin / 5) * 5);
  let free = [{ start, end }];
  const busy = p.commitments.filter((c) => c.days.includes(dow)).map((c) => ({ start: hmToMin(c.start), end: hmToMin(c.end) + 15 })); // a quarter hour to get there / wind down
  for (const b of busy) free = free.flatMap((f) => (b.end <= f.start || b.start >= f.end ? [f] : [{ start: f.start, end: Math.max(f.start, b.start) }, { start: Math.min(f.end, b.end), end: f.end }].filter((x) => x.end - x.start > 0)));
  return free.filter((f) => f.end - f.start >= 15);
}

export function availableMinutes(p: Profile, today: string, nowMin: number | null) {
  const dow = dowOfKey(today), weekend = dow === 0 || dow === 6;
  const free = freeIntervals(p, today, nowMin).reduce((t, f) => t + (f.end - f.start), 0);
  const cap = weekend ? p.preferences.weekendStudyMinutes : p.preferences.weekdayStudyMinutes;
  const downtime = weekend ? 60 : 75; // meals and a little rest are not "study time"
  const base = cap !== undefined ? Math.min(cap, free) : Math.max(0, free - downtime);
  return Math.max(0, Math.min(base, 300));
}

/** How many minutes of an assignment belong to today. */
function shareToday(a: AssignmentItem, today: string): { minutes: number; days: number | null; overdue: boolean } {
  const left = Math.max(0, a.estimateMin || 40);
  if (!a.due.date) return { minutes: Math.min(left, 20), days: null, overdue: false };
  const d = diffDaysKeys(today, a.due.date);
  if (d < 0) return { minutes: left, days: d, overdue: true };
  if (d <= 1) return { minutes: left, days: d, overdue: false };
  const spread = Math.min(d, a.type === 'test' ? 5 : 3);
  return { minutes: Math.max(15, Math.ceil(left / spread / 5) * 5), days: d, overdue: false };
}
const dueWords = (a: AssignmentItem, days: number | null) => a.due.date ? (days! < 0 ? `was due ${a.due.date}` : days === 0 ? 'due today' : days === 1 ? 'due tomorrow' : `due in ${days} days (${a.due.date})`) : 'no deadline set';

export function buildPlan(p: Profile, today: string, nowMin: number | null = null): Plan {
  const free = freeIntervals(p, today, nowMin);
  let budget = availableMinutes(p, today, nowMin);
  const session = Math.max(15, Math.min(60, p.preferences.sessionMinutes ?? 30));
  const notes: string[] = [], basis: string[] = [];
  const open = p.assignments.filter((a) => !a.done);
  if (p.preferences.weekdayStudyMinutes !== undefined || p.preferences.weekendStudyMinutes !== undefined) basis.push('your stated study time'); else basis.push('an estimate of your free time (after-school hours, minus commitments and downtime)');
  if (p.preferences.sleepHours !== undefined || p.preferences.bedtime) basis.push('your sleep'); else notes.push('You have not said how much you sleep, so 8 hours was assumed. Answer that question to improve the plan.');
  const todays = p.commitments.filter((c) => c.days.includes(dowOfKey(today)));
  if (todays.length) basis.push(`today’s commitments (${todays.map((c) => c.title).join(', ')})`);
  const unconfirmedDates = open.filter((a) => a.due.certainty === 'uncertain').length;
  if (unconfirmedDates) notes.push(`${unconfirmedDates} date${unconfirmedDates === 1 ? ' is' : 's are'} a guess. Check ${unconfirmedDates === 1 ? 'it' : 'them'} in your profile.`);

  const ranked = open.map((a) => ({ a, ...shareToday(a, today) })).sort((x, y) => (x.overdue === y.overdue ? 0 : x.overdue ? -1 : 1) || (x.days ?? 999) - (y.days ?? 999) || (x.a.type === 'test' ? -1 : 0) - (y.a.type === 'test' ? -1 : 0));
  const wanted: { a: AssignmentItem; minutes: number; why: string; flags: string[] }[] = [];
  const later: Plan['later'] = [];
  let remaining = budget;
  for (const r of ranked) {
    const m = Math.min(r.minutes, remaining);
    const flags: string[] = []; if (r.a.due.certainty === 'uncertain') flags.push(`Date not confirmed: ${r.a.due.reason ?? 'check it'}`);
    if (m < Math.min(r.minutes, 15)) { later.push({ assignmentId: r.a.id, title: r.a.title, why: r.days !== null && r.days <= 1 ? `It is ${dueWords(r.a, r.days)} and there is no time left today. You may need to start earlier or ask for more time.` : 'Not enough time today. It stays for another day.' }); continue; }
    if (m < r.minutes && (r.days ?? 9) <= 1) flags.push(`Only ${m} of about ${r.minutes} minutes fit today.`);
    wanted.push({ a: r.a, minutes: m, why: `${r.a.type === 'test' ? 'Test prep' : 'Work'}: ${dueWords(r.a, r.days)}${r.a.className ? ` · ${r.a.className}` : ''}`, flags });
    remaining -= m;
  }
  const reviewDue = dueCards(p, today).length;
  const blocks: Block[] = [];
  const slots = free.map((f) => ({ ...f }));
  let si = 0;
  const place = (minutes: number): { start: number; end: number } | null => {
    while (si < slots.length && slots[si].end - slots[si].start < Math.min(minutes, 10)) si++;
    if (si >= slots.length) return null;
    const s = slots[si]; const len = Math.min(minutes, s.end - s.start); const r = { start: s.start, end: s.start + len }; s.start += len + (len >= 25 ? 5 : 0); return r;
  };
  const addBlock = (b: Omit<Block, 'id' | 'start' | 'end' | 'minutes'>, minutes: number) => {
    let left = minutes;
    while (left > 0) {
      const chunk = Math.min(left, session); const spot = place(chunk); if (!spot) return left;
      blocks.push({ ...b, id: `b${blocks.length + 1}`, start: minToHm(spot.start), end: minToHm(spot.end), minutes: spot.end - spot.start, title: left > chunk || minutes > session ? `${b.title}` : b.title });
      left -= spot.end - spot.start; if (spot.end - spot.start < chunk) break;
    }
    return left;
  };
  for (const w of wanted) {
    const act: Action = w.a.type === 'test' ? { type: 'quiz', assignmentId: w.a.id } : { type: 'homework', assignmentId: w.a.id };
    const left = addBlock({ kind: w.a.type === 'test' ? 'prep' : 'work', title: w.a.title, why: w.why, flags: w.flags, assignmentId: w.a.id, action: act }, w.minutes);
    if (left > 0) { w.flags.push(`${left} minutes did not fit in today’s free time.`); }
  }
  if (reviewDue > 0 && remaining >= 10) { const m = Math.min(15, remaining); addBlock({ kind: 'review', title: `Review ${reviewDue} card${reviewDue === 1 ? '' : 's'}`, why: 'Cards you missed or are due again come back at spaced intervals.', flags: [], assignmentId: null, action: { type: 'review' } }, m); remaining -= m; }
  else if (reviewDue === 0 && p.notes.length > 0 && remaining >= 15 && !blocks.some((b) => b.kind === 'prep')) { addBlock({ kind: 'practice', title: 'Short retrieval practice from your notes', why: 'Trying to remember, without looking, helps more than rereading.', flags: [], assignmentId: null, action: { type: 'quiz', assignmentId: null } }, 15); }
  const planned = blocks.reduce((t, b) => t + b.minutes, 0);
  if (!open.length && !blocks.length) notes.push('Nothing is due. Add an assignment or a test in your profile, or practise from your notes.');
  if (budget <= 0) notes.push('There is no free study time left today after your commitments and bedtime.');
  blocks.sort((x, y) => x.start.localeCompare(y.start));
  return { date: today, availableMin: budget, plannedMin: planned, blocks, later, notes, basis, unconfirmedDates };
}
export const nextDays = (today: string, n: number) => Array.from({ length: n }, (_, i) => addDaysKey(today, i));
