import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RawGoogleEvent } from '../src/core/calendar';
import { GoogleGateway, READONLY_SCOPE } from '../src/server/services/calendarGoogle';
import { decryptJson } from '../src/server/crypto';
import { startServer, TestServer } from './helpers';

/** A faithful-enough fake of Google's OAuth + Calendar v3 endpoints, with a controllable clock and failure switches. */
class FakeGoogle {
  log: { method: string; url: string }[] = [];
  challenge = ''; issued = 0; liveAccess = new Map<string, number>(); // token -> expiry ms
  refreshRevoked = false; orgBlock = false; expireAccessNow = false; revoked: string[] = [];
  calendars = [{ id: 'jeremy@school.test', summary: 'Jeremy (primary)', timeZone: 'America/New_York', primary: true }, { id: 'tennis@group.calendar.google.com', summary: 'Tennis', timeZone: 'America/New_York' }];
  events: Record<string, RawGoogleEvent[]> = {};
  constructor(private now: () => number) {}
  private json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  private issue() { const t = `at-${++this.issued}`; this.liveAccess.set(t, this.now() + 3600_000); return t; }
  fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input)); const method = (init.method ?? 'GET').toUpperCase();
    this.log.push({ method, url: `${url.origin}${url.pathname}` });
    if (url.pathname === '/token') {
      const p = new URLSearchParams(String(init.body));
      if (p.get('grant_type') === 'authorization_code') {
        const verifierOk = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') === this.challenge;
        if (p.get('code') !== 'good-code' || !verifierOk) return this.json({ error: 'invalid_grant' }, 400);
        return this.json({ access_token: this.issue(), refresh_token: 'refresh-1', expires_in: 3600, scope: READONLY_SCOPE, token_type: 'Bearer' });
      }
      if (this.refreshRevoked || p.get('refresh_token') !== 'refresh-1') return this.json({ error: 'invalid_grant' }, 400);
      return this.json({ access_token: this.issue(), expires_in: 3600, scope: READONLY_SCOPE });
    }
    if (url.pathname === '/revoke') { this.revoked.push(new URLSearchParams(String(init.body)).get('token') ?? ''); return this.json({}); }
    // Calendar API
    const tok = String((init.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '');
    const exp = this.liveAccess.get(tok);
    if (this.expireAccessNow) { this.expireAccessNow = false; this.liveAccess.delete(tok); }
    if (!exp || exp <= this.now() || !this.liveAccess.has(tok)) return this.json({ error: { code: 401 } }, 401);
    if (this.orgBlock) return this.json({ error: { errors: [{ reason: 'forbidden' }] } }, 403);
    if (url.pathname.endsWith('/calendarList')) return this.json({ items: this.calendars });
    const m = url.pathname.match(/\/calendars\/([^/]+)\/events$/);
    if (m) {
      const all = this.events[decodeURIComponent(m[1])] ?? [];
      const from = Date.parse(url.searchParams.get('timeMin')!), to = Date.parse(url.searchParams.get('timeMax')!);
      const inWin = all.filter((e) => e.status === 'cancelled' || ((e.start?.dateTime ? Date.parse(e.start.dateTime) : Date.parse(e.start!.date + 'T12:00:00Z')) >= from && (e.start?.dateTime ? Date.parse(e.start.dateTime) : Date.parse(e.start!.date + 'T12:00:00Z')) < to));
      const page = Number(url.searchParams.get('pageToken') ?? 0), size = 2;
      return this.json({ items: inWin.slice(page * size, (page + 1) * size), nextPageToken: (page + 1) * size < inWin.length ? String(page + 1) : undefined });
    }
    return this.json({}, 404);
  }) as unknown as typeof fetch;
}

const CFG = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret', redirectUri: 'http://localhost:8787/api/calendar/oauth/callback' };
let s: TestServer;
afterEach(async () => { await s?.close(); });
const ev = (id: string, summary: string, iso: string, extra: Partial<RawGoogleEvent> = {}): RawGoogleEvent => ({ id, summary, status: 'confirmed', start: { dateTime: iso }, end: { dateTime: new Date(Date.parse(iso) + 3600_000).toISOString() }, ...extra });

async function boot() {
  const f = new FakeGoogle(() => s.clock.now);
  const gw = new GoogleGateway(CFG, f.fetch, () => s.clock.now);
  s = await startServer({ gateway: gw, cfg: { google: CFG, appSecret: 'S'.repeat(40) } });
  f.events['jeremy@school.test'] = [ev('t1', 'Math Unit 3 Test', '2026-10-31T14:00:00Z'), ev('h1', 'English essay draft due', '2026-10-29T12:00:00Z'), ev('c1', 'Period 3 class', '2026-10-27T15:00:00Z'), ev('t2', 'History quiz', '2026-11-03T15:00:00Z')];
  f.events['tennis@group.calendar.google.com'] = [ev('p1', 'Tennis practice', '2026-10-27T20:00:00Z', {}), { id: 'tour', summary: 'Tournament', status: 'confirmed', start: { date: '2026-10-28' }, end: { date: '2026-10-30' } }];
  return f;
}
async function oauth(f: FakeGoogle, code = 'good-code', stateOverride?: string) {
  const c = await s.call('POST', '/api/calendar/connect', {});
  expect(c.status).toBe(200);
  const u = new URL(c.body.url); f.challenge = u.searchParams.get('code_challenge')!;
  const cb = await fetch(`http://127.0.0.1:${s.port}/api/calendar/oauth/callback?code=${code}&state=${stateOverride ?? c.body.state}`, { redirect: 'manual' });
  return { authUrl: u, location: cb.headers.get('location') ?? '' };
}
const calReads = (f: FakeGoogle) => f.log.filter((l) => l.url.includes('/calendar/v3'));

describe('Google Calendar end to end (fake Google, real gateway + routes)', () => {
  it('connect (PKCE, read-only scope) → choose calendars → sync → confirm; only GETs ever hit the Calendar API', async () => {
    const f = await boot();
    const { authUrl, location } = await oauth(f);
    expect(authUrl.origin + authUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authUrl.searchParams.get('scope')).toBe(READONLY_SCOPE);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(CFG.redirectUri);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.toString()).not.toContain('csecret');
    expect(location).toBe('/#/calendar?connected=1');

    let st = (await s.call('GET', '/api/calendar')).body;
    expect(st).toMatchObject({ status: 'connected', accountEmail: 'jeremy@school.test', demo: false });
    expect(st.calendars.map((c: any) => c.name).sort()).toEqual(['Jeremy (primary)', 'Tennis']);
    expect(st.calendars.every((c: any) => !c.selected)).toBe(true); // nothing imported until chosen
    expect((await s.call('POST', '/api/calendar/sync', {})).body.calendars).toBe(0);

    await s.call('PUT', '/api/calendar/calendars', { calendars: [{ id: 'jeremy@school.test', selected: true, label: 'school' }, { id: 'tennis@group.calendar.google.com', selected: true, label: 'activity', allDayBusy: true }] });
    const rep = (await s.call('POST', '/api/calendar/sync', {})).body;
    expect(rep).toMatchObject({ calendars: 2, added: 6 }); // paged: 2 per page
    const props = (await s.call('GET', '/api/items?status=proposed')).body.map((p: any) => p.title).sort();
    expect(props).toEqual(['English essay draft due', 'History quiz', 'Math Unit 3 Test']); // class + tennis are busy time, not academic items
    for (const p of (await s.call('GET', '/api/items?status=proposed')).body) await s.call('POST', `/api/items/${p.id}/confirm`, {});
    expect((await s.call('GET', '/api/schedule')).body.blocks.length).toBeGreaterThan(0);

    // read-only: nothing but GET against the Calendar API; scope never widened; no write endpoint touched
    expect(calReads(f).length).toBeGreaterThan(3);
    expect(calReads(f).every((l) => l.method === 'GET')).toBe(true);
    expect(f.log.filter((l) => !['GET', 'POST'].includes(l.method))).toEqual([]);
    expect(f.log.filter((l) => l.method === 'POST').every((l) => l.url.startsWith('https://oauth2.googleapis.com/'))).toBe(true);
    expect(calReads(f).some((l) => /\/events\/|\/(insert|import|move|quickAdd)/.test(l.url))).toBe(false);
    st = (await s.call('GET', '/api/calendar')).body;
    expect(st.lastSyncOkAt).toBe(s.clock.now);
  });

  it('stores tokens encrypted; refreshes an expired access token and re-encrypts the new one', async () => {
    const f = await boot(); await oauth(f);
    await s.call('PUT', '/api/calendar/calendars', { calendars: [{ id: 'jeremy@school.test', selected: true, label: 'tests' }] });
    const db = s.rt.ctx('real').db;
    const before = db.get<any>('SELECT token_enc FROM cal_connection').token_enc as string;
    expect(before).not.toMatch(/at-1|refresh-1/);
    expect(decryptJson<any>(before, 'S'.repeat(40))).toMatchObject({ access_token: 'at-1', refresh_token: 'refresh-1' });
    s.clock.now += 2 * 3600_000; // access token (1h) has expired
    expect((await s.call('POST', '/api/calendar/sync', {})).status).toBe(200);
    expect(f.log.filter((l) => l.url.endsWith('/token')).length).toBe(2); // code exchange + one refresh
    const after = db.get<any>('SELECT token_enc FROM cal_connection').token_enc as string;
    expect(after).not.toBe(before);
    expect(decryptJson<any>(after, 'S'.repeat(40))).toMatchObject({ access_token: 'at-2', refresh_token: 'refresh-1' });
  });

  it('an access token rejected mid-sync is refreshed once and the request retried (no duplicate import)', async () => {
    const f = await boot(); await oauth(f);
    await s.call('PUT', '/api/calendar/calendars', { calendars: [{ id: 'jeremy@school.test', selected: true, label: 'tests' }] });
    f.expireAccessNow = true; // Google invalidates the token server-side although our clock says it is valid
    expect((await s.call('POST', '/api/calendar/sync', {})).status).toBe(200);
    expect(f.log.filter((l) => l.url.endsWith('/token')).length).toBe(2);
    await s.call('POST', '/api/calendar/sync', {});
    expect(s.rt.ctx('real').db.get<any>('SELECT COUNT(*) n FROM cal_events').n).toBe(4);
  });

  it('revoked/expired refresh token → reconnect-needed, data and manual entry kept, recovery by reconnecting', async () => {
    const f = await boot(); await oauth(f);
    await s.call('PUT', '/api/calendar/calendars', { calendars: [{ id: 'jeremy@school.test', selected: true, label: 'tests' }] });
    await s.call('POST', '/api/calendar/sync', {});
    f.refreshRevoked = true; s.clock.now += 3 * 3600_000;
    const r = await s.call('POST', '/api/calendar/sync', {});
    expect(r.status).toBe(401); expect(r.body.error.code).toBe('calendar_reauth_required');
    const st = (await s.call('GET', '/api/status')).body;
    expect(st.calendar.state).toBe('reauth_required');
    expect((await s.call('GET', '/api/items?status=proposed')).body.length).toBeGreaterThan(0);
    expect((await s.call('POST', '/api/items', { title: 'Worksheet', type: 'homework', dueDate: '2026-11-02' })).status).toBe(200);
    f.refreshRevoked = false; f.issued = 10;
    expect((await oauth(f)).location).toBe('/#/calendar?connected=1');
    expect((await s.call('POST', '/api/calendar/sync', {})).status).toBe(200);
    expect((await s.call('GET', '/api/status')).body.calendar.state).toBe('connected');
  });

  it('OAuth failures: forged state is rejected without any token exchange; user denial and school-policy blocks are explained', async () => {
    const f = await boot();
    const forged = await oauth(f, 'good-code', 'forged-state');
    expect(forged.location).toBe('/#/calendar?error=denied');
    expect(f.log.some((l) => l.url.endsWith('/token'))).toBe(false);
    const c = await s.call('POST', '/api/calendar/connect', {});
    const denied = await fetch(`http://127.0.0.1:${s.port}/api/calendar/oauth/callback?error=access_denied&state=${c.body.state}`, { redirect: 'manual' });
    expect(denied.headers.get('location')).toBe('/#/calendar?error=denied');
    const c2 = await s.call('POST', '/api/calendar/connect', {});
    const org = await fetch(`http://127.0.0.1:${s.port}/api/calendar/oauth/callback?error=admin_policy_enforced&state=${c2.body.state}`, { redirect: 'manual' });
    expect(org.headers.get('location')).toBe('/#/calendar?error=org_blocked');
    // a state value can only be used once
    const c3 = await s.call('POST', '/api/calendar/connect', {}); f.challenge = new URL(c3.body.url).searchParams.get('code_challenge')!;
    await fetch(`http://127.0.0.1:${s.port}/api/calendar/oauth/callback?code=good-code&state=${c3.body.state}`, { redirect: 'manual' });
    const replay = await fetch(`http://127.0.0.1:${s.port}/api/calendar/oauth/callback?code=good-code&state=${c3.body.state}`, { redirect: 'manual' });
    expect(replay.headers.get('location')).toBe('/#/calendar?error=denied');
  });

  it('a wrong PKCE verifier cannot be exchanged (the gateway really sends the matching verifier)', async () => {
    const f = await boot();
    const c = await s.call('POST', '/api/calendar/connect', {});
    f.challenge = 'not-the-real-challenge';
    const cb = await fetch(`http://127.0.0.1:${s.port}/api/calendar/oauth/callback?code=good-code&state=${c.body.state}`, { redirect: 'manual' });
    expect(cb.headers.get('location')).toMatch(/error=/);
    expect((await s.call('GET', '/api/calendar')).body.status).toBe('disconnected');
  });

  it('school-managed account refusing API access during sync is explained, with manual entry as the fallback', async () => {
    const f = await boot(); await oauth(f);
    await s.call('PUT', '/api/calendar/calendars', { calendars: [{ id: 'jeremy@school.test', selected: true, label: 'tests' }] });
    f.orgBlock = true;
    const r = await s.call('POST', '/api/calendar/sync', {});
    expect(r.status).toBe(403); expect(r.body.error.code).toBe('calendar_org_blocked'); expect(r.body.error.message).toMatch(/school|organi[sz]ation/i); expect(r.body.error.message).toMatch(/manual/i);
  });

  it('disconnect revokes the grant at Google, wipes the stored token, and stops syncing; deleting imported data removes events', async () => {
    const f = await boot(); await oauth(f);
    await s.call('PUT', '/api/calendar/calendars', { calendars: [{ id: 'jeremy@school.test', selected: true, label: 'tests' }] });
    await s.call('POST', '/api/calendar/sync', {});
    const db = s.rt.ctx('real').db;
    await s.call('POST', '/api/calendar/disconnect', { deleteImported: true, keepItems: false });
    expect(f.revoked).toEqual(['refresh-1']);
    expect(db.get<any>('SELECT COUNT(*) n FROM cal_connection').n).toBe(0);
    expect(db.get<any>('SELECT COUNT(*) n FROM cal_events').n).toBe(0);
    expect(db.get<any>("SELECT COUNT(*) n FROM academic_items WHERE source='calendar'").n).toBe(0);
    expect((await s.call('POST', '/api/calendar/sync', {})).status).toBe(409);
  });

  it('events changing at Google: moved, cancelled and vanished events update the plan; re-syncing is idempotent', async () => {
    const f = await boot(); await oauth(f);
    await s.call('PUT', '/api/calendar/calendars', { calendars: [{ id: 'jeremy@school.test', selected: true, label: 'tests' }, { id: 'tennis@group.calendar.google.com', selected: true, label: 'activity' }] });
    await s.call('POST', '/api/calendar/sync', {});
    for (const p of (await s.call('GET', '/api/items?status=proposed')).body) await s.call('POST', `/api/items/${p.id}/confirm`, { estimateMin: 60 });
    await s.call('POST', '/api/calendar/sync', {});
    expect(s.rt.ctx('real').db.get<any>('SELECT COUNT(*) n FROM academic_items').n).toBe(3);
    f.events['jeremy@school.test'] = [ev('t1', 'Math Unit 3 Test', '2026-11-04T14:00:00Z'), { id: 'h1', status: 'cancelled' } as RawGoogleEvent, ev('c1', 'Period 3 class', '2026-10-27T15:00:00Z')]; // t1 moved, h1 cancelled, t2 vanished
    const r = (await s.call('POST', '/api/calendar/sync', {})).body;
    expect(r).toMatchObject({ changed: 1, cancelled: 1, missing: 1 });
    const items = (await s.call('GET', '/api/items?status=confirmed')).body;
    const by = (t: string) => items.find((i: any) => i.title === t);
    expect(by('Math Unit 3 Test')).toMatchObject({ dueDate: '2026-11-04', syncState: 'source_changed' });
    expect(by('English essay draft due').syncState).toBe('source_cancelled');
    expect(by('History quiz').syncState).toBe('source_missing');
    expect((await s.call('GET', '/api/schedule')).body.blocks.some((b: any) => b.title === 'English essay draft due')).toBe(false);
    expect((await s.call('POST', '/api/calendar/sync', {})).body).toMatchObject({ added: 0, changed: 0 });
  });
});
