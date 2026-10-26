import { classifyEvent, describeChange, diffEvents, eventKey, normalizeEvent, NormalizedEvent, StoredEventLite } from '../../core/calendar';
import { DAY, localDateKey } from '../../core/time';
import { decryptJson, encryptJson, randomToken, sha256b64url } from '../crypto';
import { uid } from '../db';
import { Ctx, HttpError, getProfile, parse } from './common';
import { CalendarError, FRIENDLY, READONLY_SCOPE, TokenSet } from './calendarGoogle';

export const LIMITATION_NOTE = 'Google Calendar only contains what is on your calendars. Assignments that exist only in Google Classroom or your school’s portal do NOT appear here — add those by hand (Add item). Nothing is read from Classroom.';
const SYNC_PAST_DAYS = 2, SYNC_FUTURE_DAYS = 60;

/* ---- OAuth state (short-lived, in memory; the verifier never leaves the server) ---- */
const pending = new Map<string, { verifier: string; workspace: string; at: number }>();

function secret(ctx: Ctx): string {
  if (ctx.calendar.kind === 'memory') return 'demo-memory-gateway-secret'; // demo/test gateway holds no real credentials
  if (!ctx.cfg.appSecret || ctx.cfg.appSecret.length < 16) throw new CalendarError('not_configured', FRIENDLY.not_configured);
  return ctx.cfg.appSecret;
}
function loadTokens(ctx: Ctx): TokenSet | null {
  const r = ctx.db.get<any>('SELECT token_enc FROM cal_connection WHERE id=1');
  if (!r?.token_enc) return null;
  try { return decryptJson<TokenSet>(r.token_enc, secret(ctx)); } catch { return null; }
}
const saveTokens = (ctx: Ctx, t: TokenSet) => ctx.db.run('UPDATE cal_connection SET token_enc=? WHERE id=1', encryptJson(t, secret(ctx)));

export function startConnect(ctx: Ctx) {
  if (!ctx.calendar.configured()) throw new CalendarError('not_configured', FRIENDLY.not_configured);
  if (ctx.calendar.kind === 'google') secret(ctx);
  const state = randomToken(24), verifier = randomToken(48);
  for (const [k, v] of pending) if (ctx.now() - v.at > 10 * 60_000) pending.delete(k);
  pending.set(state, { verifier, workspace: ctx.workspace, at: ctx.now() });
  return { url: ctx.calendar.authUrl(state, sha256b64url(verifier)), state };
}

export function consumeState(state: string): { verifier: string; workspace: string } | null {
  const p = pending.get(state); pending.delete(state);
  return p ? { verifier: p.verifier, workspace: p.workspace } : null;
}

export async function finishConnect(ctx: Ctx, code: string, verifier: string) {
  const tokens = await ctx.calendar.exchangeCode(code, verifier);
  if (!tokens.scope.includes(READONLY_SCOPE)) throw new CalendarError('denied', FRIENDLY.denied);
  const { calendars, tokens: t2 } = await ctx.calendar.listCalendars(tokens);
  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO cal_connection (id,provider,status,account_email,scope,token_enc,connected_at,is_demo) VALUES (1,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, status='connected', account_email=excluded.account_email, scope=excluded.scope, token_enc=excluded.token_enc, connected_at=excluded.connected_at, last_error=NULL, is_demo=excluded.is_demo`,
      ctx.calendar.kind, 'connected', calendars.find((c) => c.primary)?.id ?? null, READONLY_SCOPE, encryptJson(t2, secret(ctx)), ctx.now(), Number(ctx.calendar.kind === 'memory'));
    for (const c of calendars) ctx.db.run(`INSERT INTO cal_calendars (id,name,tz,color) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, tz=excluded.tz, color=excluded.color`, c.id, c.name, c.tz, c.color);
  });
  return { calendars: calendars.length };
}

/** In demo/memory mode the OAuth round trip is skipped. */
export async function connectMemory(ctx: Ctx) {
  if (ctx.calendar.kind !== 'memory') throw new HttpError(400, 'invalid', 'Not a demo calendar.');
  return finishConnect(ctx, 'demo', 'demo');
}

export function connectionStatus(ctx: Ctx) {
  const c = ctx.db.get<any>('SELECT * FROM cal_connection WHERE id=1');
  const calendars = ctx.db.all<any>('SELECT * FROM cal_calendars ORDER BY name').map((r) => ({
    id: r.id, name: r.name, tz: r.tz, color: r.color, selected: !!r.selected, detectAcademic: !!r.detect_academic, countsBusy: !!r.counts_busy, allDayBusy: !!r.all_day_busy, label: r.label, lastSyncedAt: r.last_synced_at,
    eventCount: ctx.db.get<any>("SELECT COUNT(*) n FROM cal_events WHERE calendar_id=? AND status != 'cancelled'", r.id).n,
  }));
  return {
    kind: ctx.calendar.kind, available: ctx.calendar.configured(),
    status: (c?.status ?? 'disconnected') as string, accountEmail: c?.account_email ?? null, lastSyncAt: c?.last_sync_at ?? null, lastSyncOkAt: c?.last_sync_ok_at ?? null, lastError: c?.last_error ?? null,
    demo: ctx.calendar.kind === 'memory', scope: c?.scope ?? READONLY_SCOPE, calendars, limitation: LIMITATION_NOTE,
    setupHint: ctx.calendar.configured() ? null : FRIENDLY.not_configured,
    permissions: 'Read-only: view events on calendars you pick. The app cannot create, edit or delete anything in Google Calendar.',
  };
}

export function setCalendars(ctx: Ctx, list: { id: string; selected?: boolean; label?: string; detectAcademic?: boolean; countsBusy?: boolean; allDayBusy?: boolean }[]) {
  const labels = ['school', 'homework', 'tests', 'activity', 'other'];
  ctx.db.tx(() => {
    for (const c of list) {
      const row = ctx.db.get<any>('SELECT * FROM cal_calendars WHERE id=?', c.id);
      if (!row) continue;
      const label = c.label && labels.includes(c.label) ? c.label : row.label;
      // sensible defaults per label; the student can still override each switch
      const defaults = ({ school: [1, 1], homework: [1, 0], tests: [1, 0], activity: [0, 1], other: [0, 0] } as Record<string, [number, number]>)[label];
      const changedLabel = c.label !== undefined && c.label !== row.label;
      ctx.db.run('UPDATE cal_calendars SET selected=?, label=?, detect_academic=?, counts_busy=?, all_day_busy=? WHERE id=?',
        c.selected === undefined ? row.selected : Number(c.selected), label,
        c.detectAcademic !== undefined ? Number(c.detectAcademic) : changedLabel ? defaults[0] : row.detect_academic,
        c.countsBusy !== undefined ? Number(c.countsBusy) : changedLabel ? defaults[1] : row.counts_busy,
        c.allDayBusy === undefined ? row.all_day_busy : Number(c.allDayBusy), c.id);
    }
  });
}

/* ---- sync ---- */

export interface SyncReport { calendars: number; added: number; changed: number; cancelled: number; missing: number; proposed: number; unchanged: number; at: number }

export async function syncNow(ctx: Ctx): Promise<SyncReport> {
  const conn = ctx.db.get<any>('SELECT * FROM cal_connection WHERE id=1');
  if (!conn || conn.status === 'disconnected') throw new HttpError(409, 'not_connected', 'Connect Google Calendar first.');
  let tokens = loadTokens(ctx);
  if (!tokens) { markStatus(ctx, 'reauth_required', FRIENDLY.reauth_required); throw new CalendarError('reauth_required', FRIENDLY.reauth_required); }
  const now = ctx.now();
  const rep: SyncReport = { calendars: 0, added: 0, changed: 0, cancelled: 0, missing: 0, proposed: 0, unchanged: 0, at: now };
  const cals = ctx.db.all<any>('SELECT * FROM cal_calendars WHERE selected=1');
  const tz = getProfile(ctx.db).timezone;
  const subjects = ctx.db.all<any>('SELECT id, name, aliases FROM subjects WHERE archived=0').map((s) => ({ id: s.id, name: s.name, aliases: parse<string[]>(s.aliases, []) }));
  const window = { from: now - SYNC_PAST_DAYS * DAY, to: now + SYNC_FUTURE_DAYS * DAY };
  try {
    for (const cal of cals) {
      const r = await ctx.calendar.listEvents(tokens, cal.id, window.from, window.to);
      tokens = r.tokens;
      const incoming = r.events.map((e) => normalizeEvent(e, cal.id, cal.tz)).filter((e): e is NormalizedEvent => !!e);
      applyDiff(ctx, cal, incoming, window, tz, subjects, rep);
      ctx.db.run('UPDATE cal_calendars SET last_synced_at=? WHERE id=?', now, cal.id);
      rep.calendars++;
    }
    saveTokens(ctx, tokens!); // persist refreshed tokens
    ctx.db.run("UPDATE cal_connection SET status='connected', last_sync_at=?, last_sync_ok_at=?, last_error=NULL WHERE id=1", now, now);
  } catch (e) {
    if (e instanceof CalendarError) {
      markStatus(ctx, e.code === 'reauth_required' ? 'reauth_required' : 'error', e.message);
      ctx.db.run('UPDATE cal_connection SET last_sync_at=? WHERE id=1', now);
    }
    throw e;
  }
  return rep;
}
const markStatus = (ctx: Ctx, status: string, msg: string) => ctx.db.run('UPDATE cal_connection SET status=?, last_error=? WHERE id=1', status, msg);

function insertEvent(ctx: Ctx, e: NormalizedEvent, missing = 0) {
  const now = ctx.now(), key = eventKey(e.calendarId, e.eventId);
  ctx.db.run(`INSERT INTO cal_events (key,calendar_id,event_id,title,description,all_day,start_utc,end_utc,start_date,end_date,tz,status,transparent,recurring_event_id,etag,source_updated,fingerprint,missing,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET title=excluded.title, description=excluded.description, all_day=excluded.all_day, start_utc=excluded.start_utc, end_utc=excluded.end_utc, start_date=excluded.start_date, end_date=excluded.end_date,
      tz=excluded.tz, status=excluded.status, transparent=excluded.transparent, recurring_event_id=excluded.recurring_event_id, etag=excluded.etag, source_updated=excluded.source_updated, fingerprint=excluded.fingerprint, missing=excluded.missing, last_seen_at=excluded.last_seen_at`,
    key, e.calendarId, e.eventId, e.title, e.description, Number(e.allDay), e.startUtc, e.endUtc, e.startDate, e.endDate, e.tz, e.status, Number(e.transparent), e.recurringEventId, e.etag, e.sourceUpdated, e.fingerprint, missing, now, now);
}

const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function applyDiff(ctx: Ctx, cal: any, incoming: NormalizedEvent[], window: { from: number; to: number }, tz: string, subjects: any[], rep: SyncReport) {
  const stored = ctx.db.all<any>('SELECT key, fingerprint, status, start_utc, start_date, missing FROM cal_events WHERE calendar_id=?', cal.id)
    .map((r): StoredEventLite => ({ key: r.key, fingerprint: r.fingerprint, status: r.status, startUtc: r.start_utc, startDate: r.start_date, missing: !!r.missing }));
  const diff = diffEvents(stored, incoming, window, tz);
  const now = ctx.now();
  const note = (kind: string, key: string, title: string, detail = '') => ctx.db.run('INSERT INTO cal_changes (at,kind,event_key,title,detail,seen) VALUES (?,?,?,?,?,0)', now, kind, key, title, detail);
  ctx.db.tx(() => {
    for (const e of diff.added) {
      insertEvent(ctx, e);
      rep.added++;
      if (cal.detect_academic && e.status !== 'cancelled') { if (proposeItem(ctx, e, subjects, tz)) { rep.proposed++; note('added', eventKey(e.calendarId, e.eventId), e.title, 'New possible academic item to confirm'); } }
    }
    for (const { ev, before } of diff.changed) {
      const key = eventKey(ev.calendarId, ev.eventId);
      const old = ctx.db.get<any>('SELECT title, start_utc, start_date, all_day FROM cal_events WHERE key=?', key);
      insertEvent(ctx, ev);
      rep.changed++;
      const what = describeChange({ title: old.title, startUtc: old.start_utc, startDate: old.start_date, allDay: !!old.all_day }, ev, tz).join('; ');
      const item = ctx.db.get<any>('SELECT * FROM academic_items WHERE event_key=?', key);
      if (item) { updateItemFromEvent(ctx, item, ev, subjects, tz, what); note('changed', key, ev.title, what); }
      else if (cal.detect_academic && ev.status !== 'cancelled') { if (proposeItem(ctx, ev, subjects, tz)) rep.proposed++; }
    }
    for (const ev of diff.cancelled) {
      const key = eventKey(ev.calendarId, ev.eventId);
      ctx.db.run("UPDATE cal_events SET status='cancelled', last_seen_at=? WHERE key=?", now, key);
      rep.cancelled++;
      const item = ctx.db.get<any>('SELECT * FROM academic_items WHERE event_key=?', key);
      if (item) {
        if (item.status === 'proposed') ctx.db.run("UPDATE academic_items SET status='dismissed', sync_note='Calendar event was cancelled.', updated_at=? WHERE id=?", now, item.id);
        else if (item.status === 'confirmed') ctx.db.run("UPDATE academic_items SET sync_state='source_cancelled', sync_note='The calendar event was cancelled.', updated_at=? WHERE id=?", now, item.id);
        note('cancelled', key, item.title, 'Event cancelled in Google Calendar');
      }
    }
    for (const m of diff.missing) {
      ctx.db.run('UPDATE cal_events SET missing=1 WHERE key=?', m.key);
      rep.missing++;
      const item = ctx.db.get<any>("SELECT * FROM academic_items WHERE event_key=? AND status='confirmed'", m.key);
      if (item) { ctx.db.run("UPDATE academic_items SET sync_state='source_missing', sync_note='No longer found in the synced calendar window.', updated_at=? WHERE id=?", now, item.id); note('missing', m.key, item.title, 'Not found in latest sync'); }
    }
    rep.unchanged += diff.unchanged;
    if (diff.unchanged) ctx.db.run('UPDATE cal_events SET last_seen_at=? WHERE calendar_id=? AND missing=0', now, cal.id);
  });
}

/** Create a *proposed* item. Never auto-confirmed; unknown details stay unknown. Returns false if skipped/duplicate. */
function proposeItem(ctx: Ctx, e: NormalizedEvent, subjects: any[], tz: string): boolean {
  const key = eventKey(e.calendarId, e.eventId);
  const c = classifyEvent(e, subjects, tz);
  if (!c.academicType) return false;
  const end = e.allDay ? Date.parse(`${e.endDate}T23:59:59Z`) : e.endUtc ?? e.startUtc ?? 0;
  if (end < ctx.now() - DAY) return false; // old history is not worth asking about
  if (ctx.db.get('SELECT 1 FROM academic_items WHERE event_key=?', key)) return false; // already known (confirmed, dismissed or proposed)
  const dupe = ctx.db.get<any>(`SELECT id FROM academic_items WHERE status != 'dismissed' AND due_date IS ? AND lower(title) = lower(?) LIMIT 1`, c.due.date, e.title);
  const id = uid(), now = ctx.now();
  ctx.db.run(`INSERT OR IGNORE INTO academic_items (id,subject_id,type,title,due_kind,due_date,due_at,topics_text,status,source,event_key,proposal,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, c.subjectId, c.academicType, e.title, c.due.kind, c.due.date, c.due.at, c.topicsText, 'proposed', 'calendar', key,
    JSON.stringify({ reasons: c.reasons, due: c.due, subjectReason: c.subjectReason, confidence: c.confidence, topicsText: c.topicsText, possibleDuplicateOf: dupe?.id ?? null }), now, now);
  return true;
}

function updateItemFromEvent(ctx: Ctx, item: any, ev: NormalizedEvent, subjects: any[], tz: string, what: string) {
  const now = ctx.now();
  const edited = new Set<string>(parse<string[]>(item.user_edited, []));
  const c = classifyEvent(ev, subjects, tz);
  const proposal = JSON.stringify({ ...(parse<any>(item.proposal, {}) ?? {}), reasons: c.reasons, due: c.due, topicsText: c.topicsText });
  if (item.status === 'proposed') {
    ctx.db.run('UPDATE academic_items SET title=?, due_kind=?, due_date=?, due_at=?, proposal=?, sync_state=\'ok\', updated_at=? WHERE id=?', ev.title, c.due.kind, c.due.date, c.due.at, proposal, now, item.id);
    return;
  }
  if (item.status !== 'confirmed') return;
  // Confirmed: never overwrite what the student edited. Event-derived date moves are applied (and announced) only if the student hasn't set it themselves.
  const dueChanged = !edited.has('due') && (c.due.date !== item.due_date || c.due.at !== item.due_at) && c.due.kind !== 'unknown';
  ctx.db.run(`UPDATE academic_items SET title=?, due_kind=?, due_date=?, due_at=?, proposal=?, sync_state='source_changed', sync_note=?, updated_at=? WHERE id=?`,
    edited.has('title') ? item.title : ev.title, dueChanged ? c.due.kind : item.due_kind, dueChanged ? c.due.date : item.due_date, dueChanged ? c.due.at : item.due_at, proposal,
    `Calendar event changed: ${what}.${dueChanged ? ' Your plan was updated to match.' : edited.has('due') ? ' Your own due date was kept — check it still matches.' : ''}`, now, item.id);
}

export function acknowledgeSync(ctx: Ctx, itemId: string, action: 'accept' | 'keep_manual' | 'remove') {
  const it = ctx.db.get<any>('SELECT * FROM academic_items WHERE id=?', itemId);
  if (!it) throw new HttpError(404, 'not_found', 'Item not found.');
  if (action === 'remove') ctx.db.run('DELETE FROM academic_items WHERE id=?', itemId);
  else if (action === 'keep_manual') ctx.db.run("UPDATE academic_items SET source='manual', event_key=NULL, sync_state='ok', sync_note='', updated_at=? WHERE id=?", ctx.now(), itemId);
  else ctx.db.run("UPDATE academic_items SET sync_state='ok', sync_note='', updated_at=? WHERE id=?", ctx.now(), itemId);
}

export function disconnect(ctx: Ctx, o: { deleteImported: boolean; keepItems: boolean }) {
  const tokens = loadTokens(ctx);
  ctx.db.tx(() => {
    ctx.db.run("UPDATE cal_connection SET status='disconnected', token_enc=NULL, last_error=NULL WHERE id=1");
    if (o.deleteImported) {
      if (o.keepItems) ctx.db.run("UPDATE academic_items SET source='manual', event_key=NULL, sync_state='ok', sync_note='' WHERE event_key IS NOT NULL AND status='confirmed'");
      ctx.db.run("DELETE FROM academic_items WHERE source='calendar' AND (event_key IS NOT NULL)");
      ctx.db.run('DELETE FROM cal_changes');
      ctx.db.run('DELETE FROM cal_events');
      ctx.db.run('DELETE FROM cal_calendars');
      ctx.db.run('DELETE FROM cal_connection');
    }
  });
  return { revoked: !!tokens, deleted: o.deleteImported };
}

export const pendingEventsForUi = (ctx: Ctx) => ctx.db.get<any>("SELECT COUNT(*) n FROM academic_items WHERE status='proposed'").n as number;
void localDateKey;
