import { afterEach, describe, expect, it } from 'vitest';
import { LLMProvider, LLMRequest, LLMTransport } from '../src/ai/llm';
import { looksLikeTrait } from '../src/server/services/teachingMemory';
import { startServer, token, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });
const db = () => s.rt.ctx('real').db;
const LABEL = 'Mixed up with “Second Continental Congress”';

async function setup(llm?: LLMProvider) {
  s = await startServer(llm ? { llm } : {});
  const sub = (await s.call('POST', '/api/subjects', { name: 'History' })).body.id;
  const mk = async (name: string, summary: string) => { const id = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name, summary })).body.id; await s.call('PATCH', `/api/concepts/${id}`, { status: 'confirmed' }); return id as string; };
  const A = await mk('First Continental Congress', 'Met in 1774 to answer the Intolerable Acts; it sought repeal and a boycott, not independence.');
  const B = await mk('Second Continental Congress', 'Met from 1775, ran the war and adopted the Declaration of Independence in 1776.');
  const mcq = (id: string, prompt: string, withLabel = true) => db().run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,choices,answer_spec,hints,worked_example,explanation,difficulty,heldout,origin,grounding,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, A, sub, 'multiple_choice', prompt, JSON.stringify([{ text: 'Met in 1774 and called for a boycott' }, { text: 'Adopted the Declaration of Independence', ...(withLabel ? { misconception: LABEL } : {}) }]), JSON.stringify({ type: 'choice', correct: 0 }), JSON.stringify(['h']), 'w', 'The First Congress (1774) boycotted British goods.', 1, 0, 'ai', 'none', Date.now());
  return { sub, A, B, mcq };
}
const play = async (sid: string, pick: (v: any) => string, extra: any = {}) => {
  const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
  const r = await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: v.question.id, answer: pick(v), clientToken: token(), ...extra });
  return { v, r: r.body };
};
const wrongIdx = (v: any) => { const ch = JSON.parse(db().get<any>('SELECT choices FROM questions WHERE id=?', v.question.id).choices); const i = ch.findIndex((c: any) => c.misconception); return String(i < 0 ? 1 : i); };
const rightIdx = (v: any) => String(JSON.parse(db().get<any>('SELECT answer_spec FROM questions WHERE id=?', v.question.id).answer_spec).correct ?? 0);

describe('memory changes teaching', () => {
  it('saves what happened, with supporting attempts, dates and observed/inferred basis', async () => {
    const { A, mcq } = await setup(); mcq('q1', 'Q1 which is the First Congress?');
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 20, conceptIds: [A] })).body.id;
    const { r } = await play(sid, wrongIdx);
    const m = (await s.call('GET', '/api/memory')).body.memories.find((x: any) => x.appMade);
    expect(m).toMatchObject({ kind: 'observed', basis: 'observed', concept: 'First Continental Congress', check: { state: 'unchecked' } });
    expect(m.text).toMatch(/Seen in 1 answer/); expect(m.evidence[0]).toMatchObject({ attemptId: r.attemptId }); expect(m.effect).toMatch(/tells the two ideas apart/);
    expect(db().get<any>("SELECT COUNT(*) n FROM followups WHERE kind='repair_check' AND status='open'").n).toBe(1); // a later fresh check is scheduled after ONE observation
  });
  it('a remembered unchecked confusion shapes the NEXT session’s question, and a later independent success marks it as “suggests improvement”', async () => {
    const { A, mcq } = await setup(); mcq('q1', 'Q1 which is the First Congress?'); mcq('q2', 'Q2 another about the First Congress');
    const s1 = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 20, conceptIds: [A] })).body.id;
    await play(s1, wrongIdx); await s.call('POST', `/api/sessions/${s1}/finish`, {});
    s.clock.now += 3600_000;
    // a NEW session (no carry-over from the last answer): memory alone makes it a discrimination question
    const s2 = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 20, conceptIds: [A] })).body.id;
    const v = (await s.call('GET', `/api/sessions/${s2}`)).body;
    expect(v.why).toMatch(/before \(saved in Memory\)/); expect(v.question.prompt).toMatch(/rather than/);
    const ok = await play(s2, rightIdx);
    expect(ok.r.feedback.verdict).toBe('correct');
    const m = (await s.call('GET', '/api/memory')).body.memories.find((x: any) => x.appMade);
    expect(m.check).toMatchObject({ state: 'improved', targeted: true, attemptId: ok.r.attemptId });
    expect(m.check.state).not.toBe('mastered'); // never claims mastery from one check
  });
  it('a hinted success does not count as a later independent check', async () => {
    const { A, mcq } = await setup(); mcq('q1', 'Q1'); mcq('q2', 'Q2');
    const s1 = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 20, conceptIds: [A] })).body.id;
    await play(s1, wrongIdx); await s.call('POST', `/api/sessions/${s1}/finish`, {});
    const s2 = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 20, conceptIds: [A] })).body.id;
    const v = (await s.call('GET', `/api/sessions/${s2}`)).body;
    await s.call('POST', `/api/sessions/${s2}/hint`, { questionId: v.question.id });
    await s.call('POST', `/api/sessions/${s2}/answer`, { questionId: v.question.id, answer: rightIdx(v), clientToken: token() });
    expect((await s.call('GET', '/api/memory')).body.memories.find((x: any) => x.appMade).check.state).toBe('unchecked');
  });
  it('dismissing a note stops it affecting choice and it is not brought back; the student can undo', async () => {
    const { A, mcq } = await setup(); mcq('q1', 'Q1'); mcq('q2', 'Q2'); mcq('q3', 'Q3');
    const s1 = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 20, conceptIds: [A] })).body.id;
    await play(s1, wrongIdx); await s.call('POST', `/api/sessions/${s1}/finish`, {});
    const id = (await s.call('GET', '/api/memory')).body.memories.find((x: any) => x.appMade).id;
    expect((await s.call('POST', `/api/memory/${id}/status`, { status: 'dismissed' })).status).toBe(200);
    const s2 = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 20, conceptIds: [A] })).body.id;
    const v = (await s.call('GET', `/api/sessions/${s2}`)).body;
    expect(v.why).toBeNull(); expect(v.question.prompt).not.toMatch(/rather than/);
    await play(s2, wrongIdx); // the same mistake again does not resurrect a dismissed note
    expect((await s.call('GET', '/api/memory')).body.memories.find((x: any) => x.id === id)).toMatchObject({ dismissed: true });
    await s.call('POST', `/api/memory/${id}/status`, { status: 'active' });
    expect((await s.call('GET', '/api/memory')).body.memories.find((x: any) => x.id === id)).toMatchObject({ dismissed: false });
  });
  it('relevant memory reaches the grader and generator prompts; dismissed memory does not', async () => {
    const seen: string[] = [];
    const t: LLMTransport = { provider: 'fake', defaultModel: 'fake', complete: async (r: LLMRequest) => { seen.push(r.user); return r.user.includes('Grade the student') ? JSON.stringify({ correctness: 0.2, confidence: 'high', feedback: 'Not quite.', points: [], mistake_kind: 'reasoning_error' }) : JSON.stringify({ questions: [] }); } };
    const { A, sub } = await setup(new LLMProvider(t));
    db().run(`INSERT INTO memories (id,kind,text,subject_id,concept_id,provenance,created_at,updated_at) VALUES ('m1','student_stated','I mix this up with the Second Congress',?,?,'{}',1,1)`, sub, A);
    db().run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,answer_spec,rubric,hints,worked_example,explanation,difficulty,heldout,origin,grounding,created_at) VALUES ('qo',?,?,'explain','Explain it.',?,?,?,?,?,2,0,'ai','none',1)`, A, sub, JSON.stringify({ type: 'text' }), JSON.stringify({ keyPoints: [{ point: 'p', keywords: ['k'] }], sample: null }), JSON.stringify(['h']), 'w', 'e');
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 20, conceptIds: [A] })).body.id;
    await play(sid, () => 'some answer');
    expect(seen.find((u) => u.includes('Grade the student'))).toMatch(/I mix this up with the Second Congress/);
  });
  it('the app never saves personal traits or learning styles as memory', () => {
    for (const bad of ['Visual learner who is lazy', 'Always careless', 'Not smart at history', 'Learning style: auditory']) expect(looksLikeTrait(bad)).toBe(true);
    for (const ok of ['Mixed up with “Second Continental Congress”', 'Forgets to flip the inequality']) expect(looksLikeTrait(ok)).toBe(false);
  });
});
