import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostedHarness } from './hostedHarness';
import { PG_AVAILABLE } from './pgHarness';

const open: HostedHarness[] = [];
afterEach(async () => { delete process.env.OPERATOR_TOKEN; for (const h of open.splice(0)) await h.stop(); });
const KEY = 'operator-key-for-tests-0123456789';
const op = (h: HostedHarness, path: string, body?: unknown, key: string | null = KEY) => fetch(`${h.url}/internal/operator${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

describe.skipIf(!PG_AVAILABLE)('operator page (no terminal needed)', () => {
  beforeEach(() => { process.env.OPERATOR_TOKEN = KEY; });
  it('does not exist without a long enough key, and refuses wrong keys with a limit on guessing', async () => {
    delete process.env.OPERATOR_TOKEN; const h = await HostedHarness.start({ oidc: false, limits: { AUTH_GUESTS: '1' } }); open.push(h);
    expect((await op(h, '/status')).status).toBe(404);
    process.env.OPERATOR_TOKEN = 'short'; expect((await op(h, '/status', undefined, 'short')).status).toBe(404);
    process.env.OPERATOR_TOKEN = KEY;
    expect((await op(h, '/status', undefined, null)).status).toBe(401);
    expect((await op(h, '/status', undefined, KEY + 'x')).status).toBe(401);
    const tries = await Promise.all(Array.from({ length: 14 }, () => op(h, '/status', undefined, 'wrong-key-wrong-key-wrong-key')));
    expect(tries.some((r) => r.status === 429)).toBe(true);
    expect((await op(h, '/status', undefined, KEY)).status).toBe(200); // an attacker's guesses cannot lock the real operator out
  });
  it('creates one-time codes that admit exactly one guest each, lists them without the codes, revokes, and flips the switches', async () => {
    const h = await HostedHarness.start({ oidc: false, limits: { AUTH_GUESTS: '1' } }); open.push(h);
    const made = await (await op(h, '/invites', { count: 3, label: 'friends', days: 7 })).json();
    expect(made.codes).toHaveLength(3);
    expect((await h.student('one').enterAsGuest(made.codes[0])).ok).toBe(true);
    expect((await h.student('again').enterAsGuest(made.codes[0])).ok).toBe(false);
    const st = await (await op(h, '/status')).json();
    expect(st).toMatchObject({ people: 1, guests: 1, switches: { pilot: true } });
    expect(JSON.stringify(st)).not.toContain(made.codes[1].replace(/-/g, '')); expect(JSON.stringify(st)).not.toContain(made.codes[1]);
    expect(st.invites.filter((i: any) => i.status === 'open')).toHaveLength(2);
    expect((await (await op(h, '/invites/revoke', { label: 'friends' })).json()).revoked).toBe(2);
    expect((await h.student('revoked').enterAsGuest(made.codes[1])).ok).toBe(false);
    expect((await op(h, '/invites', { count: 500 })).status).toBe(400);
    expect((await op(h, '/switch', { name: 'pilot', on: false })).status).toBe(200);
    const s = h.student('paused'); expect((await s.get('/api/subjects')).status).toBe(503);
    expect((await op(h, '/switch', { name: 'pilot', on: true })).status).toBe(200);
    expect((await op(h, '/switch', { name: 'ai', on: false })).status).toBe(200);
    expect((await (await op(h, '/status')).json()).switches).toEqual({ pilot: true, signups: true, ai: false });
    expect((await op(h, '/switch', { name: 'nope', on: true })).status).toBe(400);
    expect((await h.db.pool.query("SELECT count(*)::int n FROM audit_log WHERE event LIKE 'switch_%'")).rows[0].n).toBe(3);
  });
});
