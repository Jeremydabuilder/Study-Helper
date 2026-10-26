import { afterEach, describe, expect, it } from 'vitest';
import { RawGoogleEvent } from '../src/core/calendar';
import { decryptJson, encryptJson } from '../src/server/crypto';
import { CalendarError, GoogleGateway, MemoryGateway, READONLY_SCOPE } from '../src/server/services/calendarGoogle';
import { startServer, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });

const timed = (id: string, summary: string, startIso: string, mins = 60, extra: Partial<RawGoogleEvent> = {}): RawGoogleEvent =>
  ({ id, summary, status: 'confirmed', start: { dateTime: startIso }, end: { dateTime: new Date(Date.parse(startIso) + mins * 60000).toISOString() }, etag: `"${id}"`, ...extra });
const allDay = (id: string, summary: string, date: string, extra: Partial<RawGoogleEvent> = {}): RawGoogleEvent => {
  const next = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  return { id, summary, status: 'confirmed', start: { date }, end: { date: next }, etag: `"${id}"`, ...extra };
};

async function connect(events: RawGoogleEvent[], label = 'tests') {
  const gw = new MemoryGateway();
  gw.calendars = [{ id: 'cal1', name: 'My calendar', tz: 'America/New_York', color: null, primary: true }, { id: 'tennis', name: 'Tennis', tz: 'America/New_York', color: null, primary: false }];
  gw.events.set('cal1', events);
  s = await startServer({ gateway: gw });
  expect((await s.call('POST', '/api/calendar/connect', {})).body.connected).toBe(true);
  await s.call('PUT', '/api/calendar/calendars', { calendars: [{ id: 'cal1', selected: true, label }] });
  const sync = await s.call('POST', '/api/calendar/sync', {});
  return { gw, sync };
}
const items = async (status = 'proposed') => (await s.call('GET', `/api/items?status=${status}`)).body as any[];

describe('import & confirmation', () => {
  it('imports nothing until the student picks calendars, then only proposes — never auto-confirms', async () => {
    const gw = new MemoryGateway();
    gw.calendars = [{ id: 'cal1', name: 'Cal', tz: 'UTC', color: null, primary: true }];
    gw.events.set('cal1', [timed('t1', 'Math test', '2026-11-04T15:00:00Z')]);
    s = await startServer({ gateway: gw });
    await s.call('POST', '/api/calendar/connect', {});
    const none = await s.call('POST', '/api/calendar/sync', {});
    expect(none.body.calendars).toBe(0);
    expect(await items()).toHaveLength(0);
    await s.call('PUT', '/api/calendar/calendars', { calendars: [{ id: 'cal1', selected: true, label: 'tests' }] });
    await s.call('POST', '/api/calendar/sync', {});
    expect(await items('proposed')).toHaveLength(1);
    expect(await items('confirmed')).toHaveLength(0);
    // nothing is planned until confirmed
    expect((await s.call('GET', '/api/schedule')).body.blocks).toHaveLength(0);
  });

  it('shows the original event beside the proposal and marks missing details as unknown', async () => {
    await connect([timed('t1', 'Science test', '2026-11-04T15:00:00Z', 60, { description: 'bring a pencil' }), timed('h1', 'Math worksheet', '2026-11-03T23:00:00Z')]);
    const [h, t] = (await items()).sort((a, b) => a.title.localeCompare(b.title));
    expect(t.event).toMatchObject({ title: 'Science test', calendarName: 'My calendar', description: 'bring a pencil' });
    expect(t.unknown).toEqual(expect.arrayContaining(['topics covered', 'subject', 'time needed']));
    expect(t.topicsText).toBeNull(); expect(t.conceptIds).toEqual([]);
    expect(h.dueKind).toBe('unknown'); expect(h.unknown).toContain('due date');
    expect(h.proposal.dueBasis).toMatch(/not assumed to be a deadline/);
  });

  it('does not create proposals for classes, activities or review sessions', async () => {
    await connect([timed('c', 'Period 3 class', '2026-11-04T15:00:00Z'), timed('p', 'Tennis practice', '2026-11-04T21:00:00Z'), timed('r', 'History quiz review', '2026-11-04T23:00:00Z')]);
    expect(await items()).toHaveLength(0);
  });

  it('confirming applies the student’s edits; dismissed proposals stay dismissed after re-sync', async () => {
    await connect([timed('t1', 'Quiz 4', '2026-11-04T15:00:00Z'), timed('t2', 'Project outline', '2026-11-12T15:00:00Z')]);
    const [q, p] = await items();
    const sub = (await s.call('POST', '/api/subjects', { name: 'History' })).body.id;
    const c = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name: 'Causes of WWI' })).body.id;
    expect((await s.call('POST', `/api/items/${q.id}/confirm`, { subjectId: sub, conceptIds: [c], estimateMin: 45 })).status).toBe(200);
    await s.call('POST', `/api/items/${p.id}/dismiss`, {});
    await s.call('POST', '/api/calendar/sync', {});
    expect(await items('proposed')).toHaveLength(0);
    const conf = await items('confirmed');
    expect(conf).toHaveLength(1);
    expect(conf[0]).toMatchObject({ subjectName: 'History', estimateMin: 45, conceptIds: [c] });
    expect(await items('dismissed')).toHaveLength(1);
  });
});

describe('duplicates', () => {
  it('re-syncing never duplicates events or items, even with a repeated event in one batch', async () => {
    const e = timed('t1', 'Unit test', '2026-11-04T15:00:00Z');
    const { gw } = await connect([e, e]);
    await s.call('POST', '/api/calendar/sync', {});
    await s.call('POST', '/api/calendar/sync', {});
    expect(s.rt.ctx('real').db.get<any>('SELECT COUNT(*) n FROM cal_events').n).toBe(1);
    expect(await items()).toHaveLength(1);
    void gw;
  });
  it('flags (but keeps) a same-titled event from another calendar as a possible duplicate', async () => {
    const gw = new MemoryGateway();
    gw.calendars = [{ id: 'a', name: 'A', tz: 'UTC', color: null, primary: true }, { id: 'b', name: 'B', tz: 'UTC', color: null, primary: false }];
    gw.events.set('a', [allDay('x', 'Math Test', '2026-11-05')]); gw.events.set('b', [allDay('y', 'Math Test', '2026-11-05')]);
    s = await startServer({ gateway: gw });
    await s.call('POST', '/api/calendar/connect', {});
    await s.call('PUT', '/api/calendar/calendars', { calendars: [{ id: 'a', selected: true, label: 'tests' }, { id: 'b', selected: true, label: 'tests' }] });
    await s.call('POST', '/api/calendar/sync', {});
    const ps = await items();
    expect(ps).toHaveLength(2);
    expect(ps.filter((p) => p.proposal?.reasons).length).toBe(2);
    const dup = s.rt.ctx('real').db.all<any>('SELECT proposal FROM academic_items').filter((r) => JSON.parse(r.proposal).possibleDuplicateOf);
    expect(dup).toHaveLength(1);
  });
});

describe('time zones & all-day', () => {
  it('all-day deadlines are dates, not instants: they do not move with the profile time zone', async () => {
    await connect([allDay('hw', 'Lab report due', '2026-11-05')]);
    const [it] = await items();
    expect(it).toMatchObject({ dueKind: 'date', dueDate: '2026-11-05' });
    await s.call('PUT', '/api/profile', { timezone: 'Pacific/Auckland' });
    expect((await items())[0].dueDate).toBe('2026-11-05');
  });
  it('timed events land on the local day of the student’s own time zone', async () => {
    await connect([timed('q', 'History quiz', '2026-11-05T02:30:00Z')]); // 22:30 on the 4th in New York, 11:30 on the 5th in Tokyo
    expect((await items())[0].dueDate).toBe('2026-11-04');
    await s.call('PUT', '/api/profile', { timezone: 'Asia/Tokyo' });
    expect((await items())[0].dueDate).toBe('2026-11-05');
  });
});

describe('event changes, cancellations, missing events', () => {
  async function confirmed() {
    const r = await connect([timed('t1', 'Math test', '2026-11-05T15:00:00Z'), timed('t2', 'Quiz 2', '2026-11-06T15:00:00Z')]);
    for (const it of await items()) await s.call('POST', `/api/items/${it.id}/confirm`, { estimateMin: 60 });
    return r;
  }
  it('a moved event updates the due date, flags the change, and replans', async () => {
    const { gw } = await confirmed();
    const before = (await s.call('GET', '/api/schedule')).body.blocks.filter((b: any) => b.title === 'Math test');
    gw.events.set('cal1', [timed('t1', 'Math test', '2026-11-09T15:00:00Z'), timed('t2', 'Quiz 2', '2026-11-06T15:00:00Z')]);
    const r = await s.call('POST', '/api/calendar/sync', {});
    expect(r.body.changed).toBe(1);
    const it = (await items('confirmed')).find((i) => i.title === 'Math test');
    expect(it.dueDate).toBe('2026-11-09');
    expect(it.syncState).toBe('source_changed'); expect(it.syncNote).toMatch(/plan was updated/);
    const after = (await s.call('GET', '/api/schedule')).body.blocks.filter((b: any) => b.title === 'Math test');
    expect(after.at(-1).dateKey > before.at(-1).dateKey).toBe(true); // prep now runs later
    expect((await s.call('GET', '/api/today')).body.attention.some((a: any) => a.kind === 'changed')).toBe(true);
    await s.call('POST', `/api/items/${it.id}/ack`, { action: 'accept' });
    expect((await items('confirmed')).find((i) => i.title === 'Math test').syncState).toBe('ok');
  });
  it('never overwrites a due date the student set themselves', async () => {
    const { gw } = await confirmed();
    const it = (await items('confirmed')).find((i) => i.title === 'Math test');
    await s.call('PATCH', `/api/items/${it.id}`, { dueDate: '2026-11-04' });
    gw.events.set('cal1', [timed('t1', 'Math test', '2026-11-09T15:00:00Z'), timed('t2', 'Quiz 2', '2026-11-06T15:00:00Z')]);
    await s.call('POST', '/api/calendar/sync', {});
    const after = (await items('confirmed')).find((i) => i.title === 'Math test');
    expect(after.dueDate).toBe('2026-11-04');
    expect(after.syncNote).toMatch(/your own due date was kept/i);
  });
  it('a cancelled event pauses the item (excluded from the plan) instead of silently deleting it', async () => {
    const { gw } = await confirmed();
    gw.events.set('cal1', [{ id: 't1', status: 'cancelled' } as RawGoogleEvent, timed('t2', 'Quiz 2', '2026-11-06T15:00:00Z')]);
    await s.call('POST', '/api/calendar/sync', {});
    const it = (await items('confirmed')).find((i) => i.title === 'Math test');
    expect(it.syncState).toBe('source_cancelled');
    expect((await s.call('GET', '/api/schedule')).body.blocks.some((b: any) => b.title === 'Math test')).toBe(false);
    expect((await s.call('GET', '/api/today')).body.upcoming.some((u: any) => u.title === 'Math test')).toBe(false);
    await s.call('POST', `/api/items/${it.id}/ack`, { action: 'keep_manual' });
    expect((await items('confirmed')).find((i) => i.title === 'Math test')).toMatchObject({ syncState: 'ok', source: 'manual', event: null });
  });
  it('cancelling an unconfirmed proposal dismisses it; events that vanish are flagged missing', async () => {
    const { gw } = await connect([timed('a', 'Quiz A', '2026-11-05T15:00:00Z'), timed('b', 'Quiz B', '2026-11-06T15:00:00Z')]);
    const [a, b] = (await items()).sort((x, y) => x.title.localeCompare(y.title));
    await s.call('POST', `/api/items/${b.id}/confirm`, {});
    gw.events.set('cal1', [{ id: 'a', status: 'cancelled' } as RawGoogleEvent]); // a cancelled, b vanished
    await s.call('POST', '/api/calendar/sync', {});
    expect(await items('proposed')).toHaveLength(0);
    expect((await items('dismissed')).map((i) => i.id)).toContain(a.id);
    expect((await items('confirmed'))[0].syncState).toBe('source_missing');
  });
});

describe('availability: busy time ≠ free time', () => {
  it('plans around tennis (timed + all-day tournaments), honours limits, and never schedules in busy or protected time', async () => {
    const gw = new MemoryGateway();
    gw.calendars = [{ id: 'cal1', name: 'School', tz: 'America/New_York', color: null, primary: true }, { id: 'tennis', name: 'Tennis', tz: 'America/New_York', color: null, primary: false }];
    gw.events.set('cal1', [timed('t', 'Science test', '2026-11-05T15:00:00Z')]);
    gw.events.set('tennis', [timed('p1', 'Tennis practice', '2026-10-27T20:00:00Z', 120), allDay('tourn', 'Tournament', '2026-10-28')]);
    s = await startServer({ gateway: gw });
    await s.call('POST', '/api/calendar/connect', {});
    await s.call('PUT', '/api/calendar/calendars', { calendars: [{ id: 'cal1', selected: true, label: 'tests' }, { id: 'tennis', selected: true, label: 'activity', allDayBusy: true }] });
    await s.call('POST', '/api/calendar/sync', {});
    const [it] = await items(); await s.call('POST', `/api/items/${it.id}/confirm`, { estimateMin: 120 });
    const sched = (await s.call('GET', '/api/schedule')).body;
    expect(sched.blocks.length).toBeGreaterThan(0);
    expect(sched.blocks.some((b: any) => b.dateKey === '2026-10-28')).toBe(false);           // all-day tournament day: no study
    const practiceDay = sched.blocks.filter((b: any) => b.dateKey === '2026-10-27');
    for (const b of practiceDay) expect(b.end <= Date.parse('2026-10-27T19:45:00Z') || b.start >= Date.parse('2026-10-27T22:15:00Z')).toBe(true); // 15 min buffers around practice
    expect(sched.blocks.some((b: any) => b.dateKey === '2026-11-05')).toBe(false);         // never on the test day itself
    const perDay: Record<string, number> = {};
    for (const b of sched.blocks) perDay[b.dateKey] = (perDay[b.dateKey] ?? 0) + b.minutes;
    expect(Math.max(...Object.values(perDay))).toBeLessThanOrEqual(60);
    // tightening availability replans immediately and reports an honest shortfall
    const cur = (await s.call('GET', '/api/settings')).body.availability;
    await s.call('PUT', '/api/settings', { availability: { ...cur, dailyLimitMin: [0, 0, 0, 0, 0, 0, 0] } });
    const tight = (await s.call('GET', '/api/schedule')).body;
    expect(tight.blocks).toHaveLength(0); expect(tight.shortfalls[0].missingMin).toBe(120);
  });
  it('manual entry works with no calendar at all', async () => {
    s = await startServer();
    const r = await s.call('POST', '/api/items', { title: 'Worksheet', type: 'homework', dueDate: '2026-10-29', estimateMin: 30 });
    expect(r.status).toBe(200);
    const sched = (await s.call('GET', '/api/schedule')).body;
    expect(sched.blocks.reduce((a: number, b: any) => a + b.minutes, 0)).toBe(30);
    expect((await s.call('POST', '/api/items', { title: 'x', type: 'bogus' })).status).toBe(400);
  });
});

describe('homework completion is separate from mastery', () => {
  it('a passing due date does not complete homework, and completing it does not touch concept state', async () => {
    s = await startServer();
    const id = (await s.call('POST', '/api/items', { title: 'Essay', type: 'homework', dueDate: '2026-10-27' })).body.id;
    s.clock.now += 30 * 86400000;
    expect((await s.call('GET', '/api/items?status=confirmed')).body[0].completed).toBe(false);
    const db = s.rt.ctx('real').db;
    const before = db.get<any>('SELECT COUNT(*) n FROM concept_state').n;
    await s.call('POST', `/api/items/${id}/complete`, { done: true });
    expect((await s.call('GET', '/api/items?status=confirmed')).body[0].completed).toBe(true);
    expect(db.get<any>('SELECT COUNT(*) n FROM concept_state').n).toBe(before);
    expect(db.get<any>('SELECT COUNT(*) n FROM attempts').n).toBe(0);
  });
});

describe('expired authorization, outages and disconnect', () => {
  it('reports expired authorization clearly, keeps imported data and manual entry working, and recovers on reconnect', async () => {
    const { gw } = await connect([timed('t1', 'Math test', '2026-11-05T15:00:00Z')]);
    gw.failWith = new CalendarError('reauth_required', 'Google access has expired or was revoked.');
    const r = await s.call('POST', '/api/calendar/sync', {});
    expect(r.status).toBe(401); expect(r.body.error.code).toBe('calendar_reauth_required');
    const st = (await s.call('GET', '/api/calendar')).body;
    expect(st.status).toBe('reauth_required'); expect(st.lastError).toMatch(/expired|revoked/i);
    expect(st.lastSyncOkAt).toBeTruthy();                                   // last *successful* sync is still shown
    expect(await items()).toHaveLength(1);                                   // imported data retained
    expect((await s.call('POST', '/api/items', { title: 'HW', type: 'homework', dueDate: '2026-11-02' })).status).toBe(200);
    gw.failWith = null;
    await s.call('POST', '/api/calendar/connect', {});
    expect((await s.call('POST', '/api/calendar/sync', {})).status).toBe(200);
    expect((await s.call('GET', '/api/calendar')).body.status).toBe('connected');
  });
  it('shows last successful sync and maps rate limits without losing data', async () => {
    const { gw } = await connect([timed('t1', 'Math test', '2026-11-05T15:00:00Z')]);
    const ok = (await s.call('GET', '/api/calendar')).body.lastSyncOkAt;
    s.clock.now += 3600_000;
    gw.failWith = new CalendarError('rate_limited', 'slow down');
    expect((await s.call('POST', '/api/calendar/sync', {})).status).toBe(429);
    const st = (await s.call('GET', '/api/calendar')).body;
    expect(st.lastSyncOkAt).toBe(ok); expect(st.lastSyncAt).toBeGreaterThan(ok);
  });
  it('disconnect keeps data by default; deletion removes events and calendar-derived items (optionally keeping confirmed ones as manual)', async () => {
    await connect([timed('a', 'Quiz A', '2026-11-05T15:00:00Z'), timed('b', 'Quiz B', '2026-11-06T15:00:00Z')]);
    const [a] = await items(); await s.call('POST', `/api/items/${a.id}/confirm`, {});
    const db = s.rt.ctx('real').db;
    expect(db.get<any>('SELECT token_enc FROM cal_connection').token_enc).toBeTruthy();
    await s.call('POST', '/api/calendar/disconnect', { deleteImported: false });
    expect(db.get<any>('SELECT token_enc, status FROM cal_connection')).toMatchObject({ token_enc: null, status: 'disconnected' });
    expect(db.get<any>('SELECT COUNT(*) n FROM cal_events').n).toBe(2);
    expect((await s.call('POST', '/api/calendar/sync', {})).status).toBe(409);
    await s.call('POST', '/api/calendar/disconnect', { deleteImported: true, keepItems: true });
    expect(db.get<any>('SELECT COUNT(*) n FROM cal_events').n).toBe(0);
    expect(db.get<any>('SELECT COUNT(*) n FROM cal_calendars').n).toBe(0);
    const left = await items('confirmed');
    expect(left).toHaveLength(1); expect(left[0]).toMatchObject({ source: 'manual', event: null });
    expect(await items('proposed')).toHaveLength(0);
  });
});

describe('token protection', () => {
  it('encrypts tokens at rest and refuses tampering or the wrong secret', () => {
    const blob = encryptJson({ access_token: 'ya29.secret', refresh_token: 'r' }, 'a'.repeat(32));
    expect(blob).not.toContain('ya29'); expect(blob).not.toContain('secret');
    expect(decryptJson<any>(blob, 'a'.repeat(32)).access_token).toBe('ya29.secret');
    expect(() => decryptJson(blob, 'b'.repeat(32))).toThrow();
    const parts = blob.split('.'); parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptJson(parts.join('.'), 'a'.repeat(32))).toThrow();
  });
  it('stored token column holds ciphertext only', async () => {
    await connect([]);
    const enc = s.rt.ctx('real').db.get<any>('SELECT token_enc FROM cal_connection').token_enc as string;
    expect(enc.startsWith('v1.')).toBe(true); expect(enc).not.toMatch(/access_token/);
  });
});

describe('Google gateway (OAuth, refresh, errors) with a fake network', () => {
  const cfg = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://localhost:8787/api/calendar/oauth/callback' };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  it('requests only the read-only scope with PKCE and offline access', () => {
    const u = new URL(new GoogleGateway(cfg, (async () => json({})) as typeof fetch).authUrl('st', 'chal'));
    expect(u.searchParams.get('scope')).toBe(READONLY_SCOPE);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256'); expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.toString()).not.toContain('sec');
  });
  it('refuses a grant that did not include the calendar scope', async () => {
    const gw = new GoogleGateway(cfg, (async () => json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'openid' })) as typeof fetch);
    await expect(gw.exchangeCode('c', 'v')).rejects.toMatchObject({ code: 'denied' });
  });
  it('refreshes expired access tokens and persists the new ones; invalid_grant means reconnect', async () => {
    let calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes('oauth2.googleapis.com/token')) return String(init?.body).includes('refresh_token=dead') ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'new', expires_in: 3600, scope: READONLY_SCOPE });
      return json({ items: [{ id: 'c1', summary: 'Cal', timeZone: 'UTC', primary: true }] });
    }) as typeof fetch;
    const gw = new GoogleGateway(cfg, f, () => 1_000_000);
    const r = await gw.listCalendars({ access_token: 'old', refresh_token: 'good', expires_at: 0, scope: READONLY_SCOPE });
    expect(r.tokens.access_token).toBe('new'); expect(r.calendars[0].id).toBe('c1');
    await expect(gw.listCalendars({ access_token: 'old', refresh_token: 'dead', expires_at: 0, scope: READONLY_SCOPE })).rejects.toMatchObject({ code: 'reauth_required' });
  });
  it('maps 401-after-refresh, school-policy 403, API-disabled, 429 and 5xx to explainable errors', async () => {
    const mk = (status: number, body: unknown = {}) => new GoogleGateway(cfg, (async (url: string) => String(url).includes('token') ? json({ access_token: 'n', expires_in: 3600, scope: READONLY_SCOPE }) : json(body, status)) as typeof fetch, () => 0);
    const t = { access_token: 'a', refresh_token: 'r', expires_at: 10 ** 12, scope: READONLY_SCOPE };
    await expect(mk(401).listCalendars(t)).rejects.toMatchObject({ code: 'reauth_required' });
    const org = await mk(403, { error: { errors: [{ reason: 'forbidden' }] } }).listCalendars(t).catch((e) => e);
    expect(org.code).toBe('org_blocked'); expect(org.message).toMatch(/school|organi[sz]ation/i); expect(org.message).toMatch(/manual/i);
    await expect(mk(403, { error: { errors: [{ reason: 'accessNotConfigured' }] } }).listCalendars(t)).rejects.toMatchObject({ code: 'api_disabled' });
    await expect(mk(429).listCalendars(t)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(mk(503).listCalendars(t)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('pages through events and requests deleted ones so cancellations are seen', async () => {
    const seen: URL[] = [];
    const f = (async (url: string) => { const u = new URL(url); seen.push(u); return json(u.searchParams.get('pageToken') ? { items: [{ id: 'b' }] } : { items: [{ id: 'a' }], nextPageToken: 'p2' }); }) as typeof fetch;
    const r = await new GoogleGateway(cfg, f, () => 0).listEvents({ access_token: 'a', refresh_token: 'r', expires_at: 10 ** 12, scope: READONLY_SCOPE }, 'primary', 0, 10 ** 9);
    expect(r.events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(seen[0].searchParams.get('showDeleted')).toBe('true'); expect(seen[0].searchParams.get('singleEvents')).toBe('true');
  });
  it('tells the student when Google is not configured on this server, and that manual entry still works', async () => {
    s = await startServer();
    const st = (await s.call('GET', '/api/calendar')).body;
    expect(st.available).toBe(false); expect(st.setupHint).toMatch(/manual entry/i);
    expect(st.limitation).toMatch(/Classroom/);
    const c = await s.call('POST', '/api/calendar/connect', {});
    expect(c.status).toBe(503); expect(c.body.error.code).toBe('calendar_not_configured');
  });
});
