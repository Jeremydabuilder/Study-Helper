/**
 * SIMULATED learning scenarios. Clocks are injected (s.clock), answers are scripted, the AI is the offline template provider.
 * They check that the app's rules produce honest conclusions. They are NOT evidence that any student learned anything,
 * and they say nothing about how a real model behaves.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, token, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });
const db = () => s.rt.ctx('real').db;
const HOURS = 3600_000;
const sess = async (c: string, minutes = 20) => (await s.call('POST', '/api/sessions', { mode: 'practice', minutes, conceptIds: [c], abandonExisting: true })).body.id as string;
const cur = async (sid: string) => (await s.call('GET', `/api/sessions/${sid}`)).body;
const post = (sid: string, qid: string, answer: string, extra: object = {}) => s.call('POST', `/api/sessions/${sid}/answer`, { questionId: qid, answer, clientToken: token(), ...extra }).then((r) => r.body);

describe('history: confusion → identification → follow-up → immediate success → later independent evidence', () => {
  it('walks the whole chain and only the relevant later answer changes the memory note (simulated)', async () => {
    s = await startServer();
    const sub = (await s.call('POST', '/api/subjects', { name: 'History' })).body.id;
    const mk = async (name: string, summary: string) => { const id = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name, summary })).body.id; await s.call('PATCH', `/api/concepts/${id}`, { status: 'confirmed' }); return id as string; };
    const A = await mk('First Continental Congress', 'Met in 1774; it sought repeal of the Intolerable Acts and a boycott, not independence.');
    await mk('Second Continental Congress', 'Met from 1775, ran the war and adopted the Declaration of Independence.');
    const ins = (id: string, kind: string, spec: object, choices: object[] | null, extra: { contrast?: string; focus?: string } = {}) =>
      db().run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,choices,answer_spec,hints,worked_example,explanation,difficulty,heldout,origin,grounding,focus,contrast_id,tests_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, A, sub, kind, `Prompt ${id}`, choices && JSON.stringify(choices), JSON.stringify(spec), '["h"]', 'w', 'The First Congress (1774) boycotted British goods.', 1, 0, 'ai', 'none', extra.focus ?? null, extra.contrast ?? null, extra.contrast ? `${A}|confusion:${extra.contrast}` : null, Date.now());
    const two = (wrongLabel: string | null) => [{ text: 'Met in 1774 and called for a boycott' }, { text: 'Declared independence', ...(wrongLabel ? { misconception: wrongLabel } : {}) }];
    const B = db().get<any>("SELECT id FROM concepts WHERE name LIKE 'Second%'").id as string;
    const LABEL = 'Mixed up with “Second Continental Congress”';
    ins('q1', 'multiple_choice', { type: 'choice', correct: 0 }, two(LABEL));
    ins('q2', 'multiple_choice', { type: 'choice', correct: 0 }, two(LABEL), { contrast: B, focus: 'discriminate' });
    ins('q3', 'multiple_choice', { type: 'choice', correct: 0 }, two(LABEL), { contrast: B, focus: 'discriminate' });
    db().run("UPDATE questions SET created_at = created_at + CASE id WHEN 'q1' THEN 0 WHEN 'q2' THEN 1 ELSE 2 END");

    // 1. a confused answer is identified, with honest certainty
    const sid = await sess(A);
    let v = await cur(sid);
    expect(v.question.id).toBe('q1');
    const wrong = await post(sid, 'q1', '1');
    expect(wrong.feedback.mistake).toMatchObject({ kind: 'concept_confusion', certainty: 'likely' });
    // 2. immediate success on a follow-up: encouraging, not a lasting-improvement claim
    await s.call('POST', `/api/sessions/${sid}/next`, {});
    v = await cur(sid);
    const imm = await post(sid, v.question.id, '0');
    expect(imm.feedback.verdict).toBe('correct');
    let m = (await s.call('GET', '/api/memory')).body.memories.filter((x: any) => x.appMade)[0];
    expect(m.check.state).toBe('corrected_now');
    expect(m.check.state).not.toBe('improved');
    // 3. a later, different, unaided question on the same confusion is what moves it
    s.clock.now += 25 * HOURS;
    const sid2 = await sess(A);
    v = await cur(sid2);
    const later = await post(sid2, v.question.id, '0');
    expect(later.feedback.verdict).toBe('correct');
    m = (await s.call('GET', '/api/memory')).body.memories.filter((x: any) => x.appMade)[0];
    expect(m.check.state).toBe('improved');
    expect(m.provenance.history.map((e: any) => e.type)).toEqual(['mistake', 'corrected_now', 'improved']);
    expect(m.check.state).not.toBe('mastered');
  });
});

describe('math: a wrong answer without working is not explained away', () => {
  it('records an unknown cause, lets the student say why, and keeps that as their statement (simulated)', async () => {
    s = await startServer();
    const sub = (await s.call('POST', '/api/subjects', { name: 'Math' })).body.id;
    const c = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name: 'Absolute value equations', skillTag: 'math.abs_equation', summary: 'Two cases.' })).body.id;
    await s.call('PATCH', `/api/concepts/${c}`, { status: 'confirmed' });
    const sid = await sess(c);
    const v = await cur(sid);
    const r = await post(sid, v.question.id, 'x = 98765');
    expect(r.feedback.mistake).toMatchObject({ kind: 'unknown_cause', certainty: 'unknown' });
    const said = (await s.call('POST', `/api/attempts/${r.attemptId}/cause`, { cause: 'slip' })).body;
    expect(JSON.stringify(said)).toMatch(/You said/);
    expect(db().get<any>('SELECT self_cause FROM attempts WHERE id=?', r.attemptId).self_cause).toBe('slip');
    expect(db().get<any>('SELECT COUNT(*) n FROM misconceptions').n).toBe(0); // one self-report is never a pattern
  });
});

describe('English: an interpretive question with several defensible answers, and a corrected grade', () => {
  it('does not hold or mark a non-matching but reasonable answer as a confident error; a regrade reverses what depended on it (simulated)', async () => {
    s = await startServer();
    const sub = (await s.call('POST', '/api/subjects', { name: 'English' })).body.id;
    const c = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name: 'Character', summary: 'How an author shows character.' })).body.id;
    await s.call('PATCH', `/api/concepts/${c}`, { status: 'confirmed' });
    db().run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,answer_spec,rubric,hints,worked_example,explanation,difficulty,heldout,origin,grounding,interpretive,created_at) VALUES ('qe',?,?,'explain','What does the lighthouse suggest about Mara?',?,?,'["h"]','w','e',2,0,'ai','none',1,1)`, c, sub, JSON.stringify({ type: 'text' }), JSON.stringify({ keyPoints: [{ point: 'Isolation or duty', keywords: ['alone', 'duty'] }], sample: null }));
    const sid = await sess(c);
    const v = await cur(sid);
    expect(v.question.interpretive).toBe(true);
    const r = await post(sid, 'qe', 'The light shows she keeps hope alive for other people.');
    expect(r.feedback.gradeStatus).toBe('uncertain'); // a different reading is not declared wrong
    expect(db().get<any>('SELECT COUNT(*) n FROM observed_mistakes').n).toBe(0);
    await s.call('POST', `/api/attempts/${r.attemptId}/self-grade`, { correctness: 1 });
    expect(db().get<any>('SELECT correctness FROM attempts WHERE id=?', r.attemptId).correctness).toBe(1);
    expect(db().get<any>('SELECT COUNT(*) n FROM observed_mistakes').n).toBe(0);
  });
});
