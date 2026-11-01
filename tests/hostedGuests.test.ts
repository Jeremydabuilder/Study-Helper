import { afterEach, describe, expect, it } from 'vitest';
import { HostedHarness } from './hostedHarness';
import { PG_AVAILABLE } from './pgHarness';
import { backup, restore } from '../src/server/hosted/backup';
import { createTestDb } from './pgHarness';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setSettingPg } from '../src/server/hosted/pg';
const open: HostedHarness[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.stop(); });
const start = async (extra = {}) => { const h = await HostedHarness.start({ oidc: false, limits: { AUTH_GUESTS: '1' }, ...extra }); open.push(h); return h; };
describe.skipIf(!PG_AVAILABLE)('no-sign-in guest workspaces', () => {
  it('needs no invite or identity, isolates work, denies Calendar and supports export and deletion', async () => {
    const h = await start();
    const a = h.student('unused-a'); const b = h.student('unused-b');
    expect((await a.post('/api/auth/sign-in/anonymous', {})).status).toBe(200);
    expect((await b.post('/api/auth/sign-in/anonymous', {})).status).toBe(200);
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
    const a = h.student('unused');
    await setSettingPg(h.db.pool, 'signups_open', false);
    expect((await a.post('/api/auth/sign-in/anonymous', {})).status).toBeGreaterThanOrEqual(400);
    await setSettingPg(h.db.pool, 'signups_open', true);
    expect((await a.post('/api/auth/sign-in/anonymous', {})).status).toBe(200);
    expect((await h.student('second').post('/api/auth/sign-in/anonymous', {})).status).toBeGreaterThanOrEqual(400);
  });
  it('does not enable guest access on existing deployments without opting in', async () => {
    const h = await HostedHarness.start(); open.push(h);
    expect((await h.student('unused').post('/api/auth/sign-in/anonymous', {})).status).toBe(404);
  });
  it('cleans unreachable guests only after a seven-day grace, protects active work, and preserves retention in backups', async () => {
    const h = await start({ oidc: true });
    const gone = h.student('gone'); const busy = h.student('busy'); const active = h.student('active');
    for (const s of [gone, busy, active]) expect((await s.post('/api/auth/sign-in/anonymous', {})).status).toBe(200);
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
    const s = h.student('unused');
    await s.post('/api/auth/sign-in/anonymous', {});
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
