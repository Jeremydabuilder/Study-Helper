/**
 * Reading pasted notes with plain rules (no AI, runs in the browser). The pasted text is DATA: it is split into lines, each line is matched against fixed
 * patterns, and nothing in it is ever treated as an instruction. Lines that look like instructions to an AI are set aside and shown, not used.
 * Every dated item whose date needed a guess is flagged; items that are only a guess about the person (preferences, goals) are never pre-ticked.
 */
import { NO_DATE, WEEKDAYS, resolveDate, weekdayIndex, withoutDate, type DueInfo } from './dates';
import { Candidate, Candidates, Preferences, emptyCandidates } from './types';

export const MAX_LINE = 400;
const INJECTION = /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|above|prior|all|any|earlier)\b|\b(system|developer) prompt\b|\byou are (now )?(an?|the) (ai|assistant|model|bot)\b|\b(reveal|print|show)\b[^.\n]{0,30}\b(prompt|instructions|api key|secret)\b|<\/?(system|assistant|instructions?)>/i;
const COMMON_CLASSES = ['algebra 1', 'algebra 2', 'algebra', 'geometry', 'pre-calculus', 'precalculus', 'calculus', 'statistics', 'math', 'biology', 'chemistry', 'physics', 'science', 'earth science', 'english', 'literature', 'language arts', 'ela', 'history', 'us history', 'world history', 'government', 'civics', 'economics', 'geography', 'spanish', 'french', 'german', 'latin', 'mandarin', 'art', 'music', 'band', 'orchestra', 'choir', 'drama', 'health', 'pe', 'gym', 'computer science', 'coding', 'psychology', 'sociology', 'chem', 'bio', 'phys'];
const SPORT = /\b(soccer|football|basketball|baseball|softball|tennis|swim(?:ming)?|track|cross country|volleyball|lacrosse|hockey|wrestling|golf|gymnastics|dance|cheer|practice|rehearsal|training|game|match|meet|lesson|club|shift|work|job|tutoring|band|choir|orchestra|debate|robotics|church|babysitting|volunteer(?:ing)?)\b/i;
const DUE_CUE = /\b(due|turn(?:ed)? in|hand in|submit|deadline|test|quiz|exam|midterm|final|project|essay|paper|worksheet|homework|assignment|lab report|lab|presentation|read(?:ing)?|chapter|problem set|study guide|report)\b/i;
const TIME = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?';
const RANGE = new RegExp(`\\b${TIME}\\s*(?:-|–|to|until|till)\\s*${TIME}\\b`, 'i');
const AT = new RegExp(`\\b(?:at|from|@)\\s*${TIME}\\b`, 'i');

let seq = 0;
export const newId = (p = 'x') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const clean = (s: string, n = MAX_LINE) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const titleCase = (s: string) => s.replace(/\b([a-z])([a-z]*)/g, (_m, a: string, b: string) => (['pe', 'ela'].includes(a + b) ? (a + b).toUpperCase() : a.toUpperCase() + b));

function toHM(h: string, m: string | undefined, ap: string | undefined, fallbackPm: boolean | null): string {
  let hh = Number(h); const mm = Number(m ?? 0);
  const a = ap?.toLowerCase().replace(/\./g, '');
  if (a === 'pm' && hh < 12) hh += 12; else if (a === 'am' && hh === 12) hh = 0;
  else if (!a && fallbackPm && hh >= 1 && hh <= 8) hh += 12; // "practice 4-6": after school, not 4 in the morning
  return `${String(Math.min(hh, 23)).padStart(2, '0')}:${String(Math.min(mm, 59)).padStart(2, '0')}`;
}
export function parseTimes(line: string): { start: string; end: string; guessed: boolean } | null {
  let m = line.match(RANGE);
  if (m) {
    const endAp = m[6], startAp = m[3] ?? endAp; // "4-6pm": both pm
    const s = toHM(m[1], m[2], startAp, true), e = toHM(m[4], m[5], endAp ?? startAp, true);
    return { start: s, end: e > s ? e : s, guessed: !m[3] && !m[6] };
  }
  m = line.match(AT);
  if (m) { const s = toHM(m[1], m[2], m[3], true); const [h, mi] = s.split(':').map(Number); const e = `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(mi).padStart(2, '0')}`; return { start: s, end: e, guessed: true }; }
  return null;
}

/** Weekdays named in a line: "Mon/Wed", "Tuesdays and Thursdays", "weekdays", "every day". Empty when none. */
export function parseDays(line: string): number[] {
  const out = new Set<number>();
  if (/\bweekdays?\b|\bmon(?:day)?\s*(?:-|–|to|through|thru)\s*fri(?:day)?\b/i.test(line)) [1, 2, 3, 4, 5].forEach((d) => out.add(d));
  if (/\bweekends?\b/i.test(line)) [0, 6].forEach((d) => out.add(d));
  if (/\bevery ?day\b|\bdaily\b/i.test(line)) [0, 1, 2, 3, 4, 5, 6].forEach((d) => out.add(d));
  for (const m of line.matchAll(/\b(sun(?:day)?s?|mon(?:day)?s?|tue(?:s|sday)?s?|wed(?:nesday)?s?|thu(?:r|rs|rsday)?s?|fri(?:day)?s?|sat(?:urday)?s?)\b/gi)) { const i = weekdayIndex(m[1]); if (i >= 0) out.add(i); }
  return [...out].sort();
}
const RECURRING = /\b(every|each|weekly|daily|weekdays?|weekends?)\b|\b(mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)(?:day)?s\b|\b[a-z]{3,9}days\b|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*[/&,]\s*(mon|tue|wed|thu|fri|sat|sun)/i;

const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const classIn = (line: string): string => {
  const low = line.toLowerCase();
  const hit = COMMON_CLASSES.filter((c) => new RegExp(`\\b${c.replace(/[-]/g, '[- ]?')}\\b`).test(low)).sort((a, b) => b.length - a.length)[0];
  return hit ? titleCase(hit) : '';
};
const cand = <T>(item: T, o: Partial<Candidate<T>> = {}): Candidate<T> => ({ id: newId('c'), item, include: true, flags: [], inferred: false, duplicateOf: null, resolution: null, ...o });

export function extractLocal(raw: string, today: string, opts: { maxChars?: number } = {}): Candidates {
  const out = emptyCandidates();
  const max = opts.maxChars ?? 200_000;
  let text = raw.replace(/\r\n?/g, '\n');
  if (text.length > max) { text = text.slice(0, max); out.truncated = true; }
  const seen = new Set<string>();
  const pushClass = (name: string, inferred: boolean) => { const n = norm(name); if (!n || n.length > 40 || seen.has('c:' + n)) return; seen.add('c:' + n); out.classes.push(cand({ name: titleCase(name.trim()) }, { inferred, include: !inferred })); };

  for (const rawLine of text.split(/\n+|(?<=[.!?])\s{2,}/)) {
    const orig = rawLine.replace(/^[\s>*•\-–\d.)]+/, '');
    if (!orig.trim()) continue;
    if (orig.length > MAX_LINE * 2) { out.ignored.push({ line: clean(orig, 120) + '…', reason: 'Too long to read as one item. Split it into lines.' }); continue; }
    const line = clean(orig);
    if (line.length < 3) continue;
    if (INJECTION.test(line)) { out.ignored.push({ line: clean(line, 160), reason: 'Reads like an instruction to an assistant, not study information. It is not used.' }); continue; }

    // classes list: "My classes: Algebra 2, Biology, English 10"
    const cl = line.match(/\b(?:my )?(?:classes|courses|subjects|schedule)\b\s*(?:are|is|include|:|-)\s*(.+)$/i) ?? line.match(/\bI (?:take|have|am taking|'m taking)\s+(.+)$/i);
    if (cl && !RECURRING.test(cl[1])) { cl[1].split(/,|;|\band\b|\//i).map((x) => x.replace(/\.$/, '').trim()).filter((x) => x && x.length <= 40).forEach((x) => pushClass(x, false)); continue; }

    // preferences
    let prefHit = false;
    const slp = line.match(/\b(?:sleep|sleeping)\b[^.\d]{0,25}(\d{1,2}(?:\.\d)?)\s*(?:hours?|hrs?|h)\b/i) ?? line.match(/\b(\d{1,2}(?:\.\d)?)\s*(?:hours?|hrs?|h)\b[^.\d]{0,12}\bof sleep\b/i);
    if (slp && Number(slp[1]) >= 3 && Number(slp[1]) <= 14) { out.preferences.push(cand({ key: 'sleepHours', value: Number(slp[1]), label: `Sleep about ${Number(slp[1])} hours a night` }, { inferred: true, include: false })); prefHit = true; }
    const bed = line.match(/\bbed(?:time)?\b[^.\d]{0,15}(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (bed) { out.preferences.push(cand({ key: 'bedtime', value: toHM(bed[1], bed[2], bed[3] ?? (Number(bed[1]) <= 11 && Number(bed[1]) >= 6 ? 'pm' : undefined), false), label: `Bedtime around ${toHM(bed[1], bed[2], bed[3] ?? (Number(bed[1]) <= 11 && Number(bed[1]) >= 6 ? 'pm' : undefined), false)}` }, { inferred: true, include: false })); prefHit = true; }
    const ses = line.match(/\b(\d{2,3})\s*[- ]?\s*(?:min|minute)s?\b[^.]{0,20}\b(session|block|stretch|at a time|sprints?)\b/i) ?? line.match(/\b(session|block|stretch)s?\b[^.\d]{0,15}(\d{2,3})\s*(?:min|minute)/i);
    if (ses) { const n = Number(/^\d/.test(ses[1]) ? ses[1] : ses[2]); if (n >= 10 && n <= 120) { out.preferences.push(cand({ key: 'sessionMinutes', value: n, label: `Study in ${n}-minute sessions` }, { inferred: true, include: false })); prefHit = true; } }
    const best = line.match(/\b(?:study|work|focus|concentrate)\b[^.]{0,20}\bbest\b[^.]{0,15}\b(morning|afternoon|evening|night)s?\b/i);
    if (best) { out.preferences.push(cand({ key: 'bestTime', value: best[1].toLowerCase().replace('night', 'night'), label: `Studies best in the ${best[1].toLowerCase()}` }, { inferred: true, include: false })); prefHit = true; }

    // goals
    const goal = line.match(/\b(?:my )?goals?\s*(?:is|are|:|-)\s*(.+)$/i) ?? line.match(/\b(?:I (?:want|hope|plan|need|'d like|would like) to|trying to|aiming to|aim to)\s+(.+)$/i) ?? line.match(/\b(?:help (?:me )?with|struggl\w+ with|worried about)\s+(.+)$/i);
    if (goal && !/\bdue\b/i.test(line) && !(prefHit)) { const t = clean(goal[1].replace(/[.]+$/, ''), 160); if (t.length >= 4 && !seen.has('g:' + norm(t))) { seen.add('g:' + norm(t)); out.goals.push(cand({ text: t }, { inferred: true, include: false })); } continue; }
    if (prefHit) continue;

    // recurring commitments (a weekday set + a time or a typical activity)
    const days = parseDays(line); const times = parseTimes(line);
    const hasDue = /\b(due|deadline|turn(?:ed)? in|submit|hand in)\b/i.test(line);
    if (days.length && !hasDue && RECURRING.test(line) && (times || SPORT.test(line))) {
      const sport = line.match(SPORT)?.[0] ?? 'Commitment';
      let title = clean(line.replace(RANGE, ' ').replace(AT, ' ').replace(/\b(every|each|on|at|from|weekly|daily)\b/gi, ' ').replace(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*s?\b/gi, ' ').replace(/\b(weekdays?|weekends?)\b/gi, ' ').replace(/[/,&]+/g, ' ').replace(/\b(and|to)\b/gi, ' '), 60);
      if (title.length < 3) title = titleCase(sport);
      const flags: string[] = [];
      if (!times) flags.push('No time was given, so 4:00–5:00 pm was assumed. Please check.');
      else if (times.guessed) flags.push('No am/pm was given, so the afternoon was assumed. Please check.');
      const t = times ?? { start: '16:00', end: '17:00', guessed: true };
      if (hm(t.end) <= hm(t.start)) flags.push('The end time is not after the start time.');
      out.commitments.push(cand({ title: titleCase(title), days, start: t.start, end: t.end }, { flags }));
      continue;
    }

    // dated assignments, tests and projects
    if (DUE_CUE.test(line) || (resolveDate(line, today).certainty !== 'none' && classIn(line))) {
      const due: DueInfo = resolveDate(line, today);
      if (due.certainty === 'none' && !DUE_CUE.test(line)) continue;
      const colon = line.match(/^([A-Za-z][A-Za-z0-9 .'&-]{1,30}):\s*(.+)$/);
      let className = classIn(colon?.[1] ?? '') || classIn(line);
      let body = colon && (classIn(colon[1]) || colon[1].split(' ').length <= 3) ? colon[2] : line;
      if (colon && !className && colon[1].split(' ').length <= 3) className = titleCase(colon[1].trim());
      let title = withoutDate(body, due).replace(/^(?:we have|there is|there's|i have|i've got|got)\s+(?:an?\s+|the\s+)?/i, '').replace(/\b(is|are|will be)\s*$/i, '').trim();
      title = clean(title.replace(/^[-–:,\s]+|[-–:,\s]+$/g, ''), 120);
      if (title.length < 3) continue;
      const low = line.toLowerCase();
      const type = /\b(test|quiz|exam|midterm|final)\b/.test(low) ? 'test' : /\b(project|presentation|poster|lab report|essay|paper)\b/.test(low) ? 'project' : /\b(read(?:ing)?|chapter)\b/.test(low) && !/worksheet|problem/.test(low) ? 'reading' : 'homework';
      const flags: string[] = [];
      if (due.certainty === 'uncertain' && due.reason) flags.push(due.reason);
      if (due.certainty === 'none') flags.push('No date found. It will be listed without a deadline.');
      if (className) pushClass(className, true);
      const key = 'a:' + norm(title) + '|' + (due.date ?? '');
      if (seen.has(key)) continue; seen.add(key);
      out.assignments.push(cand({ title: titleCase(title.charAt(0)) === title ? title : title.charAt(0).toUpperCase() + title.slice(1), className, type, due, estimateMin: type === 'test' ? 60 : type === 'project' ? 90 : type === 'reading' ? 30 : 40, instructions: clean(line, 400) }, { flags }));
    }
  }
  // the classes that were only seen inside assignment lines are inferred; classes the person listed are plain
  return out;
}

/** Combine two candidate sets (local rules + AI) without repeating the same thing. AI-only items are always unticked and labelled inferred. */
export function mergeCandidates(a: Candidates, b: Candidates): Candidates {
  const out: Candidates = { ...a, classes: [...a.classes], assignments: [...a.assignments], commitments: [...a.commitments], preferences: [...a.preferences], goals: [...a.goals], ignored: [...a.ignored, ...b.ignored], truncated: a.truncated || b.truncated };
  const has = (list: { item: any }[], f: (x: any) => string, v: string) => list.some((x) => f(x.item) === v);
  for (const c of b.classes) if (!has(out.classes, (x) => norm(x.name), norm(c.item.name))) out.classes.push(c);
  for (const c of b.assignments) if (!out.assignments.some((x) => norm(x.item.title) === norm(c.item.title) && (x.item.due.date ?? '') === (c.item.due.date ?? ''))) out.assignments.push(c);
  for (const c of b.commitments) if (!out.commitments.some((x) => norm(x.item.title) === norm(c.item.title) && x.item.days.join() === c.item.days.join())) out.commitments.push(c);
  for (const c of b.preferences) if (!out.preferences.some((x) => x.item.key === c.item.key)) out.preferences.push(c);
  for (const c of b.goals) if (!has(out.goals, (x) => norm(x.text), norm(c.item.text))) out.goals.push(c);
  return out;
}
export const dayNames = (days: number[]) => days.length === 7 ? 'every day' : days.length === 5 && days.join() === '1,2,3,4,5' ? 'weekdays' : days.map((d) => WEEKDAYS[d].slice(0, 3)).join(', ');
export { NO_DATE };
export type { Preferences };
