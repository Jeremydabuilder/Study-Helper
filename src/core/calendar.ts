/**
 * Pure calendar logic: normalise Google events, classify possible academic items conservatively, diff syncs.
 * Nothing here talks to Google or the database.
 */
import { createHash } from 'node:crypto';
import { DAY, addDaysKey, localDateKey } from './time';

export interface RawGoogleEvent {
  id: string; status?: string; summary?: string; description?: string; location?: string; etag?: string; updated?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string }; end?: { date?: string; dateTime?: string; timeZone?: string };
  recurringEventId?: string; transparency?: string; htmlLink?: string;
}

export interface NormalizedEvent {
  calendarId: string; eventId: string; title: string; description: string;
  allDay: boolean;
  startUtc: number | null; endUtc: number | null;           // timed events: instants
  startDate: string | null; endDate: string | null;          // all-day events: inclusive local dates (floating, zone-independent)
  tz: string; status: 'confirmed' | 'tentative' | 'cancelled';
  transparent: boolean; recurringEventId: string | null; etag: string; sourceUpdated: string; fingerprint: string;
}

export function normalizeEvent(raw: RawGoogleEvent, calendarId: string, calendarTz: string): NormalizedEvent | null {
  if (!raw.id || !raw.start) return raw.status === 'cancelled' && raw.id ? cancelledStub(raw, calendarId, calendarTz) : null;
  const allDay = !!raw.start.date && !raw.start.dateTime;
  const tz = raw.start.timeZone || calendarTz;
  const status = raw.status === 'cancelled' ? 'cancelled' : raw.status === 'tentative' ? 'tentative' : 'confirmed';
  let startUtc: number | null = null, endUtc: number | null = null, startDate: string | null = null, endDate: string | null = null;
  if (allDay) {
    startDate = raw.start.date!;
    // Google's all-day end date is exclusive
    endDate = raw.end?.date ? addDaysKey(raw.end.date, -1) : startDate;
    if (endDate < startDate) endDate = startDate;
  } else {
    startUtc = Date.parse(raw.start.dateTime!);
    endUtc = raw.end?.dateTime ? Date.parse(raw.end.dateTime) : startUtc;
    if (Number.isNaN(startUtc)) return null;
    if (Number.isNaN(endUtc as number)) endUtc = startUtc;
  }
  const title = (raw.summary ?? '').trim() || '(untitled event)';
  const description = (raw.description ?? '').slice(0, 2000);
  const fingerprint = createHash('sha1').update(JSON.stringify([title, description, allDay, startUtc, endUtc, startDate, endDate, status, raw.transparency ?? ''])).digest('hex').slice(0, 16);
  return {
    calendarId, eventId: raw.id, title, description, allDay, startUtc, endUtc, startDate, endDate, tz, status,
    transparent: raw.transparency === 'transparent', recurringEventId: raw.recurringEventId ?? null,
    etag: raw.etag ?? '', sourceUpdated: raw.updated ?? '', fingerprint,
  };
}
function cancelledStub(raw: RawGoogleEvent, calendarId: string, tz: string): NormalizedEvent {
  return {
    calendarId, eventId: raw.id, title: (raw.summary ?? '').trim() || '(cancelled event)', description: '', allDay: false, startUtc: null, endUtc: null,
    startDate: null, endDate: null, tz, status: 'cancelled', transparent: false, recurringEventId: raw.recurringEventId ?? null,
    etag: raw.etag ?? '', sourceUpdated: raw.updated ?? '', fingerprint: 'cancelled',
  };
}

/** Local calendar date the event (starts) on, in the user's zone for timed events. */
export function eventDateKey(e: Pick<NormalizedEvent, 'allDay' | 'startDate' | 'startUtc'>, userTz: string): string | null {
  if (e.allDay) return e.startDate;
  return e.startUtc === null ? null : localDateKey(new Date(e.startUtc), userTz);
}

/* ------------------------------ classification ------------------------------ */

export type AcademicType = 'homework' | 'test' | 'quiz' | 'project' | 'presentation' | 'other_deadline';
export const ACADEMIC_TYPE_LABEL: Record<AcademicType, string> = {
  homework: 'Homework', test: 'Test', quiz: 'Quiz', project: 'Project', presentation: 'Presentation', other_deadline: 'Other deadline',
};

export interface SubjectHint { id: string; name: string; aliases?: string[] }
export interface DueProposal {
  kind: 'unknown' | 'date' | 'datetime';
  date: string | null; at: number | null;
  /** Why we propose this — shown to the student, never hidden. */
  basis: string;
}
export interface Classification {
  academicType: AcademicType | null;
  confidence: 'strong' | 'weak' | null;
  reasons: string[];
  role: 'academic' | 'class' | 'activity' | 'other';
  subjectId: string | null; subjectReason: string | null;
  due: DueProposal;
  topicsText: string | null;
}

const RE = {
  test: /\b(tests?|exams?|midterms?|finals?(?!\s+(?:draft|project|paper|essay|version))|assessments?)\b/i,
  quiz: /\bquiz(?:zes)?\b/i,
  presentation: /\b(presentations?|oral|speech|present)\b/i,
  project: /\bprojects?\b/i,
  homework: /\b(hw|homework|assignments?|worksheets?|problem sets?|pset|reading|essay|draft|lab report|packet)\b/i,
  due: /\bdue\b/i,
  prep: /\b(review|prep|study|tutor(?:ing)?|office hours|help session)\b/i,
  negated: /\b(no|not|cancel+ed|optional)\s+(?:a\s+)?(?:tests?|quiz(?:zes)?|exams?)\b/i,
  activity: /\b(tennis|practice|match|tournament|training|game|clinic|rehearsal|workout|lesson|scrimmage|drills?)\b/i,
  cls: /\b(class|period|lecture|homeroom|advisory|lab|section)\b/i,
  topics: /^\s*(?:topics?|covers?|coverage|chapters?|units?|material|study guide|sections?)\s*[:\-]\s*(.+)$/im,
};

export function classifyEvent(e: NormalizedEvent, subjects: SubjectHint[], userTz: string): Classification {
  const title = e.title, desc = e.description;
  const reasons: string[] = [];
  let type: AcademicType | null = null;
  let confidence: Classification['confidence'] = null;
  const hay = `${title}`;
  const descHit = (re: RegExp) => re.test(desc);
  const prepLike = RE.prep.test(hay) && !RE.due.test(hay);

  if (RE.negated.test(hay)) reasons.push('Title says there is no test/quiz.');
  else if (prepLike) reasons.push('Looks like a review/prep session, not the assessment itself.');
  else {
    const order: [AcademicType, RegExp][] = [['test', RE.test], ['quiz', RE.quiz], ['presentation', RE.presentation], ['project', RE.project], ['homework', RE.homework]];
    for (const [t, re] of order) {
      const m = hay.match(re);
      if (m) { type = t; confidence = 'strong'; reasons.push(`Title contains “${m[0]}”.`); break; }
    }
    if (!type && RE.due.test(hay)) { type = 'other_deadline'; confidence = 'weak'; reasons.push('Title contains “due”, but not what kind of work it is.'); }
    if (!type) {
      for (const [t, re] of order) if (descHit(re) && /\b(test|quiz|due|assignment|homework|project)\b/i.test(desc)) { type = t; confidence = 'weak'; reasons.push(`Only the description mentions “${(desc.match(re) ?? [''])[0]}”.`); break; }
    }
  }

  // role
  let role: Classification['role'] = type ? 'academic' : 'other';
  if (!type) {
    if (RE.activity.test(hay)) { role = 'activity'; reasons.push('Looks like an activity (busy time).'); }
    else if (RE.cls.test(hay) || e.recurringEventId) { role = 'class'; }
  }

  // subject: only on explicit name/alias match in title (or description as weaker)
  let subjectId: string | null = null, subjectReason: string | null = null;
  const lowT = title.toLowerCase();
  for (const s of subjects) {
    for (const nm of [s.name, ...(s.aliases ?? [])]) {
      const n = nm.trim().toLowerCase();
      if (n.length >= 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lowT)) { subjectId = s.id; subjectReason = `Title mentions “${nm}”.`; break; }
    }
    if (subjectId) break;
  }

  // due proposal — never invent. Tests/quizzes/presentations: the event IS the occurrence.
  let due: DueProposal = { kind: 'unknown', date: null, at: null, basis: 'The event does not say when this is due.' };
  const key = eventDateKey(e, userTz);
  if (type && key) {
    if (type === 'test' || type === 'quiz' || type === 'presentation') {
      due = e.allDay
        ? { kind: 'date', date: key, at: null, basis: 'All-day event: date taken from the event; the time is unknown.' }
        : { kind: 'datetime', date: key, at: e.startUtc, basis: 'Taken from when the event is scheduled — confirm it is when the test/quiz happens.' };
    } else if (e.allDay) {
      due = { kind: 'date', date: key, at: null, basis: 'All-day event: assumed to be the due date (end of that day). Please confirm.' };
    } else if (RE.due.test(title)) {
      due = { kind: 'datetime', date: key, at: e.startUtc, basis: 'Title contains “due”, so the event time is proposed as the deadline. Please confirm.' };
    } else {
      due = { kind: 'unknown', date: null, at: null, basis: `The event is at ${key}, but a timed event start is not assumed to be a deadline. Set the due date yourself.` };
    }
  }

  const tm = desc.match(RE.topics);
  return { academicType: type, confidence, reasons, role, subjectId, subjectReason, due, topicsText: tm ? tm[1].trim().slice(0, 300) : null };
}

/* ------------------------------ sync diffing ------------------------------ */

export interface StoredEventLite { key: string; fingerprint: string; status: string; startUtc: number | null; startDate: string | null; missing: boolean }
export interface SyncDiff {
  added: NormalizedEvent[]; changed: { ev: NormalizedEvent; before: StoredEventLite }[];
  cancelled: NormalizedEvent[]; missing: StoredEventLite[]; unchanged: number; duplicatesInBatch: number;
}
export const eventKey = (calendarId: string, eventId: string) => `${calendarId}::${eventId}`;

export function diffEvents(stored: StoredEventLite[], incoming: NormalizedEvent[], window: { from: number; to: number }, userTz: string): SyncDiff {
  const byKey = new Map(stored.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const out: SyncDiff = { added: [], changed: [], cancelled: [], missing: [], unchanged: 0, duplicatesInBatch: 0 };
  for (const ev of incoming) {
    const k = eventKey(ev.calendarId, ev.eventId);
    if (seen.has(k)) { out.duplicatesInBatch++; continue; } // same event returned twice (paging overlap): import once
    seen.add(k);
    const before = byKey.get(k);
    if (ev.status === 'cancelled') { if (before && before.status !== 'cancelled') out.cancelled.push(ev); continue; }
    if (!before) out.added.push(ev);
    else if (before.status === 'cancelled' || before.missing || before.fingerprint !== ev.fingerprint) out.changed.push({ ev, before });
    else out.unchanged++;
  }
  for (const s of stored) {
    if (seen.has(s.key) || s.status === 'cancelled' || s.missing) continue;
    const t = s.startUtc ?? (s.startDate ? Date.parse(s.startDate + 'T12:00:00Z') : null);
    if (t !== null && t >= window.from && t < window.to) out.missing.push(s);
  }
  return out;
}

export function describeChange(before: { title: string; startUtc: number | null; startDate: string | null; allDay: boolean }, after: NormalizedEvent, userTz: string): string[] {
  const out: string[] = [];
  if (before.title !== after.title) out.push(`title “${before.title}” → “${after.title}”`);
  const b = before.allDay ? before.startDate : before.startUtc === null ? null : new Date(before.startUtc).toISOString();
  const a = after.allDay ? after.startDate : after.startUtc === null ? null : new Date(after.startUtc).toISOString();
  if (b !== a) out.push(`${after.allDay ? 'date' : 'time'} ${fmtWhen(before, userTz)} → ${fmtWhen(after, userTz)}`);
  return out.length ? out : ['details changed'];
}
export function fmtWhen(e: { allDay: boolean; startDate: string | null; startUtc: number | null }, tz: string): string {
  if (e.allDay) return `${e.startDate} (all day)`;
  if (e.startUtc === null) return 'unknown';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(e.startUtc));
}
export { DAY };
