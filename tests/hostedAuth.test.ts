import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSettingPg } from '../src/server/hosted/pg';
import { revokeInvites } from '../src/server/hosted/invites';
import { HostedHarness } from './hostedHarness';
import { PG_AVAILABLE } from './pgHarness';

const d = describe.skipIf(!PG_AVAILABLE);
let h: HostedHarness;
beforeAll(async () => { if (PG_AVAILABLE) h = await HostedHarness.start({ passwordSignIn: true }); }, 60_000);
afterAll(async () => { await h?.stop(); });

d('closed by default, invite-only sign-up, sessions', () => {
  it('every data endpoint refuses a signed-out request with 401 (including with a forged cookie)', async () => {
    const anon = h.student('anon@example.test');
    for (const [m, p] of [['GET', '/api/subjects'], ['GET', '/api/memory'], ['GET', '/api/today'], ['POST', '/api/export'], ['GET', '/api/readings'], ['GET', '/api/conversations'], ['GET', '/api/account/export'], ['GET', '/api/files/abc'], ['GET', '/api/calendar'], ['POST', '/api/sessions']] as const) {
      const r = await anon.req(m, p, m === 'POST' ? {} : undefined); expect(r.status, `${m} ${p}`).toBe(401);
    }
    anon.jar.set('sh.session_token', 'forged.value'); expect((await anon.get('/api/subjects')).status).toBe(401);
    expect((await anon.get('/api/session')).body).toMatchObject({ signedIn: false });
  });

  it('without an invitation nobody can create an account, by either sign-in method', async () => {
    const a = h.student('uninvited@example.test');
    const idp = await a.signInWithIdp(); expect(idp.ok).toBe(false);
    const pw = await a.post('/api/auth/sign-up/email', { email: 'uninvited2@example.test', password: 'a-long-test-password', name: 'x' });
    expect(pw.status).toBeGreaterThanOrEqual(400);
    const n = (await h.db.pool.query('SELECT COUNT(*)::int n FROM "user" WHERE email LIKE $1', ['uninvited%'])).rows[0].n;
    expect(n).toBe(0);
  });

  it('a school-looking email address proves nothing: it still needs an invitation code', async () => {
    const s = h.student('kid@lincoln-high.k12.example.edu');
    expect((await s.signInWithIdp()).ok).toBe(false);
  });

  it('a valid single-use code creates exactly one account; reuse, tampered and malformed codes are refused with clear messages', async () => {
    const [code] = await h.codes(1);
    expect((await h.student('x@e.test').post('/api/invite/check', { code })).body).toEqual({ valid: true });
    const alice = h.student('alice@example.test');
    expect((await alice.signInWithIdp(code)).ok).toBe(true);
    expect((await h.student('x@e.test').post('/api/invite/check', { code })).body).toMatchObject({ valid: false, reason: 'used' });
    const bob = h.student('bob@example.test');
    const second = await bob.signInWithIdp(code); expect(second.ok).toBe(false); expect(second.location).toMatch(/invite:invite_invalid/);
    for (const bad of ['', 'not-a-code', code.replace(/.$/, code.endsWith('A') ? 'B' : 'A'), 'AAAA-AAAA-AAAA-AAAA', "'; DROP TABLE invites;--"]) {
      expect((await h.student('y@e.test').post('/api/invite/check', { code: bad })).body).toMatchObject({ valid: false });
    }
    expect((await h.db.pool.query('SELECT COUNT(*)::int n FROM "user" WHERE email = $1', ['alice@example.test'])).rows[0].n).toBe(1);
    expect((await h.db.pool.query('SELECT used_by FROM invites WHERE used_at IS NOT NULL')).rows.length).toBeGreaterThan(0);
  });

  it('eight people racing for one invitation: exactly one account is created', { timeout: 60_000 }, async () => {
    const [code] = await h.codes(1);
    const racers = Array.from({ length: 8 }, (_, i) => h.student(`racer${i}@example.test`));
    const results = await Promise.all(racers.map((s) => s.signUpWithPassword(code)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await h.db.pool.query("SELECT COUNT(*)::int n FROM \"user\" WHERE email LIKE 'racer%'")).rows[0].n).toBe(1);
  });

  it('expired and revoked invitations do not work; pausing sign-ups and the pilot size cap are enforced', async () => {
    const [old] = await h.codes(1, 1);
    h.clock.now += 3 * 86_400_000; // the app's clock: the invitation (created "3 days ago", valid 1 day) has expired
    expect((await h.student('z@e.test').post('/api/invite/check', { code: old })).body).toMatchObject({ valid: false, reason: 'expired' });
    h.clock.now -= 3 * 86_400_000;
    const [rev] = await h.codes(1); await h.db.pool.query("UPDATE invites SET label = 'to-revoke' WHERE code_hash IS NOT NULL AND used_at IS NULL AND label = 'test' AND id::text LIKE '%'"); await revokeInvites(h.db.pool, { label: 'to-revoke' });
    expect((await h.student('z@e.test').post('/api/invite/check', { code: rev })).body).toMatchObject({ valid: false, reason: 'revoked' });
    const [c1] = await h.codes(1);
    await setSettingPg(h.db.pool, 'signups_open', false);
    expect((await h.student('late@example.test').signInWithIdp(c1)).ok).toBe(false);
    await setSettingPg(h.db.pool, 'signups_open', true);
    const have = (await h.db.pool.query('SELECT COUNT(*)::int n FROM "user"')).rows[0].n;
    await setSettingPg(h.db.pool, 'pilot_max_users', have);
    expect((await h.student('full@example.test').signInWithIdp(c1)).ok).toBe(false);
    await setSettingPg(h.db.pool, 'pilot_max_users', 50);
    expect((await h.student('ok@example.test').signInWithIdp(c1)).ok).toBe(true);
  });

  it('sign-out ends the session at once; an expired session is refused; sessions are not shared between students', async () => {
    const eve = await h.join('eve@example.test');
    expect((await eve.get('/api/subjects')).status).toBe(200);
    const stolen = h.student('thief@example.test'); for (const [k, v] of eve.jar) stolen.jar.set(k, v); // a copy of Eve's cookie
    expect((await stolen.get('/api/subjects')).status).toBe(200); // a stolen cookie IS a session (that is what cookies are); signing out must kill it everywhere:
    expect((await eve.signOut()).status).toBe(200);
    expect((await eve.get('/api/subjects')).status).toBe(401);
    expect((await stolen.get('/api/subjects')).status).toBe(401);
    // sign back in, then let the session expire in the database
    expect((await eve.signInWithIdp()).ok).toBe(true);
    await h.db.pool.query('UPDATE session SET "expiresAt" = now() - interval \'1 minute\' WHERE "userId" = (SELECT id FROM "user" WHERE email = $1)', ['eve@example.test']);
    expect((await eve.get('/api/subjects')).status).toBe(401);
  });

  it('only an email address is stored: no name or photo from the identity provider', async () => {
    await h.join('minimal@example.test');
    const u = (await h.db.pool.query('SELECT name, image FROM "user" WHERE email = $1', ['minimal@example.test'])).rows[0];
    expect(u.name).toBe('Student'); expect(u.image).toBeNull();
  });

  it('cross-site requests cannot act as a signed-in student (bad Origin is refused on both auth and data endpoints)', async () => {
    const s = await h.join('csrf@example.test');
    expect((await s.post('/api/subjects', { name: 'Evil' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await s.post('/api/auth/sign-out', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await s.get('/api/subjects')).status).toBe(200); // still signed in
  });

  it('pausing the pilot turns every student away with a clear message and blocks new sessions; resuming restores access', async () => {
    const p = await h.join('paused@example.test');
    await setSettingPg(h.db.pool, 'pilot_enabled', false);
    const r = await p.get('/api/subjects'); expect(r.status).toBe(503); expect(r.body.error.code).toBe('pilot_paused');
    expect((await h.student('p2@e.test').signInWithIdp((await h.codes(1))[0])).ok).toBe(false);
    await setSettingPg(h.db.pool, 'pilot_enabled', true);
    expect((await p.get('/api/subjects')).status).toBe(200);
  });

  it('security headers and health checks', async () => {
    const s = h.student('hdr@example.test');
    const r = await s.get('/healthz'); expect(r.body).toEqual({ ok: true });
    expect((await s.get('/readyz')).body).toMatchObject({ ok: true });
    const any = await fetch(`${h.url}/api/session`);
    expect(any.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    expect(any.headers.get('x-content-type-options')).toBe('nosniff'); expect(any.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect((await s.get('/internal/metrics')).status).toBe(404); // not available without the operator token
  });
});
