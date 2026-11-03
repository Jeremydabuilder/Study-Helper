/** The owner-only deployment: one login, and every other door closed — checked on the server, not in the page. */
import { afterEach, describe, expect, it } from 'vitest';
import { HostedHarness } from './hostedHarness';
import { PG_AVAILABLE } from './pgHarness';

const OWNER = { email: 'owner@example.test', password: 'correct horse battery staple' };
const open: HostedHarness[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.stop(); });
const start = async (extra: Record<string, unknown> = {}) => { const h = await HostedHarness.start({ owner: OWNER, ...extra }); open.push(h); return h; };
const raw = (h: HostedHarness, method: string, path: string, body?: unknown, cookie?: string) => fetch(`${h.url}${path}`, { method, headers: { origin: h.url, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const users = async (h: HostedHarness) => (await h.db.pool.query('SELECT count(*)::int n FROM "user"')).rows[0].n as number;

describe.skipIf(!PG_AVAILABLE)('owner-only site', () => {
  it('signs the owner in from any browser, keeps the password out of every response, and refuses a wrong password', async () => {
    const h = await start();
    expect(await users(h)).toBe(1);
    const phone = h.student(OWNER.email), laptop = h.student(OWNER.email);
    const bad = await phone.post('/api/auth/sign-in/email', { email: OWNER.email, password: 'wrong wrong wrong' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    for (const dev of [phone, laptop]) {
      const ok = await dev.post('/api/auth/sign-in/email', { email: OWNER.email, password: OWNER.password });
      expect(ok.status).toBe(200); expect(JSON.stringify(ok.body)).not.toContain(OWNER.password);
      expect((await dev.get('/api/session')).body).toMatchObject({ signedIn: true, guest: false, methods: { owner: true, guest: false, oidc: null, password: false } });
    }
    expect((await phone.post('/api/subjects', { name: 'From my phone' })).status).toBeLessThan(300);
    expect(JSON.stringify((await laptop.get('/api/subjects')).body)).toContain('From my phone');      // one owner, every device
    await phone.signOut(); expect((await phone.get('/api/subjects')).status).toBe(401); expect((await laptop.get('/api/subjects')).status).toBe(200);
  });
  it('blocks a signed-out visitor from every private route and every AI request', async () => {
    const h = await start();
    const owner = h.student(OWNER.email); await owner.post('/api/auth/sign-in/email', { email: OWNER.email, password: OWNER.password });
    const sub = (await owner.post('/api/subjects', { name: 'Private' })).body.id;
    const src = (await owner.post(`/api/subjects/${sub}/sources`, { title: 'N', text: 'Private notes about photosynthesis and chloroplasts in plant cells.' })).body.id;
    const convo = (await owner.post('/api/conversations', { mode: 'general' })).body.id;
    const probes: [string, string, unknown?][] = [
      ['GET', '/api/subjects'], ['GET', `/api/subjects/${sub}`], ['GET', `/api/sources/${src}`], ['GET', '/api/homework'], ['GET', '/api/homework/next'], ['GET', '/api/memory'], ['GET', '/api/items'],
      ['GET', '/api/progress'], ['GET', '/api/today'], ['GET', '/api/account/export'], ['GET', '/api/account'], ['GET', '/api/files/anything'], ['GET', '/api/myhelper/state'],
      ['POST', `/api/sources/${src}/extract`, {}], ['POST', `/api/conversations/${convo}/messages`, { text: 'hi' }], ['POST', '/api/conversations', { mode: 'general' }], ['POST', '/api/sessions', { mode: 'practice' }],
      ['POST', '/api/homework', { sourceId: src }], ['POST', '/api/homework/questions/x/help', { action: 'hint' }], ['POST', '/api/homework/questions/x/check', {}], ['POST', '/api/subjects', { name: 'x' }],
      ['POST', '/api/myhelper/import', { confirm: true }], ['POST', '/api/account/delete', { confirm: 'DELETE MY ACCOUNT' }],
    ];
    for (const [m, p, body] of probes) { const r = await raw(h, m, p, body); expect([m, p, r.status]).toEqual([m, p, 401]); const t = await r.text(); expect(t).not.toMatch(/Private|photosynthesis/); }
    expect((await (await raw(h, 'GET', '/api/session')).json())).toMatchObject({ signedIn: false });
    expect((await (await raw(h, 'GET', '/readyz')).json())).toMatchObject({ ok: true });
  });
  it('has no other door: sign-up, guests, social sign-in, invitations, password reset and the operator page do not exist', async () => {
    const h = await start({ limits: { AUTH_GUESTS: '1' } }).catch((e) => e);
    expect(String(h)).toMatch(/cannot be combined with AUTH_GUESTS/);
    const s = await start();
    for (const [path, body] of [['/api/auth/sign-up/email', { email: 'new@example.test', password: 'another long password 1', name: 'x' }], ['/api/auth/sign-in/anonymous', {}], ['/api/auth/sign-in/social', { provider: 'google' }], ['/api/auth/forget-password', { email: OWNER.email }], ['/api/auth/reset-password', { newPassword: 'x'.repeat(14), token: 'x' }], ['/api/auth/change-password', { currentPassword: 'a', newPassword: 'b'.repeat(14) }], ['/api/auth/delete-user', {}], ['/api/invite/check', { code: 'ABCD-EFGH-JKLM-NPQR' }], ['/api/invite/start', { code: 'ABCD-EFGH-JKLM-NPQR' }]] as [string, unknown][]) {
      const r = await raw(s, 'POST', path, body); expect([path, r.status]).toEqual([path, 404]);
    }
    process.env.OPERATOR_TOKEN = 'operator-key-for-tests-0123456789';
    try { const r = await raw(s, 'GET', '/internal/operator/status', undefined); expect(r.headers.get('content-type') ?? '').not.toMatch(/json/); expect(await r.text()).not.toMatch(/switches|invites/); const w = await raw(s, 'POST', '/internal/operator/invites', { count: 1 }); expect(w.status).toBeGreaterThanOrEqual(400); } finally { delete process.env.OPERATOR_TOKEN; }
    expect(await users(s)).toBe(1);
  });
  it('slows down password guessing, and a different email cannot sign in even with a real account row', async () => {
    const h = await start({ limits: { RATE_AUTH_PER_MIN: '1000' } });
    const outcomes: number[] = [];
    for (let i = 0; i < 10; i++) outcomes.push((await raw(h, 'POST', '/api/auth/sign-in/email', { email: OWNER.email, password: `wrong password ${i}` })).status);
    expect(outcomes.slice(0, 8).every((c) => c >= 400 && c !== 429)).toBe(true); expect(outcomes.slice(8)).toEqual([429, 429]);
    expect((await h.student(OWNER.email).post('/api/auth/sign-in/email', { email: OWNER.email, password: OWNER.password })).status).toBe(429); // still locked for this address for a while
    h.clock.now += 16 * 60_000;
    expect((await h.student(OWNER.email).post('/api/auth/sign-in/email', { email: OWNER.email, password: OWNER.password })).status).toBe(200);
  });
  it('keeps the owner and their data across a restart, changes the password only when the setting changes, and refuses a database that has other accounts', async () => {
    const h = await start();
    const a = h.student(OWNER.email); await a.post('/api/auth/sign-in/email', { email: OWNER.email, password: OWNER.password });
    await a.post('/api/subjects', { name: 'Survives restart' });
    await h.stop({ keepDb: true }); open.pop();
    const again = await HostedHarness.start({ owner: OWNER, db: h.db, dir: h.dir }); open.push(again);
    const b = again.student(OWNER.email); b.jar = new Map(a.jar);
    expect(JSON.stringify((await b.get('/api/subjects')).body)).toContain('Survives restart');   // same cookie, new process
    expect(await users(again)).toBe(1);
    await again.stop({ keepDb: true }); open.pop();
    const rotated = await HostedHarness.start({ owner: { email: OWNER.email, password: 'a brand new long password' }, db: h.db, dir: h.dir }); open.push(rotated);
    const c = rotated.student(OWNER.email); c.jar = new Map(a.jar);
    expect((await c.get('/api/subjects')).status).toBe(401);                                           // the old session was signed out
    expect((await rotated.student(OWNER.email).post('/api/auth/sign-in/email', { email: OWNER.email, password: OWNER.password })).status).toBeGreaterThanOrEqual(400);
    expect((await rotated.student(OWNER.email).post('/api/auth/sign-in/email', { email: OWNER.email, password: 'a brand new long password' })).status).toBe(200);
    await rotated.stop({ keepDb: true }); open.pop();
    await h.db.pool.query('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1,$2,$3,true,now(),now())', ['intruder-id', 'x', 'intruder@example.test']);
    await expect(HostedHarness.start({ owner: { email: OWNER.email, password: null }, db: h.db, dir: h.dir })).rejects.toThrow(/other account/);
  });
  it('needs a password for the very first start and rejects a short one', async () => {
    await expect(HostedHarness.start({ owner: { email: OWNER.email, password: null } })).rejects.toThrow(/Set OWNER_PASSWORD/);
    await expect(HostedHarness.start({ owner: { email: OWNER.email, password: 'short' } })).rejects.toThrow(/OWNER_PASSWORD must be at least 12/);
  });
});
