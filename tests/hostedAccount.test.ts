import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { HostedHarness } from './hostedHarness';
import { PG_AVAILABLE } from './pgHarness';
import { startStudy, tok } from './hostedFlows';

const d = describe.skipIf(!PG_AVAILABLE);
let h: HostedHarness;
beforeAll(async () => { if (PG_AVAILABLE) h = await HostedHarness.start(); }, 60_000);
afterAll(async () => { await h?.stop(); });

d('every API route requires a signed-in student', () => {
  it('walks the route table: no route other than the documented public ones answers a signed-out request', async () => {
    const anon = h.student('nobody@example.test');
    const stack: any[] = (h.hosted.app as any)._router.stack;
    const routes: { method: string; path: string }[] = [];
    for (const l of stack) if (l.route) for (const m of Object.keys(l.route.methods)) routes.push({ method: m.toUpperCase(), path: String(l.route.path) });
    const api = routes.filter((r) => r.path.startsWith('/api/'));
    expect(api.length).toBeGreaterThan(100); // the walk really covered the application
    const PUBLIC = new Set(['GET /api/session', 'POST /api/invite/check', 'POST /api/invite/start']);
    for (const r of api) {
      if (PUBLIC.has(`${r.method} ${r.path}`) || r.path.startsWith('/api/auth/')) continue; // sign-in endpoints belong to the authentication library (covered in hostedAuth.test.ts)
      const url = r.path.replace(/:[A-Za-z]+/g, 'x');
      const resp = await anon.req(r.method, url, r.method === 'GET' ? undefined : {}, { raw: undefined });
      expect(resp.status, `${r.method} ${r.path} answered a signed-out request`).toBe(401);
    }
  });
});

d('account export and deletion', () => {
  it('the export contains everything the student made (and no secrets); another student can import the study part', async () => {
    const s = await h.join('exporter@example.test');
    const st = await startStudy(s);
    await s.post(`/api/sessions/${st.sessionId}/answer`, { questionId: st.question.id, answer: 'glucose and oxygen', clientToken: tok() });
    await s.post('/api/memory', { text: 'EXPORT-MEMORY note' });
    const c = (await s.post('/api/conversations', { mode: 'general' })).body.id; await s.post(`/api/conversations/${c}/messages`, { text: 'EXPORT-CHAT hello' });
    const ex = await s.get('/api/account/export'); expect(ex.status).toBe(200);
    expect(ex.headers.get('content-disposition')).toMatch(/attachment/);
    const t = JSON.stringify(ex.body);
    for (const needle of ['EXPORT-MEMORY', 'EXPORT-CHAT', 'Photosynthesis is the process', 'glucose and oxygen', 'exporter@example.test']) expect(t).toContain(needle);
    expect(t).not.toMatch(/token_enc|refresh_token|password|BETTER_AUTH|APP_SECRET/i);
    const other = await h.join('importer@example.test');
    const prev = (await other.post('/api/import/preview', { file: ex.body.study })).body;
    const commit = await other.post('/api/import/commit', { file: ex.body.study, selection: { subjectIds: prev.subjects.map((x: any) => x.id), memoryIds: prev.memories.map((m: any) => m.id) } });
    expect(commit.status).toBe(200);
    expect(JSON.stringify((await other.get('/api/memory')).body)).toContain('EXPORT-MEMORY');
  });

  it('deleting an account removes the student’s files and rows, signs them out everywhere, keeps cost records anonymously, and touches nobody else', async () => {
    const gone = await h.join('leaving@example.test'), stay = await h.join('staying@example.test');
    await startStudy(gone); await startStudy(stay, { subject: 'History' });
    const c = (await gone.post('/api/conversations', { mode: 'general' })).body.id; await gone.post(`/api/conversations/${c}/messages`, { text: 'bye' });
    const id = (await h.db.pool.query('SELECT id FROM "user" WHERE email = $1', ['leaving@example.test'])).rows[0].id as string;
    const dir = h.hosted.tenants.userDir(id); expect(existsSync(dir)).toBe(true);
    const another = h.student('leaving@example.test'); for (const [k, v] of gone.jar) another.jar.set(k, v); // a second device
    expect((await gone.post('/api/account/delete', { confirm: 'yes' })).status).toBe(400); // needs the exact phrase
    expect((await gone.get('/api/subjects')).status).toBe(200);
    expect((await gone.post('/api/account/delete', { confirm: 'DELETE MY ACCOUNT' })).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    for (const t of ['"user" WHERE id', 'session WHERE "userId"', 'account WHERE "userId"', 'usage_counters WHERE user_id', 'reports WHERE user_id']) expect((await h.db.pool.query(`SELECT COUNT(*)::int n FROM ${t} = $1`, [id])).rows[0].n, t).toBe(0);
    expect((await h.db.pool.query('SELECT COUNT(*)::int n FROM ai_requests WHERE user_id = $1', [id])).rows[0].n).toBe(0);
    expect((await h.db.pool.query('SELECT COUNT(*)::int n FROM ai_requests WHERE user_id IS NULL')).rows[0].n).toBeGreaterThan(0); // spend history survives without the link
    expect((await h.db.pool.query('SELECT COUNT(*)::int n FROM audit_log WHERE user_id = $1', [id])).rows[0].n).toBe(0);
    expect((await gone.get('/api/subjects')).status).toBe(401); expect((await another.get('/api/subjects')).status).toBe(401);
    expect((await gone.signInWithIdp()).ok).toBe(false); // no invitation: the account cannot be recreated
    expect(JSON.stringify((await stay.get('/api/subjects')).body)).toContain('History');
  });
});
