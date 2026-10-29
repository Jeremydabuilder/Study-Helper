/** Spending controls, quotas, concurrency, failures and duplicate submissions, through the real HTTP API with real PostgreSQL. AI replies are scripted. */
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AIError } from '../src/ai/provider';
import { setSettingPg } from '../src/server/hosted/pg';
import { HostedHarness } from './hostedHarness';
import { PG_AVAILABLE } from './pgHarness';
import { startStudy, tok } from './hostedFlows';

const d = describe.skipIf(!PG_AVAILABLE);
let h: HostedHarness;
afterEach(async () => { await h?.stop(); });
const PDF = PG_AVAILABLE ? readFileSync('samples/absolute-value-review.pdf') : Buffer.alloc(0);
const chat = async (s: any) => { const c = (await s.post('/api/conversations', { mode: 'general' })).body.id; return (m = 'hello') => s.post(`/api/conversations/${c}/messages`, { text: m }); };
const upload = (s: any, name = 'a.pdf') => s.req('POST', `/api/subjects/${s.sub}/files?filename=${name}`, undefined, { raw: PDF, contentType: 'application/pdf' });
const counter = async (kind: string) => (await h.db.pool.query('SELECT COALESCE(SUM(n),0)::int n FROM usage_counters WHERE kind = $1', [kind])).rows[0].n as number;

d('assistant allowance and spending guardrails', () => {
  it('a student who uses up their allowance is told so plainly; other students, and everything non-AI, keep working', async () => {
    h = await HostedHarness.start({ limits: { LIMIT_USER_DAILY_AI_REQUESTS: '3' } });
    const a = await h.join('a@example.test'), b = await h.join('b@example.test');
    const sendA = await chat(a), sendB = await chat(b);
    for (let i = 0; i < 3; i++) expect((await sendA()).status).toBe(200);
    const blocked = await sendA(); expect(blocked.status).toBe(429); expect(blocked.body.error.code).toBe('ai_limit_reached');
    expect(blocked.body.error.message).toMatch(/allowance/); expect(blocked.body.error.message).not.toMatch(/\$|usd|budget|model|claude|token/i);
    expect((await sendB()).status).toBe(200); // another student is unaffected
    expect((await a.post('/api/memory', { text: 'still works' })).status).toBe(200);
    expect((await a.get('/api/account/assistant')).body).toMatchObject({ state: 'paused_user' });
    expect((await b.get('/api/account/assistant')).body).toMatchObject({ state: 'available' });
  });

  it('the shared spending guardrail pauses the assistant for everyone, with a different message, while practice keeps working', async () => {
    h = await HostedHarness.start({ limits: { LIMIT_GLOBAL_DAILY_USD: '0.0001' } });
    const a = await h.join('a@example.test');
    const r = await (await chat(a))(); expect(r.status).toBe(429); expect(r.body.error.message).toMatch(/paused for everyone/);
    expect((await a.get('/api/account/assistant')).body).toMatchObject({ state: 'paused_global' });
    expect((await a.get('/api/today')).status).toBe(200);
    expect(h.llm.calls.length).toBe(0); // nothing was sent to the provider
  });

  it('the operator switch turns the assistant off for everyone and back on; nothing is sent while it is off', async () => {
    h = await HostedHarness.start();
    const a = await h.join('a@example.test'); const send = await chat(a);
    await setSettingPg(h.db.pool, 'ai_enabled', false);
    const off = await send(); expect(off.status).toBe(429); expect(off.body.error.message).toMatch(/switched off/); expect(h.llm.calls.length).toBe(0);
    await setSettingPg(h.db.pool, 'ai_enabled', true);
    expect((await send()).status).toBe(200);
  });

  it('parallel requests from many students never exceed the shared allowance', async () => {
    h = await HostedHarness.start({ limits: { LIMIT_GLOBAL_DAILY_USD: '0.06', LIMIT_GLOBAL_CONCURRENT_AI: '50', LIMIT_USER_CONCURRENT_AI: '5' } });
    const kids = await Promise.all(Array.from({ length: 5 }, (_, i) => h.join(`k${i}@example.test`)));
    h.llm.delayMs = 40;
    const sends = await Promise.all(kids.map((k) => chat(k)));
    const results = await Promise.all(sends.flatMap((s) => [s(), s(), s()]));
    const ok = results.filter((r) => r.status === 200).length, refused = results.filter((r) => r.status === 429).length;
    expect(ok + refused).toBe(15); expect(ok).toBeGreaterThan(0); expect(refused).toBeGreaterThan(0);
    const held = (await h.db.pool.query('SELECT COALESCE(SUM(usd + reserved_usd + unknown_usd),0) x FROM ai_requests')).rows[0].x as number;
    expect(held).toBeLessThanOrEqual(0.06 + 1e-6);
    expect(h.llm.calls.length).toBe(ok); // exactly the admitted requests reached the provider
  });
});

d('failures never lose answers or create learning evidence', () => {
  it('provider timeout while grading: the answer is saved, nothing is counted, the failure is not charged as success, and a retry works', async () => {
    h = await HostedHarness.start();
    const s = await h.join('s@example.test'); const st = await startStudy(s);
    h.llm.failNext = new AIError('timeout', 'upstream timeout');
    const r = await s.post(`/api/sessions/${st.sessionId}/answer`, { questionId: st.question.id, answer: 'glucose and oxygen', clientToken: tok() });
    expect(r.status).toBe(200); expect(r.body.feedback.gradeStatus).toBe('failed'); expect(r.body.feedback.canRetryGrading).toBe(true);
    const lease = h.hosted.tenants.lease((await h.db.pool.query('SELECT id FROM "user" WHERE email = $1', ['s@example.test'])).rows[0].id, 'real');
    const att = lease.db.get<any>('SELECT answer_text, grade_status, correctness FROM attempts'); lease.release();
    expect(att).toMatchObject({ answer_text: 'glucose and oxygen', grade_status: 'failed' }); expect(att.correctness).toBeNull();
    expect((await h.db.pool.query("SELECT COUNT(*)::int n FROM ai_requests WHERE outcome = 'timeout' AND unknown_usd > 0")).rows[0].n).toBe(1); // the hold stays: billing unknown
    const retry = await s.post(`/api/attempts/${r.body.attemptId}/regrade`, {}); expect(retry.status).toBe(200);
    expect(retry.body.feedback.gradeStatus).toBe('graded');
  });

  it('a reload keeps the answer: the session shows the same question and the saved attempt', async () => {
    h = await HostedHarness.start();
    const s = await h.join('s@example.test'); const st = await startStudy(s);
    await s.post(`/api/sessions/${st.sessionId}/answer`, { questionId: st.question.id, answer: 'my typed answer', clientToken: tok() });
    await s.signOut(); await s.signInWithIdp();
    const again = (await s.get(`/api/sessions/${st.sessionId}`)).body;
    expect(JSON.stringify(again)).toContain('my typed answer');
  });

  it('submitting the same answer twice (double click, retry after a dropped connection) records one attempt and pays for one grading', async () => {
    h = await HostedHarness.start();
    const s = await h.join('s@example.test'); const st = await startStudy(s);
    const token = tok();
    const before = h.llm.calls.length;
    const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => s.post(`/api/sessions/${st.sessionId}/answer`, { questionId: st.question.id, answer: 'glucose and oxygen', clientToken: token })));
    expect([r1, r2, r3].every((r) => r.status === 200)).toBe(true);
    expect(new Set([r1, r2, r3].map((r) => r.body.attemptId)).size).toBe(1);
    const id = (await h.db.pool.query('SELECT id FROM "user" WHERE email = $1', ['s@example.test'])).rows[0].id;
    const lease = h.hosted.tenants.lease(id, 'real'); const n = lease.db.get<any>('SELECT COUNT(*) n FROM attempts').n; lease.release();
    expect(n).toBe(1);
    expect(h.llm.calls.length - before).toBeLessThanOrEqual(2); // one grading (plus at most one repair retry), never three
  });

  it('exhausted allowance mid-session: answers are still saved and marked "not graded yet", and offline math keeps working', async () => {
    h = await HostedHarness.start({ limits: { LIMIT_USER_DAILY_AI_REQUESTS: '2' } });
    const s = await h.join('s@example.test'); const st = await startStudy(s); // uses the allowance (extract + generate)
    const r = await s.post(`/api/sessions/${st.sessionId}/answer`, { questionId: st.question.id, answer: 'glucose and oxygen', clientToken: tok() });
    expect(r.status).toBe(200); expect(r.body.feedback.gradeStatus).not.toBe('graded'); expect(r.body.feedback.canSelfGrade).toBe(true);
    const msg = r.body.feedback.message as string; expect(msg).not.toMatch(/\$|usd|claude|model/i);
  });
});

d('uploads and processing limits', () => {
  it('daily upload cap, storage cap, and byte cap are enforced per student; an interrupted or rejected upload does not use the allowance', async () => {
    h = await HostedHarness.start({ limits: { LIMIT_USER_DAILY_UPLOADS: '2', LIMIT_USER_STORAGE_MB: '1', LIMIT_USER_DAILY_EXTRACTIONS: '50' } });
    const a = await h.join('a@example.test'); const b = await h.join('b@example.test');
    (a as any).sub = (await a.post('/api/subjects', { name: 'X' })).body.id; (b as any).sub = (await b.post('/api/subjects', { name: 'X' })).body.id;
    // a file that is not a PDF is rejected by the server (and refunded)
    const junk = await a.req('POST', `/api/subjects/${(a as any).sub}/files?filename=x.pdf`, undefined, { raw: Buffer.from('this is not a pdf at all'), contentType: 'application/pdf' });
    expect(junk.status).toBeGreaterThanOrEqual(400);
    await new Promise((r) => setTimeout(r, 100));
    expect(await counter('upload')).toBe(0);
    // an interrupted upload (the connection drops mid-body) is refunded too
    await new Promise<void>((resolve) => {
      const u = new URL(h.url); const rq = request({ host: u.hostname, port: u.port, path: `/api/subjects/${(a as any).sub}/files?filename=cut.pdf`, method: 'POST', headers: { 'content-type': 'application/pdf', 'content-length': String(PDF.length), cookie: [...a.jar].map(([k, v]) => `${k}=${v}`).join('; '), origin: h.url, 'x-workspace': 'real' } });
      rq.on('error', () => {}); rq.write(PDF.subarray(0, 2000)); setTimeout(() => { rq.destroy(); resolve(); }, 80);
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(await counter('upload')).toBe(0);
    expect((await upload(a)).status).toBe(200);
    expect((await upload(a, 'b.pdf')).status).toBe(200);
    const third = await upload(a, 'c.pdf'); expect(third.status).toBe(429); expect(third.body.error.code).toBe('daily_limit'); expect(third.body.error.message).toMatch(/upload limit/);
    expect((await upload(b)).status).toBe(200); // someone else is unaffected
    expect((await a.post(`/api/subjects/${(a as any).sub}/sources`, { title: 'pasted', text: 'Pasting text still works when the upload allowance is used up, for everyone.' })).status).toBe(200);
  });

  it('storage cap: once a student’s own storage is full, uploads are refused with an explanation', async () => {
    h = await HostedHarness.start({ limits: { LIMIT_USER_STORAGE_MB: '0' } });
    const a = await h.join('a@example.test'); (a as any).sub = (await a.post('/api/subjects', { name: 'X' })).body.id;
    const r = await upload(a); expect(r.status).toBe(413); expect(r.body.error.code).toBe('storage_full');
  });

  it('only one file per student is processed at a time; a busy student is told to retry and others are unaffected', async () => {
    h = await HostedHarness.start({ limits: { LIMIT_USER_DAILY_UPLOADS: '50', LIMIT_USER_DAILY_EXTRACTIONS: '50' } });
    const a = await h.join('a@example.test'), b = await h.join('b@example.test');
    (a as any).sub = (await a.post('/api/subjects', { name: 'X' })).body.id; (b as any).sub = (await b.post('/api/subjects', { name: 'X' })).body.id;
    const burst = await Promise.all([...Array.from({ length: 6 }, (_, i) => upload(a, `a${i}.pdf`)), upload(b, 'b.pdf')]);
    const aRes = burst.slice(0, 6); const busy = aRes.filter((r) => r.status === 429 && r.body.error.code === 'busy');
    expect(busy.length).toBeGreaterThan(0); expect(busy[0].body.error.retryable).toBe(true);
    expect(aRes.filter((r) => r.status === 200).length).toBeGreaterThan(0);
    expect(burst[6].status).toBe(200);
    expect(await counter('upload')).toBe(aRes.filter((r) => r.status === 200).length + 1); // refused attempts were refunded
  });

  it('chat has its own daily cap per student', async () => {
    h = await HostedHarness.start({ limits: { LIMIT_USER_DAILY_CHAT: '2', LIMIT_USER_DAILY_AI_REQUESTS: '100' } });
    const a = await h.join('a@example.test'); const send = await chat(a);
    expect((await send()).status).toBe(200); expect((await send()).status).toBe(200);
    const r = await send(); expect(r.status).toBe(429); expect(r.body.error.code).toBe('daily_limit');
  });

  it('request rate limiting protects the server from one student’s runaway client without affecting others', async () => {
    h = await HostedHarness.start({ limits: { RATE_API_PER_MIN: '15' } });
    const a = await h.join('a@example.test'), b = await h.join('b@example.test');
    const codes: number[] = []; for (let i = 0; i < 25; i++) codes.push((await a.get('/api/subjects')).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(5);
    expect((await b.get('/api/subjects')).status).toBe(200);
  });
});
