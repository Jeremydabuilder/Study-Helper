import { afterEach, describe, expect, it } from 'vitest';
import { HostedHarness } from './hostedHarness';
import { PG_AVAILABLE } from './pgHarness';
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
});
