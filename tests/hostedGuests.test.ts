import { afterEach, describe, expect, it } from 'vitest';
import { HostedHarness } from './hostedHarness';
import { PG_AVAILABLE } from './pgHarness';
import { backup, restore } from '../src/server/hosted/backup';
import { createTestDb } from './pgHarness';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setSettingPg } from '../src/server/hosted/pg';
import { hashCode, normalizeCode, revokeInvites } from '../src/server/hosted/invites';
const open: HostedHarness[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.stop(); });
const start = async (extra = {}) => { const h = await HostedHarness.start({ oidc: false, limits: { AUTH_GUESTS: '1' }, ...extra }); open.push(h); return h; };
describe.skipIf(!PG_AVAILABLE)('no-sign-in guest workspaces', () => {
  it('needs an invitation but no identity, isolates work, denies Calendar and supports export and deletion', async () => {
    const h = await start();
    const a = await h.guest('unused-a'); const b = await h.guest('unused-b');
    expect((await a.get('/api/session')).body).toMatchObject({ signedIn: true, guest: true, email: null, methods: { guest: true, oidc: null, password: false } });
    const created = await a.post('/api/subjects', { name: 'PRIVATE GUEST NOTES' });
    expect(created.status).toBeLessThan(300);
    expect(JSON.stringify((await b.get('/api/subjects')).body)).not.toContain('PRIVATE GUEST NOTES');
    expect((await b.get(`/api/subjects/${created.body.id}`)).status).toBe(404);
    expect((await a.post('/api/calendar/connect', {})).status).toBe(403);
    expect((await a.get('/api/account')).body).toMatchObject({ guest: true, email: null });
    expect((await a.get('/api/account/export')).status).toBe(200);
    expect((await a.post('/api/account/delete', { confirm: 'DELETE MY ACCOUNT' })).status).toBe(200);
    expect((await a.get('/api/session')).body.signedIn).toBe(false);
    expect((await b.get('/api/session')).body.signedIn).toBe(true);
  });
  it('respects admission pause and capacity without spending an invitation', async () => {
    const h = await start({ maxUsers: 1 });
    const a = h.student('unused'); const [c1, c2] = await h.codes(2);
    await setSettingPg(h.db.pool, 'signups_open', false);
    expect((await a.enterAsGuest(c1)).ok).toBe(false);
    await setSettingPg(h.db.pool, 'signups_open', true);
    expect((await a.enterAsGuest(c1)).ok).toBe(true);
    expect((await h.student('second').enterAsGuest(c2)).ok).toBe(false); // full
    expect((await h.db.pool.query("SELECT used_at FROM invites WHERE used_at IS NOT NULL")).rowCount).toBe(1); // the refused attempts did not spend a code
  });
  it('does not enable guest access on existing deployments without opting in', async () => {
    const h = await HostedHarness.start(); open.push(h);
    expect((await h.student('unused').post('/api/auth/sign-in/anonymous', {})).status).toBe(404);
  });
  it('REFUSES direct calls with no, bad, spent, expired or revoked codes — hiding the button is not the protection', async () => {
    const h = await start();
    const direct = async (cookie?: string) => fetch(`${h.url}/api/auth/sign-in/anonymous`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.url, ...(cookie ? { cookie } : {}) }, body: '{}' });
    expect((await direct()).status).toBe(403);
    expect((await direct('sh_invite=ABCD-EFGH-JKLM-NPQR')).status).toBeGreaterThanOrEqual(400);   // well-formed but unknown
    expect((await direct('sh_invite=not-a-code')).status).toBe(403);
    const [spent, soon, revoked] = await h.codes(3);
    expect((await h.student('first').enterAsGuest(spent)).ok).toBe(true);
    { const r = await h.student('again').enterAsGuest(spent); expect([r.ok, r.status, JSON.stringify(r.body)]).toEqual([false, 400, expect.any(String)]); }                          // single use
    expect((await direct(`sh_invite=${spent}`)).status).toBeGreaterThanOrEqual(400);                // the cookie alone cannot reuse it
    await h.db.pool.query("UPDATE invites SET expires_at = $2 WHERE code_hash = $1", [hashCode(soon), new Date(h.now() - 60_000)]);
    expect((await h.student('late').enterAsGuest(soon)).ok).toBe(false);
    await revokeInvites(h.db.pool, { idPrefix: String((await h.db.pool.query('SELECT id FROM invites WHERE code_hash = $1', [hashCode(revoked)])).rows[0].id).slice(0, 8) });
    expect((await h.student('gone').enterAsGuest(revoked)).ok).toBe(false);
    expect((await h.db.pool.query('SELECT count(*)::int n FROM "user"')).rows[0].n).toBe(1);        // exactly one workspace was ever created
  });
  it('lets exactly one of many simultaneous attempts with the same code through', async () => {
    const h = await start();
    const [code] = await h.codes(1);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => h.student(`race-${i}`).enterAsGuest(code)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await h.db.pool.query('SELECT count(*)::int n FROM "user"')).rows[0].n).toBe(1);
    expect((await h.db.pool.query('SELECT count(*)::int n FROM invites WHERE used_at IS NOT NULL')).rows[0].n).toBe(1);
  });
  it('rate-limits repeated attempts and keeps the code out of URLs and logs', async () => {
    const h = await HostedHarness.start({ oidc: false, limits: { AUTH_GUESTS: '1', RATE_INVITE_PER_MIN: '5' } }); open.push(h);
    const [code] = await h.codes(1);
    const g = await h.student('g'); expect((await g.enterAsGuest(code)).ok).toBe(true);
    const logged = JSON.stringify(h.hosted.metrics.snapshot());
    expect(logged).not.toContain(normalizeCode(code));
    // the code travels in a POST body and an HttpOnly cookie, never in a URL
    const start = await fetch(`${h.url}/api/invite/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.url }, body: JSON.stringify({ code: (await h.codes(1))[0] }) });
    expect(start.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    const attempts = await Promise.all(Array.from({ length: 10 }, () => h.student('x').post('/api/invite/check', { code: 'ABCD-EFGH-JKLM-NPQR' })));
    expect(attempts.some((r) => r.status === 429)).toBe(true);
  });
  it('cleans unreachable guests only after a seven-day grace, protects active work, and preserves retention in backups', async () => {
    const h = await start({ oidc: true });
    const gone = await h.guest('gone'); const busy = await h.guest('busy'); const active = await h.guest('active');
    const account = await h.join('keep-account@example.test');
    const idOf = async (s: typeof gone) => (await s.get('/api/auth/get-session')).body.user.id as string;
    const goneId = await idOf(gone), busyId = await idOf(busy), activeId = await idOf(active);
    await gone.post('/api/subjects', { name: 'Expired work' });
    await busy.post('/api/subjects', { name: 'In flight' });
    await active.post('/api/subjects', { name: 'Still active' });
    await h.db.pool.query('UPDATE session SET "expiresAt" = $1 WHERE "userId" = ANY($2::text[])', [new Date(h.now() - 1), [goneId, busyId]]);
    await h.db.pool.query('UPDATE session SET "expiresAt" = $1 WHERE "userId" = $2', [new Date(h.now() + 30 * 86400000), activeId]);
    expect(await h.hosted.cleanupGuests()).toEqual({ deleted: 0 });
    h.clock.now += 6 * 86400000;
    expect(await h.hosted.cleanupGuests()).toEqual({ deleted: 0 });
    const dest = mkdtempSync(join(tmpdir(), 'guest-backup-'));
    const manifest = await backup({ pool: h.db.pool, tenants: h.hosted.tenants, destDir: dest, dataLabel: 'test', now: h.now, passphrase: 'test-backup-passphrase' });
    expect(manifest.tables.find(t => t.name === 'guest_expiry')?.rows).toBe(2);
    const db = await createTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'guest-restore-'));
    // Start once so Better Auth creates the matching guest-aware schema.
    const restored = await HostedHarness.start({ db, dir: dataDir, limits: { AUTH_GUESTS: '1' } }); open.push(restored);
    await restore({ pool: db.pool, dataDir, bundleDir: dest, dataLabel: 'test', passphrase: 'test-backup-passphrase' });
    expect((await db.pool.query('SELECT count(*)::int n FROM guest_expiry')).rows[0].n).toBe(2);
    const lease = h.hosted.tenants.lease(busyId, 'real');
    h.clock.now += 86400000;
    try {
      expect(await h.hosted.cleanupGuests()).toEqual({ deleted: 1 });
      expect(h.hosted.tenants.hasData(goneId)).toBe(false);
      expect(h.hosted.tenants.hasData(busyId)).toBe(true);
      expect(h.hosted.tenants.hasData(activeId)).toBe(true);
      expect((await account.get('/api/session')).body.guest).toBe(false);
    } finally { lease.release(); }
    expect(await h.hosted.cleanupGuests()).toEqual({ deleted: 1 });
    expect((await h.db.pool.query('SELECT count(*)::int n FROM guest_expiry')).rows[0].n).toBe(0);
  });

  it('keeps guest identity and data across restart even when new guest entry is disabled', async () => {
    const h = await start();
    const s = await h.guest('unused');
    await s.post('/api/subjects', { name: 'Keep across restart' });
    await h.stop({ keepDb: true }); open.splice(open.indexOf(h), 1);
    const again = await HostedHarness.start({ db: h.db, dir: h.dir, port: h.port }); open.push(again);
    const returning = again.student('unused'); returning.jar = new Map(s.jar);
    expect((await returning.get('/api/session')).body).toMatchObject({ signedIn: true, guest: true, email: null, methods: { guest: false } });
    expect(JSON.stringify((await returning.get('/api/subjects')).body)).toContain('Keep across restart');
    expect((await returning.post('/api/calendar/connect', {})).status).toBe(403);
    expect((await again.student('new').post('/api/auth/sign-in/anonymous', {})).status).toBe(404);
  });

});
