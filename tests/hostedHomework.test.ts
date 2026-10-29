/** Homework in the hosted pilot: private per student, survives sign-out/sign-in, and no route accepts another student's identifiers. (Mocked: identity provider and AI. Real: application, PostgreSQL, SQLite files.) */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostedHarness, Student } from './hostedHarness';
import { PG_AVAILABLE } from './pgHarness';

const d = describe.skipIf(!PG_AVAILABLE);
let h: HostedHarness;
beforeAll(async () => { if (PG_AVAILABLE) h = await HostedHarness.start({}); }, 120_000);
afterAll(async () => { await h?.stop(); });

interface Mine { s: Student; sub: string; src: string; hw: string; q: string; photo: string; check: string; topic: string }
async function seed(name: string): Promise<Mine> {
  const tag = name.toUpperCase();
  const s = await h.join(`${name}@example.test`);
  const sub = (await s.post('/api/subjects', { name: `${tag}-MATH` })).body.id as string;
  const src = (await s.post(`/api/subjects/${sub}/sources`, { title: `${tag}-SHEET`, kind: 'teacher_instructions', text: `${tag}-WORKSHEET\n1. Solve for x: 2x + 3 = 11\n2. Solve x - 5 = 2` })).body.id as string;
  const photo = (await s.post(`/api/subjects/${sub}/sources`, { title: `${tag}-PHOTO`, kind: 'other', text: `${tag}-PHOTO-WORKING\nx + 1 = 2\nx = 1` })).body.id as string;
  const topic = (await s.post(`/api/subjects/${sub}/concepts`, { name: `${tag}-TOPIC`, summary: 'two-step equations' })).body.id as string;
  const hw = (await s.post('/api/homework', { sourceId: src })).body.id as string;
  const c = await s.post(`/api/homework/${hw}/confirm`, { plan: 'new', dueDate: '2026-11-05' });
  expect(c.status).toBe(200);
  const q = c.body.questions[0].id as string;
  expect((await s.put(`/api/homework/questions/${q}/work`, { text: `${tag}-MY-WORKING\n2x + 3 = 11\n2x = 14\nx = 7` })).status).toBe(200);
  const chk = (await s.post(`/api/homework/questions/${q}/check`, {})).body;
  expect((await s.post(`/api/homework/questions/${q}/help`, { action: 'hint' })).status).toBe(200);
  return { s, sub, src, hw, q, photo, check: chk.id, topic };
}

d('homework is private to each student', () => {
  it('no homework route accepts another student’s ids, nothing leaks into lists, Memory or export, and the owner’s data does not change', async () => {
    const a = await seed('alice'), b = await seed('bob');
    const before = JSON.stringify((await a.s.get(`/api/homework/${a.hw}`)).body);
    const probes: [string, string, unknown?][] = [
      ['GET', `/api/homework/${a.hw}`], ['POST', `/api/homework/${a.hw}/confirm`, { plan: 'new' }], ['PATCH', `/api/homework/${a.hw}`, { title: 'pwned' }], ['POST', `/api/homework/${a.hw}/complete`, { force: true }],
      ['POST', `/api/homework/${a.hw}/reopen`], ['POST', `/api/homework/${a.hw}/assessment`, { on: true }], ['PUT', `/api/homework/${a.hw}/rubric`, { sourceId: null }], ['POST', `/api/homework/${a.hw}/time`, { minutes: 5 }], ['DELETE', `/api/homework/${a.hw}`],
      ['PATCH', `/api/homework/questions/${a.q}`, { prompt: 'pwned' }], ['PUT', `/api/homework/questions/${a.q}/work`, { text: 'pwned' }], ['POST', `/api/homework/questions/${a.q}/work/photo`, { sourceId: b.photo }],
      ['POST', `/api/homework/questions/${a.q}/status`, { status: 'completed' }], ['POST', `/api/homework/questions/${a.q}/help`, { action: 'hint' }], ['GET', `/api/homework/questions/${a.q}/help`],
      ['POST', `/api/homework/questions/${a.q}/check`, {}], ['GET', `/api/homework/questions/${a.q}/checks`], ['GET', `/api/homework/questions/${a.q}/topics`], ['PUT', `/api/homework/questions/${a.q}/topics`, { conceptIds: [a.topic] }],
      ['POST', `/api/homework/questions/${a.q}/fresh-check`], ['POST', `/api/homework/checks/${a.check}/challenge`, { reason: 'misread_my_work' }],
    ];
    for (const [m, p, body] of probes) { const r = await b.s.req(m, p, body ?? (m === 'POST' ? {} : undefined)); expect([m, p, r.status]).toEqual([m, p, 404]); expect(JSON.stringify(r.body)).not.toMatch(/ALICE/); }
    // bob's own question with alice's source or topic ids
    expect((await b.s.post('/api/homework', { sourceId: a.src })).status).toBe(404);
    expect((await b.s.post(`/api/homework/questions/${b.q}/work/photo`, { sourceId: a.photo })).status).toBe(404);
    await b.s.put(`/api/homework/questions/${b.q}/topics`, { conceptIds: [a.topic] });
    expect((await b.s.get(`/api/homework/${b.hw}`)).body.questions[0].concepts).toEqual([]); // a foreign topic id attaches nothing
    expect((await b.s.put(`/api/homework/${b.hw}/rubric`, { sourceId: a.src })).status).toBe(404);

    for (const path of ['/api/homework', '/api/homework/next', '/api/memory', '/api/items', '/api/account/export']) {
      const r = await b.s.get(path); expect(JSON.stringify(r.body), path).not.toMatch(/ALICE/);
    }
    expect(JSON.stringify((await b.s.get('/api/account/export')).body)).toMatch(/BOB-MY-WORKING/); // the export has the student’s own homework
    expect(JSON.stringify((await a.s.get(`/api/homework/${a.hw}`)).body)).toBe(before);
  });

  it('work, help history and checks survive sign-out and sign-in; deleting the account removes them', async () => {
    const c = await seed('cara');
    await c.s.signOut();
    expect((await c.s.get(`/api/homework/${c.hw}`)).status).toBe(401);
    expect((await c.s.signInWithIdp()).ok).toBe(true);
    const v = (await c.s.get(`/api/homework/${c.hw}`)).body;
    expect(v.questions[0].work.text).toMatch(/CARA-MY-WORKING/); expect(v.questions[0].lastCheck.verdict).toBe('needs_revision'); expect(v.questions[0].assistance.helpCount).toBe(1);
    const hist = (await c.s.get(`/api/homework/questions/${c.q}/checks`)).body.checks;
    expect(hist[0].exact.firstIncorrect).toBe(3);
    const del = await c.s.post('/api/account/delete', { confirm: 'DELETE MY ACCOUNT' });
    expect([200, 204]).toContain(del.status);
  });
});
