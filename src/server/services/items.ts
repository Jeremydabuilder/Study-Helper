import { ACADEMIC_TYPE_LABEL, AcademicType, fmtWhen } from '../../core/calendar';
import { Demand, buildSchedule, BusyInterval, demandWindow } from '../../core/schedule';
import { DAY, MIN, addDaysKey, dayBounds, diffDaysKeys, localDateKey, zonedToUtc } from '../../core/time';
import { uid } from '../db';
import { Ctx, HttpError, clip, getAvailability, getProfile, parse } from './common';

const TYPES = Object.keys(ACADEMIC_TYPE_LABEL) as AcademicType[];
const EDITABLE = ['title', 'type', 'subjectId', 'due', 'topicsText', 'conceptIds', 'format', 'estimateMin', 'notes'] as const;

export interface ItemInput {
  title?: string; type?: string; subjectId?: string | null; dueDate?: string | null; dueTime?: string | null; topicsText?: string | null;
  conceptIds?: string[]; format?: string; estimateMin?: number | null; notes?: string;
}

function dueFields(ctx: Ctx, b: ItemInput): { due_kind: string; due_date: string | null; due_at: number | null } {
  if (!b.dueDate) return { due_kind: 'unknown', due_date: null, due_at: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate)) throw new HttpError(400, 'invalid', 'Dates must look like 2026-11-05.');
  if (b.dueTime) {
    if (!/^\d{2}:\d{2}$/.test(b.dueTime)) throw new HttpError(400, 'invalid', 'Times must look like 15:30.');
    return { due_kind: 'datetime', due_date: b.dueDate, due_at: zonedToUtc(b.dueDate, b.dueTime, getProfile(ctx.db).timezone).getTime() };
  }
  return { due_kind: 'date', due_date: b.dueDate, due_at: null };
}

function setConcepts(ctx: Ctx, itemId: string, ids: string[] | undefined) {
  if (!ids) return;
  ctx.db.run('DELETE FROM academic_item_concepts WHERE item_id=?', itemId);
  for (const c of ids) if (ctx.db.get('SELECT 1 FROM concepts WHERE id=?', c)) ctx.db.run('INSERT OR IGNORE INTO academic_item_concepts (item_id, concept_id) VALUES (?,?)', itemId, c);
}

export function createItem(ctx: Ctx, b: ItemInput) {
  const title = clip(b.title, 120).trim();
  if (!title) throw new HttpError(400, 'invalid', 'Give it a title.');
  if (!TYPES.includes(b.type as AcademicType)) throw new HttpError(400, 'invalid', 'Choose what kind of item this is.');
  const id = uid(), now = ctx.now();
  const d = dueFields(ctx, b);
  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO academic_items (id,subject_id,type,title,due_kind,due_date,due_at,topics_text,format,notes,status,source,estimate_min,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, b.subjectId ?? null, b.type, title, d.due_kind, d.due_date, d.due_at, b.topicsText ? clip(b.topicsText, 400) : null, clip(b.format, 200), clip(b.notes, 500), 'confirmed', 'manual', b.estimateMin ?? null, now, now);
    setConcepts(ctx, id, b.conceptIds);
  });
  return { id };
}

export function updateItem(ctx: Ctx, id: string, b: ItemInput) {
  const it = ctx.db.get<any>('SELECT * FROM academic_items WHERE id=?', id);
  if (!it) throw new HttpError(404, 'not_found', 'Item not found.');
  if (b.type !== undefined && !TYPES.includes(b.type as AcademicType)) throw new HttpError(400, 'invalid', 'Unknown type.');
  const edited = new Set<string>(parse<string[]>(it.user_edited, []));
  const d = b.dueDate !== undefined ? dueFields(ctx, b) : { due_kind: it.due_kind, due_date: it.due_date, due_at: it.due_at };
  if (b.dueDate !== undefined) edited.add('due');
  for (const k of ['title', 'type', 'subjectId', 'topicsText', 'conceptIds', 'format', 'estimateMin', 'notes'] as const) if (b[k] !== undefined) edited.add(k);
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE academic_items SET title=?, type=?, subject_id=?, due_kind=?, due_date=?, due_at=?, topics_text=?, format=?, notes=?, estimate_min=?, user_edited=?, updated_at=? WHERE id=?`,
      b.title !== undefined ? clip(b.title, 120).trim() || it.title : it.title, b.type ?? it.type, b.subjectId === undefined ? it.subject_id : b.subjectId, d.due_kind, d.due_date, d.due_at,
      b.topicsText === undefined ? it.topics_text : b.topicsText ? clip(b.topicsText, 400) : null, b.format === undefined ? it.format : clip(b.format, 200), b.notes === undefined ? it.notes : clip(b.notes, 500),
      b.estimateMin === undefined ? it.estimate_min : b.estimateMin, JSON.stringify([...edited]), ctx.now(), id);
    setConcepts(ctx, id, b.conceptIds);
  });
}

/** Homework completion is the student's own statement. A calendar date passing never marks anything done, and completion never changes mastery. */
export function setCompleted(ctx: Ctx, id: string, done: boolean) {
  ctx.db.run('UPDATE academic_items SET completed_at=?, updated_at=? WHERE id=?', done ? ctx.now() : null, ctx.now(), id);
}
export function logWork(ctx: Ctx, id: string, minutes: number) {
  const m = Math.max(0, Math.min(600, Math.round(minutes)));
  ctx.db.run('UPDATE academic_items SET done_min = MIN(done_min + ?, 6000), updated_at=? WHERE id=?', m, ctx.now(), id);
}
export function deleteItem(ctx: Ctx, id: string) { ctx.db.run('DELETE FROM academic_items WHERE id=?', id); }

/* ------------------------------ proposals ------------------------------ */

export function confirmProposal(ctx: Ctx, id: string, edits: ItemInput = {}) {
  const it = ctx.db.get<any>("SELECT * FROM academic_items WHERE id=? AND status='proposed'", id);
  if (!it) throw new HttpError(404, 'not_found', 'Proposal not found (it may already be confirmed).');
  updateItem(ctx, id, edits);
  ctx.db.run("UPDATE academic_items SET status='confirmed', updated_at=? WHERE id=?", ctx.now(), id);
}
export function dismissProposal(ctx: Ctx, id: string) {
  ctx.db.run("UPDATE academic_items SET status='dismissed', updated_at=? WHERE id=? AND status='proposed'", ctx.now(), id);
}
export const pendingProposalCount = (ctx: Ctx) => ctx.db.get<any>("SELECT COUNT(*) n FROM academic_items WHERE status='proposed'").n as number;

/* ------------------------------ serialisation ------------------------------ */

function dueLabel(ctx: Ctx, it: any): string {
  const tz = getProfile(ctx.db).timezone;
  if (it.due_kind === 'date') return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${it.due_date}T12:00:00Z`)) + ' · date only';
  if (it.due_kind === 'datetime') return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(it.due_at));
  return 'No due date set';
}
const dueKeyOf = (ctx: Ctx, it: any): string | null => it.due_kind === 'date' ? it.due_date : it.due_kind === 'datetime' ? localDateKey(new Date(it.due_at), getProfile(ctx.db).timezone) : null;

export function serializeItem(ctx: Ctx, it: any) {
  const tz = getProfile(ctx.db).timezone;
  const today = localDateKey(new Date(ctx.now()), tz);
  const key = dueKeyOf(ctx, it);
  const concepts = ctx.db.all<any>('SELECT c.id, c.name FROM academic_item_concepts l JOIN concepts c ON c.id=l.concept_id WHERE l.item_id=?', it.id);
  const ev = it.event_key ? ctx.db.get<any>('SELECT e.*, c.name AS calendar_name FROM cal_events e JOIN cal_calendars c ON c.id=e.calendar_id WHERE e.key=?', it.event_key) : null;
  const proposal = parse<any>(it.proposal, null);
  const unknown: string[] = [];
  if (it.due_kind === 'unknown') unknown.push('due date');
  if (['test', 'quiz', 'presentation'].includes(it.type) && !concepts.length && !it.topics_text) unknown.push('topics covered');
  if (!it.subject_id) unknown.push('subject');
  if (it.estimate_min == null) unknown.push('time needed');
  return {
    id: it.id, title: it.title, type: it.type, typeLabel: ACADEMIC_TYPE_LABEL[it.type as AcademicType], status: it.status, source: it.source,
    subjectId: it.subject_id, subjectName: it.subject_id ? ctx.db.get<any>('SELECT name FROM subjects WHERE id=?', it.subject_id)?.name ?? null : null,
    dueKind: it.due_kind, dueDate: it.due_kind === 'datetime' ? key : it.due_date, // timed deadlines are instants: show the date in the student's current zone
    dueTime: it.due_kind === 'datetime' ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(it.due_at)) : null,
    dueLabel: dueLabel(ctx, it), dueKey: key, daysLeft: key ? diffDaysKeys(today, key) : null,
    topicsText: it.topics_text, conceptIds: concepts.map((c) => c.id), concepts, format: it.format, notes: it.notes, estimateMin: it.estimate_min, doneMin: it.done_min,
    completed: !!it.completed_at, syncState: it.sync_state, syncNote: it.sync_note, unknown,
    event: ev ? { title: ev.title, description: ev.description, calendarName: ev.calendar_name, whenLabel: fmtWhen({ allDay: !!ev.all_day, startDate: ev.start_date, startUtc: ev.start_utc }, tz), allDay: !!ev.all_day, recurring: !!ev.recurring_event_id, recurringId: ev.recurring_event_id, status: ev.status } : null,
    proposal: proposal ? { reasons: proposal.reasons ?? [], dueBasis: proposal.due?.basis ?? null, subjectReason: proposal.subjectReason ?? null, confidence: proposal.confidence ?? null, topicsFromEvent: proposal.topicsText ?? null, possibleDuplicateOf: proposal.possibleDuplicateOf ?? null } : null,
  };
}

export function listItems(ctx: Ctx, status: 'proposed' | 'confirmed' | 'dismissed') {
  return ctx.db.all<any>('SELECT * FROM academic_items WHERE status=? ORDER BY COALESCE(due_date, substr(datetime(due_at/1000,\'unixepoch\'),1,10), \'9999\'), created_at', status).map((i) => serializeItem(ctx, i));
}

export function upcomingItems(ctx: Ctx, days: number) {
  const tz = getProfile(ctx.db).timezone, today = localDateKey(new Date(ctx.now()), tz);
  return listItems(ctx, 'confirmed')
    .filter((i) => !i.completed && i.syncState !== 'source_cancelled' && (i.daysLeft === null || (i.daysLeft >= 0 && i.daysLeft <= days)))
    .sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999))
    .map((i) => ({ id: i.id, title: i.title, type: i.type, typeLabel: i.typeLabel, subjectName: i.subjectName, dueLabel: i.dueLabel, dueKey: i.dueKey, daysLeft: i.daysLeft, topicsKnown: i.conceptIds.length > 0, conceptCount: i.conceptIds.length, syncState: i.syncState, estimateMin: i.estimateMin, doneMin: i.doneMin, today }));
}

export function attentionList(ctx: Ctx) {
  const out: { itemId: string; kind: string; message: string; title: string }[] = [];
  for (const i of listItems(ctx, 'confirmed')) {
    if (i.completed) continue;
    if (i.syncState === 'source_cancelled') out.push({ itemId: i.id, kind: 'cancelled', title: i.title, message: `The calendar event for “${i.title}” was cancelled. It is paused in your plan — keep it as a manual item or remove it.` });
    else if (i.syncState === 'source_changed') out.push({ itemId: i.id, kind: 'changed', title: i.title, message: i.syncNote || 'The calendar event changed.' });
    else if (i.syncState === 'source_missing') out.push({ itemId: i.id, kind: 'missing', title: i.title, message: `“${i.title}” is no longer found in your calendar (deleted, moved far away, or the calendar was unshared).` });
    if (i.dueKind === 'unknown') out.push({ itemId: i.id, kind: 'no_due', title: i.title, message: `“${i.title}” has no due date, so I cannot schedule it. Set one when you know it.` });
    else if (['test', 'quiz', 'presentation'].includes(i.type) && !i.conceptIds.length) out.push({ itemId: i.id, kind: 'no_topics', title: i.title, message: `What “${i.title}” covers is unknown. Tell me the topics so I can plan — I will not guess.` });
  }
  return out;
}

/* ------------------------------ schedule ------------------------------ */

export function busyIntervals(ctx: Ctx, from: number, to: number, tz: string): BusyInterval[] {
  const rows = ctx.db.all<any>(`SELECT e.*, c.all_day_busy FROM cal_events e JOIN cal_calendars c ON c.id=e.calendar_id
    WHERE c.selected=1 AND c.counts_busy=1 AND e.status != 'cancelled' AND e.missing=0 AND e.transparent=0`);
  const out: BusyInterval[] = [];
  for (const e of rows) {
    if (e.all_day) {
      if (!e.all_day_busy) continue;
      const s = dayBounds(e.start_date, tz).start.getTime(), en = dayBounds(addDaysKey(e.end_date ?? e.start_date, 0), tz).end.getTime();
      if (en > from && s < to) out.push({ start: s, end: en, label: e.title });
    } else if (e.start_utc !== null && e.end_utc > from && e.start_utc < to) out.push({ start: e.start_utc, end: Math.max(e.end_utc, e.start_utc + 15 * MIN), label: e.title });
  }
  return out;
}

export function demandsFromItems(ctx: Ctx): Demand[] {
  const tz = getProfile(ctx.db).timezone, s = getAvailability(ctx.db);
  const today = localDateKey(new Date(ctx.now()), tz);
  const out: Demand[] = [];
  for (const it of listItems(ctx, 'confirmed')) {
    if (it.completed || it.syncState === 'source_cancelled' || !it.dueKey || it.dueKey < today) continue;
    const prep = ['test', 'quiz', 'presentation'].includes(it.type);
    const kind: Demand['kind'] = prep ? 'test_prep' : it.type === 'project' ? 'project' : 'homework';
    const total = it.estimateMin ?? (prep ? (it.type === 'quiz' ? Math.round(s.defaultTestPrepMin / 2) : s.defaultTestPrepMin) : kind === 'project' ? s.defaultHomeworkMin * 3 : s.defaultHomeworkMin);
    let { lastDay } = demandWindow(kind, it.dueKey, s);
    if (lastDay < today) lastDay = today; // due very soon: still try today
    const firstDay = prep ? addDaysKey(it.dueKey, -s.testPrepDays) : kind === 'project' ? addDaysKey(it.dueKey, -14) : undefined;
    out.push({ itemId: it.id, title: it.title, kind, totalMin: total, doneMin: kind === 'test_prep' ? 0 : it.doneMin, firstDay, lastDay, subjectId: it.subjectId, conceptIds: it.conceptIds, estimateSource: it.estimateMin == null ? 'default' : 'user' });
  }
  return out;
}

export function computeSchedule(ctx: Ctx) {
  const now = ctx.now(), tz = getProfile(ctx.db).timezone, s = getAvailability(ctx.db);
  const horizon = 21;
  const busy = busyIntervals(ctx, now - DAY, now + (horizon + 1) * DAY, tz);
  const today = localDateKey(new Date(now), tz);
  const studied = Math.round(ctx.db.get<any>('SELECT COALESCE(SUM(MIN(response_ms,600000)),0) ms FROM attempts WHERE created_at >= ?', dayBounds(today, tz).start.getTime()).ms / 60000);
  const r = buildSchedule({ now, tz, settings: s, busy, demands: demandsFromItems(ctx), horizonDays: horizon, studiedTodayMin: studied });
  const todayCap = r.days[0];
  const winMin = todayCap ? todayCap.windows.reduce((t, w) => t + Math.floor((w.end - w.start) / MIN), 0) : 0;
  const freeMinutesToday = Math.max(0, Math.min(winMin, (todayCap?.capMin ?? 0) - studied));
  const changes = ctx.db.all<any>('SELECT id, at, kind, title, detail FROM cal_changes WHERE seen=0 ORDER BY at DESC LIMIT 10');
  const titleOf = new Map(listItems(ctx, 'confirmed').map((i) => [i.id, i]));
  return {
    blocks: r.blocks.map((b) => ({ ...b, startLabel: new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(b.start)), itemType: titleOf.get(b.itemId)?.type ?? null })),
    shortfalls: r.shortfalls, days: r.days.map((d) => ({ dateKey: d.dateKey, capMin: d.capMin, busyMin: d.busyMin, heavy: d.heavy, why: d.why, freeWindows: d.windows.length })), freeMinutesToday, changes,
  };
}
export const markChangesSeen = (ctx: Ctx) => ctx.db.run('UPDATE cal_changes SET seen=1');
void DAY;
