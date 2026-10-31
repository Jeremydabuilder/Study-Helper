/** Release-candidate checks that cross a server restart or a data correction, run in hosted mode against real PostgreSQL and real files. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HostedHarness } from './hostedHarness';
import { startStudy, tok } from './hostedFlows';
import { PG_AVAILABLE } from './pgHarness';

const d = describe.skipIf(!PG_AVAILABLE);
const PDF = PG_AVAILABLE ? readFileSync(join(process.cwd(), 'samples/absolute-value-review.pdf')) : Buffer.alloc(0);
const open: HostedHarness[] = [];
afterAll(async () => { for (const h of open) await h.stop().catch(() => {}); });

d('restart', () => {
  it('after the server restarts, the same browser session still works and homework, study answers and uploaded files are all still there', async () => {
    const h1 = await HostedHarness.start({}); open.push(h1);
    const s = await h1.join('restart@example.test');
    const study = await startStudy(s);
    const ans = (await s.post(`/api/sessions/${study.sessionId}/answer`, { questionId: study.question.id, answer: 'glucose and oxygen', clientToken: tok() })).body;
    const sub = (await s.post('/api/subjects', { name: 'Algebra' })).body.id;
    const src = (await s.post(`/api/subjects/${sub}/sources`, { title: 'WS', kind: 'teacher_instructions', text: 'Worksheet\n1. Solve for x: 2x + 3 = 11\n2. Solve x - 5 = 2' })).body.id;
    const hw = (await s.post('/api/homework', { sourceId: src })).body.id;
    const q = (await s.post(`/api/homework/${hw}/confirm`, { plan: 'new', dueDate: '2026-11-05' })).body.questions[0].id;
    await s.put(`/api/homework/questions/${q}/work`, { text: '2x + 3 = 11\n2x = 14\nx = 7' });
    const chk = (await s.post(`/api/homework/questions/${q}/check`, {})).body;
    const up = await s.req('POST', `/api/subjects/${sub}/files?filename=sheet.pdf`, undefined, { raw: PDF, contentType: 'application/pdf' });
    expect(up.status).toBe(200);
    const fileId = (await s.get(`/api/sources/${up.body.id}/review`)).body.file.id as string;
    const bytesBefore = Buffer.from(await (await fetch(`${h1.url}/api/files/${fileId}`, { headers: { cookie: [...s.jar].map(([k, v]) => `${k}=${v}`).join('; ') } })).arrayBuffer());
    expect(bytesBefore.equals(PDF)).toBe(true);
    const progBefore = (await s.get('/api/progress')).body;
    await h1.stop({ keepDb: true }); open.pop();

    const h2 = await HostedHarness.start({ db: h1.db, dir: h1.dir }); open.push(h2);
    s.h = h2; // same cookies, new process
    expect((await s.get('/api/session')).body.signedIn).toBe(true);
    const view = (await s.get(`/api/homework/${hw}`)).body;
    expect(view.questions[0].work.text).toBe('2x + 3 = 11\n2x = 14\nx = 7');
    expect(view.questions[0].lastCheck).toMatchObject({ id: chk.id, verdict: 'needs_revision', forCurrentWork: true });
    expect((await s.get('/api/progress')).body.practiceAccuracy).toEqual(progBefore.practiceAccuracy);
    expect((await s.get(`/api/sessions/${study.sessionId}`)).status).toBe(200);
    expect(ans.attemptId).toBeTruthy();
    const bytesAfter = Buffer.from(await (await fetch(`${h2.url}/api/files/${fileId}`, { headers: { cookie: [...s.jar].map(([k, v]) => `${k}=${v}`).join('; ') } })).arrayBuffer());
    expect(bytesAfter.equals(PDF)).toBe(true);
    // and the app keeps working: a new answer is accepted after the restart
    expect((await s.post('/api/homework/questions/' + q + '/help', { action: 'hint' })).status).toBe(200);
  });
});

d('corrections change the learning evidence', () => {
  it('a corrected grade changes progress and a changed source reconciles questions that depended on it', async () => {
    const h = await HostedHarness.start({}); open.push(h);
    const s = await h.join('evidence@example.test');
    // a wrong answer is graded wrong, then the student corrects the grade: progress follows
    const st = await startStudy(s);
    const a = (await s.post(`/api/sessions/${st.sessionId}/answer`, { questionId: st.question.id, answer: 'dunno', clientToken: tok() })).body;
    expect((await s.get('/api/progress')).body.practiceAccuracy).toMatchObject({ n: 1, rate: 0 });
    const fixed = await s.post(`/api/attempts/${a.attemptId}/self-grade`, { correctness: 1, note: 'I did mean the right thing' });
    expect(fixed.status).toBe(200);
    expect((await s.get('/api/progress')).body.practiceAccuracy).toMatchObject({ n: 1, rate: 1 });
    // a source changed after questions were made from it
    const sub = (await s.post('/api/subjects', { name: 'Math' })).body.id;
    const up = await s.req('POST', `/api/subjects/${sub}/files?filename=abs.pdf`, undefined, { raw: PDF, contentType: 'application/pdf' });
    const id = up.body.id as string;
    const rv = (await s.get(`/api/sources/${id}/review`)).body;
    await s.post(`/api/sources/${id}/pages/reviewed`, { pages: rv.pages.map((p: any) => p.n) });
    expect((await s.post(`/api/sources/${id}/confirm`, { acknowledgeEmptyPages: true })).status).toBe(200);
    const ex = await s.post(`/api/sources/${id}/extract`, { useOffline: true });
    expect(ex.status).toBe(200);
    const rev = (await s.get(`/api/sources/${id}/review`)).body;
    const page = rev.pages.find((p: any) => /Interval notation/i.test(p.text)) ?? rev.pages[0];
    const saved = await s.put(`/api/sources/${id}/pages/${page.n}`, { text: 'Completely different text about volcanoes and plate tectonics only.', baseRev: rev.rev });
    expect(saved.status).toBe(200);
    expect(saved.body.reconcile).toBeTruthy();
    expect(saved.body.reconcile.refsStale + saved.body.reconcile.questionsRetired + saved.body.reconcile.conceptsDowngraded).toBeGreaterThan(0);
  });
});

d('single instance', () => {
  it('a second server process on the same database refuses to start, and a restart after a clean stop works', async () => {
    const h = await HostedHarness.start({}); open.push(h);
    await expect(HostedHarness.start({ db: h.db, dir: h.dir })).rejects.toThrow(/Another Study Helper process is already using this database/);
    await h.stop({ keepDb: true }); open.pop();
    const again = await HostedHarness.start({ db: h.db, dir: h.dir }); open.push(again);
    expect((await fetch(`${again.url}/readyz`)).status).toBe(200);
  });
});

d('sample workspace reset', () => {
  it('is refused while a request still uses the sample database, works afterwards, and never touches the real workspace', async () => {
    const h = await HostedHarness.start({}); open.push(h);
    const s = await h.join('reset@example.test');
    const id = (await h.db.pool.query('SELECT id FROM "user" WHERE email = $1', ['reset@example.test'])).rows[0].id as string;
    await s.post('/api/subjects', { name: 'Real subject' });
    const busy = h.hosted.tenants.lease(id, 'demo');
    const refused = await s.post('/api/demo/reset', {});
    expect(refused.status).toBe(409); expect(refused.body.error.code).toBe('demo_busy');
    expect(busy.db.get('SELECT 1 AS n')?.n).toBe(1); // the active request's handle is still open
    busy.release();
    expect((await s.post('/api/demo/reset', {})).status).toBe(200);
    expect(JSON.stringify((await s.get('/api/subjects')).body)).toContain('Real subject');
  });
});
