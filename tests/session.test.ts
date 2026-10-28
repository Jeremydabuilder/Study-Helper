import { afterEach, describe, expect, it } from 'vitest';
import { token, startServer, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });
const db = () => s.rt.ctx('real').db;

async function setup() {
  s = await startServer();
  const sub = (await s.call('POST', '/api/subjects', { name: 'Math' })).body.id;
  const mk = async (name: string, skillTag: string | null, summary = '') => { const id = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name, summary, skillTag })).body.id; await s.call('PATCH', `/api/concepts/${id}`, { status: 'confirmed' }); return id as string; };
  const eq = await mk('Absolute value equations', 'math.abs_equation', 'Two cases: inside = a or inside = -a.');
  const ineq = await mk('Absolute value inequalities', 'math.abs_inequality', 'Split into an and/or statement.');
  const lin = await mk('Linear inequalities', 'math.linear_inequality', 'Flip the sign when dividing by a negative.');
  return { sub, eq, ineq, lin };
}
const view = async (sid: string) => (await s.call('GET', `/api/sessions/${sid}`)).body;
async function answerCurrent(sid: string, right: boolean) {
  const v = await view(sid);
  const spec = JSON.parse(db().get<any>('SELECT answer_spec FROM questions WHERE id=?', v.question.id).answer_spec);
  const r = await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: v.question.id, answer: right ? String(spec.answer) : 'x = 98765', clientToken: token() });
  return { v, r: r.body };
}

describe('a goal-based 20-minute session', () => {
  it('is built as open → core → check, sized from the time budget, and never starts without material', async () => {
    s = await startServer(); const sub = (await s.call('POST', '/api/subjects', { name: 'Empty' })).body.id; void sub;
    expect((await s.call('POST', '/api/sessions', { goal: 'understand', minutes: 20 })).status).toBe(409);
    await s.close();
    await setup();
    const r = await s.call('POST', '/api/sessions', { goal: 'understand', minutes: 20 });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ minutes: 20 }); expect(r.body.questions).toBeGreaterThanOrEqual(8); expect(r.body.questions).toBeLessThanOrEqual(13);
    const slots = JSON.parse(db().get<any>('SELECT slots FROM sessions WHERE id=?', r.body.id).slots);
    const phases = slots.map((x: any) => x.phase);
    expect(phases[0]).toBe('open'); expect(phases).toContain('core'); expect(phases[phases.length - 1]).toBe('check');
    expect(['open', 'core', 'check'].map((p) => phases.indexOf(p))).toEqual([...['open', 'core', 'check'].map((p) => phases.indexOf(p))].sort((a, b) => a - b));
    expect(slots.filter((x: any) => x.phase === 'check').every((x: any) => x.purpose === 'transfer')).toBe(true); // fresh independent check
    expect(db().get<any>('SELECT goal FROM sessions WHERE id=?', r.body.id).goal).toBe('understand');
  });
  it('serves questions in phase order: a quick check first, practice next, a fresh check last', async () => {
    await setup();
    const sid = (await s.call('POST', '/api/sessions', { goal: 'understand', minutes: 20 })).body.id;
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      const v = await view(sid);
      if (v.phase !== 'question') break;
      seen.push(v.purpose);
      await answerCurrent(sid, i % 3 !== 0);
      const n = await s.call('POST', `/api/sessions/${sid}/next`, {});
      if (n.body.phase === 'done') break;
    }
    expect(seen[0]).toBe('Quick check'); expect(seen[seen.length - 1]).toBe('Fresh question');
    expect(seen.indexOf('Fresh question')).toBeGreaterThan(seen.lastIndexOf('Quick check')); // follow-ups after a miss may interleave, but fresh checks come after the opening
  });
  it('the time budget is soft: it never interrupts a question, asks between questions, and “keep going” adds time', async () => {
    await setup();
    const sid = (await s.call('POST', '/api/sessions', { goal: 'understand', minutes: 5 })).body.id;
    const v0 = await view(sid); expect(v0.phase).toBe('question');
    // push the clock far past the budget WHILE a question is open: it is still answerable
    db().run('UPDATE sessions SET active_ms = ? WHERE id = ?', 10 * 60_000, sid);
    expect((await view(sid)).phase).toBe('question');
    const a = await answerCurrent(sid, true); expect(a.r.feedback).toBeTruthy();
    const next = await s.call('POST', `/api/sessions/${sid}/next`, {});
    expect(next.body.phase).toBe('time_check'); expect(next.body.usedMin).toBeGreaterThanOrEqual(10);
    const ext = await s.call('POST', `/api/sessions/${sid}/extend`, { minutes: 15 });
    expect(ext.body.plannedMinutes).toBe(20);
    expect((await view(sid)).phase).toBe('question');
  });
  it('near the end the fresh check is protected: remaining core practice is skipped so it still happens', async () => {
    await setup();
    const sid = (await s.call('POST', '/api/sessions', { goal: 'understand', minutes: 20 })).body.id;
    for (let i = 0; i < 3; i++) { await answerCurrent(sid, true); await s.call('POST', `/api/sessions/${sid}/next`, {}); }
    db().run('UPDATE sessions SET active_ms = ? WHERE id = ?', 16 * 60_000, sid); // 75%+ of 20 min
    const purposes: string[] = [];
    for (let i = 0; i < 12; i++) { const v = await view(sid); if (v.phase !== 'question') { purposes.push(v.phase); break; } purposes.push(v.purpose); if (v.purpose !== 'Fresh question' && purposes.length > 6) break; await answerCurrent(sid, true); const n = await s.call('POST', `/api/sessions/${sid}/next`, {}); if (n.body.phase === 'time_check' || n.body.phase === 'done') { purposes.push(n.body.phase); break; } }
    expect(purposes).toContain('Fresh question');
  });
});

describe('the end of the session is honest', () => {
  it('separates independent success from success after help, lists what is uncertain, gives one next action and what is checked later', async () => {
    await setup();
    const sid = (await s.call('POST', '/api/sessions', { goal: 'understand', minutes: 20 })).body.id;
    const script = [true, false, true, true, false, true, true, true];
    for (let i = 0; i < script.length; i++) { const v = await view(sid); if (v.phase !== 'question') break; await answerCurrent(sid, script[i]); const n = await s.call('POST', `/api/sessions/${sid}/next`, {}); if (n.body.phase === 'done') break; }
    const fin = (await s.call('POST', `/api/sessions/${sid}/finish`, {})).body;
    const r = fin.summary.reflection;
    expect(r.next.text).toBeTruthy(); expect(typeof r.next.text).toBe('string');
    expect(r.notes.join(' ')).toMatch(/not a prediction of a test grade/); expect(r.notes.join(' ')).toMatch(/short-term recall/);
    const all = JSON.stringify(r).toLowerCase();
    expect(all).not.toMatch(/mastered|mastery|you will (get|score)|predict(ed)? grade/);
    expect(r.later.length).toBeGreaterThan(0); expect(r.later[0].what).toMatch(/not seen/);
    // success after a miss on the same concept is NOT listed as independent evidence for that stretch
    for (const d of r.demonstrated) expect(d.text).toMatch(/on your own/);
    expect(r.demonstrated.length + r.needsWork.length + r.uncertain.length).toBeGreaterThan(0);
  });
  it('a correct answer after a hint is uncertain evidence, not independent success', async () => {
    const { eq } = await setup();
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [eq] })).body.id;
    const v = await view(sid);
    await s.call('POST', `/api/sessions/${sid}/hint`, { questionId: v.question.id });
    const spec = JSON.parse(db().get<any>('SELECT answer_spec FROM questions WHERE id=?', v.question.id).answer_spec);
    await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: v.question.id, answer: String(spec.answer), clientToken: token() });
    const r = (await s.call('POST', `/api/sessions/${sid}/finish`, {})).body.summary.reflection;
    expect(r.demonstrated).toHaveLength(0);
    expect(r.uncertain.join(' ')).toMatch(/with a hint|needs an unaided check/);
  });
});

describe('Today recommends one action with a reason and an estimated duration', () => {
  it('guides setup first', async () => {
    s = await startServer();
    expect((await s.call('GET', '/api/today')).body.recommendation).toMatchObject({ kind: 'set_up', title: expect.stringMatching(/Upload your review packet/) });
  });
  it('then recommends from evidence: unchecked concepts → understand; recent mistakes → fix them; a test soon → prepare', async () => {
    const { sub, eq } = await setup();
    let rec = (await s.call('GET', '/api/today?minutes=20')).body.recommendation;
    expect(rec).toMatchObject({ kind: 'study', goal: 'understand' }); expect(rec.reason).toMatch(/not been checked/); expect(rec.minutes).toBeGreaterThanOrEqual(5); expect(rec.minutes).toBeLessThanOrEqual(20);
    expect(rec.options.map((o: any) => o.goal)).toEqual(expect.arrayContaining(['test', 'understand', 'wrong']));
    expect(rec.options.find((o: any) => o.goal === 'wrong').available).toBe(false);
    // a recent observed mistake makes "keep getting wrong" the recommendation
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [eq] })).body.id;
    await answerCurrent(sid, false); await s.call('POST', `/api/sessions/${sid}/abandon`, {});
    rec = (await s.call('GET', '/api/today?minutes=20')).body.recommendation;
    expect(rec).toMatchObject({ kind: 'study', goal: 'wrong' }); expect(rec.reason).toMatch(/recent mistakes/);
    // a test within two weeks with topics linked wins
    const item = (await s.call('POST', '/api/items', { title: 'Unit 3 test', type: 'test', subjectId: sub, dueKind: 'date', dueDate: '2026-10-29', conceptIds: [eq] }));
    expect(item.status).toBe(200);
    rec = (await s.call('GET', '/api/today?minutes=20')).body.recommendation;
    expect(rec).toMatchObject({ goal: 'test', title: expect.stringMatching(/Prepare for Unit 3 test/) }); expect(rec.reason).toMatch(/is in 3 days|is tomorrow|is today/);
  });
  it('an active session is the recommendation, and starting from a chosen goal works without Calendar', async () => {
    await setup();
    const sid = (await s.call('POST', '/api/sessions', { goal: 'understand', minutes: 10 })).body.id;
    expect((await s.call('GET', '/api/today')).body.recommendation).toMatchObject({ kind: 'resume', sessionId: sid });
    expect((await s.call('POST', '/api/sessions', { goal: 'wrong', minutes: 10 })).status).toBe(409); // session in progress
  });
});
