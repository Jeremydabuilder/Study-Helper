import { afterEach, describe, expect, it } from 'vitest';
import { NOTES, startServer, TestServer, token } from './helpers';
import { DAY } from '../src/core/time';

let s: TestServer;
afterEach(async () => { await s?.close(); });

async function setup() {
  s = await startServer();
  const sub = (await s.call('POST', '/api/subjects', { name: 'Science' })).body.id;
  const src = (await s.call('POST', `/api/subjects/${sub}/sources`, { title: 'Ch. 4 notes', kind: 'notes', text: NOTES })).body.id;
  return { sub, src };
}

describe('core learning loop (offline provider)', () => {
  it('create subject -> paste source -> extract -> confirm -> diagnostic -> answer -> resume -> due review', async () => {
    const { sub, src } = await setup();
    const ex = await s.call('POST', `/api/sources/${src}/extract`, {});
    expect(ex.status).toBe(200);
    expect(ex.body.created).toBeGreaterThanOrEqual(3);

    let ov = (await s.call('GET', `/api/subjects/${sub}`)).body;
    expect(ov.concepts.every((c: any) => c.status === 'proposed')).toBe(true); // nothing trusted until confirmed
    const photo = ov.concepts.find((c: any) => c.name === 'Photosynthesis');
    expect(photo.support).toBe('source');
    expect(photo.refs[0].label).toBe('p. 1, ¶1');
    expect(NOTES).toContain(photo.refs[0].quote);

    await s.call('POST', '/api/concepts/bulk', { ids: ov.concepts.map((c: any) => c.id), status: 'confirmed' });
    const start = await s.call('POST', '/api/sessions', { mode: 'diagnostic', subjectId: sub, minutes: 10 });
    expect(start.status).toBe(200);
    const sid = start.body.id;

    // while a session is active, a second start is refused (resume instead)
    expect((await s.call('POST', '/api/sessions', { mode: 'diagnostic', subjectId: sub, minutes: 10 })).status).toBe(409);

    let v = (await s.call('GET', `/api/sessions/${sid}`)).body;
    expect(v.phase).toBe('question');
    expect(JSON.stringify(v)).not.toMatch(/answer_spec|correct"|rubric/); // never leak the key before answering
    const firstQ = v.question.id;

    // simulate closing the app and reopening: same question, same session, from the database
    const again = (await s.call('GET', `/api/sessions/${sid}`)).body;
    expect(again.question.id).toBe(firstQ);
    expect((await s.call('GET', '/api/sessions/active')).body.active.id).toBe(sid);

    // answer the first question (a choice or a cloze/explain depending on the template)
    const answerTok = token();
    const body = v.question.choices ? { answer: '0' } : { answer: 'photosynthesis chlorophyll' };
    const r1 = await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: firstQ, ...body, clientToken: answerTok, confidence: 2 });
    expect(r1.status).toBe(200);
    // duplicate submit (double click) returns the same attempt and stores nothing new
    const r2 = await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: firstQ, ...body, clientToken: answerTok });
    expect(r2.body.duplicate).toBe(true);
    expect(r2.body.attemptId).toBe(r1.body.attemptId);
    const attemptCount = s.rt.ctx('real').db.get<any>('SELECT COUNT(*) n FROM attempts').n;
    expect(attemptCount).toBe(1);

    // resume on the feedback screen
    const fb = (await s.call('GET', `/api/sessions/${sid}`)).body;
    expect(fb.phase).toBe('feedback');
    expect(fb.feedback.counts).toBeTruthy();

    // reopen the whole app against the same files
    await s.close();
    const s2 = await startServer({ dir: s.dir, start: s.clock.now });
    const resumed = (await s2.call('GET', `/api/sessions/${sid}`)).body;
    expect(resumed.phase).toBe('feedback');
    expect(resumed.progress.answered).toBe(1);
    s = s2;

    // An uncertain grade changes nothing until the student confirms it; once confirmed it schedules a review.
    const db = s.rt.ctx('real').db;
    if (fb.feedback.canSelfGrade) {
      expect(db.get<any>('SELECT due_at FROM concept_state')?.due_at ?? null).toBeNull();
      expect((await s.call('POST', `/api/attempts/${fb.attemptId}/self-grade`, { correctness: 1 })).status).toBe(200);
    }
    const st = db.get<any>('SELECT due_at FROM concept_state');
    expect(st.due_at).toBeGreaterThan(s.clock.now);
    s.clock.now = st.due_at - 1;
    expect((await s.call('GET', '/api/today')).body.dueReviews).toBe(0);
    s.clock.now = st.due_at; // inclusive boundary
    expect((await s.call('GET', '/api/today')).body.dueReviews).toBe(1);
  });

  it('refuses to guess: no concepts -> empty state; unparseable math is not saved or graded', async () => {
    s = await startServer();
    const today = (await s.call('GET', '/api/today')).body;
    expect(today.empty).toBe('no_subjects');
    const sub = (await s.call('POST', '/api/subjects', { name: 'Math' })).body.id;
    const c = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name: 'Absolute value equations', skillTag: 'math.abs_equation' })).body.id;
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [c] })).body.id;
    const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
    const bad = await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: v.question.id, answer: 'process.exit(1)', clientToken: token() });
    expect(bad.body.unparseable).toBe(true);
    expect(s.rt.ctx('real').db.get<any>('SELECT COUNT(*) n FROM attempts').n).toBe(0);
  });
});

describe('hint-assisted vs independent evidence (end to end)', () => {
  it('a hinted correct answer is not counted as independent; an unaided one is', async () => {
    s = await startServer();
    const sub = (await s.call('POST', '/api/subjects', { name: 'Math' })).body.id;
    const c = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name: 'Linear equations', skillTag: 'math.linear_equation' })).body.id;
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 20, conceptIds: [c] })).body.id;
    const db = s.rt.ctx('real').db;
    const solve = async (hint: boolean) => {
      const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
      if (hint) expect((await s.call('POST', `/api/sessions/${sid}/hint`, { questionId: v.question.id })).body.hints).toHaveLength(1);
      const spec = JSON.parse(db.get<any>('SELECT answer_spec FROM questions WHERE id=?', v.question.id).answer_spec);
      const r = await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: v.question.id, answer: spec.answer, clientToken: token() });
      await s.call('POST', `/api/sessions/${sid}/next`, {});
      return r.body;
    };
    const r1 = await solve(true);
    expect(r1.feedback.counts).toMatch(/hint-assisted/i);
    let state = JSON.parse(db.get<any>('SELECT state FROM concept_state').state);
    expect(state.independentSuccesses).toBe(0);
    const r2 = await solve(false);
    expect(r2.feedback.counts).toMatch(/independent/i);
    state = JSON.parse(db.get<any>('SELECT state FROM concept_state').state);
    expect(state.independentSuccesses).toBe(1);
    expect(state.level).not.toBe('solid');
  });

  it('one wrong inequality direction is an observed mistake; the same mistake on a second question becomes a pattern with evidence, a repair task, and a later fresh check', async () => {
    s = await startServer();
    const sub = (await s.call('POST', '/api/subjects', { name: 'Math' })).body.id;
    const c = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name: 'Inequalities', skillTag: 'math.linear_inequality' })).body.id;
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 20, conceptIds: [c] })).body.id;
    const db = s.rt.ctx('real').db;
    let flips = 0, sawObservedOnly = false;
    for (let i = 0; i < 14 && flips < 2; i++) {
      const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
      const spec = JSON.parse(db.get<any>('SELECT answer_spec FROM questions WHERE id=?', v.question.id).answer_spec);
      const ans = String(spec.answer).replace(/<=?/, (m: string) => (m === '<=' ? '>=' : '>')).replace(/>=?(?!.*[<>])/, (m: string) => m); // flip sign
      const wrong = /</.test(spec.answer) ? spec.answer.replace('<=', '>=').replace('<', '>') : spec.answer.replace('>=', '<=').replace('>', '<');
      const r = await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: v.question.id, answer: wrong || ans, clientToken: token(), confidence: 3 });
      if (r.body.feedback?.tags?.includes('flipped_inequality')) {
        flips++;
        if (flips === 1) { // a single answer is an observation, not a pattern
          sawObservedOnly = db.get<any>('SELECT COUNT(*) n FROM observed_mistakes').n === 1 && db.get<any>('SELECT COUNT(*) n FROM misconceptions').n === 0 && r.body.feedback.pattern === null && r.body.feedback.mistake?.label;
        } else expect(r.body.feedback.pattern).toMatchObject({ count: 2 });
      }
      await s.call('POST', `/api/sessions/${sid}/next`, {});
    }
    expect(sawObservedOnly).toBeTruthy(); expect(flips).toBe(2);
    const mis = db.get<any>("SELECT * FROM misconceptions WHERE status='active'");
    expect(mis.label).toMatch(/flip/i);
    expect(db.get<any>('SELECT COUNT(*) n FROM misconception_evidence WHERE misconception_id=?', mis.id).n).toBeGreaterThan(0);
    const fu = db.all<any>("SELECT kind, earliest_at FROM followups WHERE status='open' ORDER BY kind");
    expect(fu.map((f) => f.kind)).toEqual(['repair', 'repair_check']);
    expect(fu[1].earliest_at - fu[0].earliest_at).toBe(DAY);
    const today = (await s.call('GET', '/api/today')).body;
    expect(today.plan.tasks[0].kind).toBe('repair');
  });
});

describe('workspace separation', () => {
  it('demo data and real data live in different databases', async () => {
    s = await startServer();
    const demoSubjects = (await s.call('GET', '/api/subjects', undefined, 'demo')).body;
    expect(demoSubjects.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Math', 'History']));
    expect((await s.call('GET', '/api/subjects', undefined, 'real')).body).toEqual([]);
    await s.call('POST', '/api/subjects', { name: 'Mine' }, 'real');
    expect((await s.call('GET', '/api/subjects', undefined, 'demo')).body.map((x: any) => x.name)).not.toContain('Mine');
    expect((await s.call('GET', '/api/progress', undefined, 'real')).body.delayedRecall.n).toBe(0);
    expect((await s.call('GET', '/api/progress', undefined, 'demo')).body.delayedRecall.n).toBeGreaterThan(0);
    // sample data cannot be imported into the real workspace by accident, nor real data into the sample
    const exp = (await s.call('POST', '/api/export', { sections: ['memories', 'learning'] }, 'demo')).body;
    const prev = (await s.call('POST', '/api/import/preview', { file: exp }, 'real')).body;
    expect(prev.warnings.join(' ')).toMatch(/sample/i);
    expect((await s.call('POST', '/api/import/commit', { file: exp, selection: { subjectIds: [] } }, 'demo')).status).toBe(409);
  });
  it('rejects cross-origin writes and non-JSON posts', async () => {
    s = await startServer();
    const http = await import('node:http');
    const raw = (headers: Record<string, string>, body = '{"name":"X"}') => new Promise<number>((res) => {
      const r = http.request({ host: '127.0.0.1', port: s.port, path: '/api/subjects', method: 'POST', headers: { host: `127.0.0.1:${s.port}`, ...headers } }, (m) => { m.resume(); res(m.statusCode!); });
      r.end(body);
    });
    expect(await raw({ 'content-type': 'application/json', origin: 'https://evil.example' })).toBe(403);
    expect(await raw({ 'content-type': 'text/plain' })).toBe(415);
    // body-less writes (DELETE from the UI) are fine
    const del = await new Promise<number>((res) => { const r = http.request({ host: '127.0.0.1', port: s.port, path: '/api/subjects/nope', method: 'DELETE', headers: { host: `127.0.0.1:${s.port}` } }, (m) => { m.resume(); res(m.statusCode!); }); r.end(); });
    expect(del).toBe(200);
    expect(await raw({ 'content-type': 'application/json', origin: `http://127.0.0.1:${s.port}` })).toBe(200);
  });
});
