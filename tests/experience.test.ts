/**
 * Experience scenarios. These use the offline provider or SCRIPTED fake AI, so they check what the APP does with a grade (count it, hold it back,
 * follow up, ask later), not how good a real model is at grading. Model quality is measured separately (npm run eval:live), which has not been run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LLMProvider, LLMRequest, LLMTransport } from '../src/ai/llm';
import { AIError } from '../src/ai/provider';
import { startServer, token, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });
const db = () => s.rt.ctx('real').db;
const HOUR = 3600_000;

class Script implements LLMTransport {
  provider = 'fake'; defaultModel = 'fake'; n = 0;
  constructor(public h: (u: string) => string | Error) {}
  async complete(r: LLMRequest) { this.n++; const o = this.h(r.user); if (o instanceof Error) throw o; return o; }
}
const grade = (o: any) => JSON.stringify({ correctness: 0.9, confidence: 'high', feedback: 'Good.', points: [], mistake_kind: 'none', ...o });

async function essay(t?: Script) {
  s = await startServer(t ? { llm: new LLMProvider(t) } : {});
  const sub = (await s.call('POST', '/api/subjects', { name: 'English' })).body.id;
  const c = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name: 'Claim and evidence', summary: 'A claim is supported by accurate evidence from the text.' })).body.id;
  await s.call('PATCH', `/api/concepts/${c}`, { status: 'confirmed' });
  const mk = (id: string, held = 0) => db().run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,answer_spec,rubric,hints,worked_example,explanation,difficulty,heldout,origin,grounding,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, c, sub, 'explain', `Explain how the author shows Mara's character (${id}).`, JSON.stringify({ type: 'text' }), JSON.stringify({ keyPoints: [{ point: 'Claim about Mara', keywords: ['determined'] }, { point: 'Evidence from the passage', keywords: ['gear'] }], sample: null }), JSON.stringify(['h']), 'w', 'A claim needs evidence.', 2, held, 'ai', 'none', Date.now() + Number(id.length));
  return { sub, c, mk };
}
const answerNow = async (sid: string, text: string) => {
  const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
  return { v, r: (await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: v.question.id, answer: text, clientToken: token() })).body };
};

describe('grading fairness is enforced by what the app counts', () => {
  it('a different wording that the grader rates high counts as independent evidence; partial credit is partial', async () => {
    const t = new Script((u) => (u.includes('Grade the student') ? (/OKAY-WORDS/.test(u) ? grade({ correctness: 0.95 }) : grade({ correctness: 0.5, mistake_kind: 'partial_explanation', points: [{ point: 'Claim about Mara', met: true }, { point: 'Evidence from the passage', met: false }] })) : '{}'));
    const { c, mk } = await essay(t); mk('q1'); mk('q2');
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [c] })).body.id;
    const a = await answerNow(sid, 'OKAY-WORDS: Mara keeps going in the storm, which tells us she will not give up.');
    expect(a.r.feedback).toMatchObject({ verdict: 'correct', gradeStatus: 'graded' }); expect(a.r.feedback.counts).toMatch(/independent evidence/);
    await s.call('POST', `/api/sessions/${sid}/next`, {});
    const b = await answerNow(sid, 'Mara is determined.');
    expect(b.r.feedback).toMatchObject({ verdict: 'partial', mistake: { kind: 'partial_explanation' } });
  });
  it('keyword stuffing and unsupported evidence never change what the app believes: a low-confidence grade is held back, not counted', async () => {
    const t = new Script((u) => (u.includes('Grade the student') ? grade({ correctness: 0.9, confidence: 'low', feedback: 'Words match, but I cannot tell whether this explains anything.' }) : '{}'));
    const { c, mk } = await essay(t); mk('q1');
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [c] })).body.id;
    const { r } = await answerNow(sid, 'determined responsible persevere brave gear pushed shoulder shows proves because');
    expect(r.feedback).toMatchObject({ gradeStatus: 'uncertain', verdict: 'unsure', canSelfGrade: true }); expect(r.feedback.counts).toMatch(/Not counted yet/);
    expect(db().get<any>('SELECT level FROM concept_state WHERE concept_id=?', c).level).not.toBe('solid');
    const st = JSON.parse(db().get<any>('SELECT state FROM concept_state WHERE concept_id=?', c).state);
    expect(st.independentSuccesses ?? 0).toBe(0);
  });
  it('the offline keyword grader can never promote a stuffed answer: it always asks the student to confirm', async () => {
    const { c, mk } = await essay(); mk('q1');
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [c] })).body.id;
    const { r } = await answerNow(sid, 'determined gear determined gear determined gear');
    expect(r.feedback.gradeStatus).not.toBe('graded'); expect(r.feedback.counts).toMatch(/Not counted yet/);
  });
});

describe('progress survives a failing request', () => {
  it('a grading outage saves the answer, counts nothing, and a retry grades exactly once', async () => {
    let down = true;
    const t = new Script((u) => (u.includes('Grade the student') ? (down ? new AIError('unavailable', 'The AI service is temporarily unavailable.') : grade({ correctness: 0.9 })) : '{}'));
    const { c, mk } = await essay(t); mk('q1');
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [c] })).body.id;
    const { r } = await answerNow(sid, 'Mara is determined: she wedged her shoulder against the gear.');
    expect(r.feedback).toMatchObject({ gradeStatus: 'failed', canRetryGrading: true });
    expect(db().get<any>('SELECT answer_text, grade_status FROM attempts').answer_text).toMatch(/wedged her shoulder/);
    down = false;
    const re = await s.call('POST', `/api/attempts/${r.attemptId}/regrade`, {});
    expect(re.body.feedback.gradeStatus).toBe('graded');
    expect(db().get<any>('SELECT COUNT(*) n FROM attempts').n).toBe(1);
  });
});

describe('a later check uses a question the student has not seen', () => {
  it('after time passes, the review is a held-back question never shown before, and it counts as a delayed unaided check', async () => {
    s = await startServer();
    const sub = (await s.call('POST', '/api/subjects', { name: 'Math' })).body.id;
    const c = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name: 'Absolute value equations', skillTag: 'math.abs_equation', summary: 'Two cases.' })).body.id;
    await s.call('PATCH', `/api/concepts/${c}`, { status: 'confirmed' });
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 20, conceptIds: [c] })).body.id;
    const solved = async (id: string) => { const v = (await s.call('GET', `/api/sessions/${id}`)).body; const spec = JSON.parse(db().get<any>('SELECT answer_spec FROM questions WHERE id=?', v.question.id).answer_spec); await s.call('POST', `/api/sessions/${id}/answer`, { questionId: v.question.id, answer: String(spec.answer), clientToken: token() }); return v.question.id as string; };
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) { seen.add(await solved(sid)); const n = await s.call('POST', `/api/sessions/${sid}/next`, {}); if (n.body.phase === 'done' || n.body.phase === 'ready_to_finish') break; }
    await s.call('POST', `/api/sessions/${sid}/finish`, {});
    const due = db().get<any>('SELECT due_at FROM concept_state WHERE concept_id=?', c).due_at;
    s.clock.now = due + HOUR;
    const rid = (await s.call('POST', '/api/sessions', { goal: 'review', minutes: 10 })).body.id;
    const v = (await s.call('GET', `/api/sessions/${rid}`)).body;
    expect(seen.has(v.question.id)).toBe(false); // never shown before
    expect(db().get<any>('SELECT heldout FROM questions WHERE id=?', v.question.id).heldout).toBe(1);
    await solved(rid);
    const last = db().get<any>('SELECT correctness, hints_used FROM attempts ORDER BY created_at DESC, rowid DESC LIMIT 1');
    expect(last).toMatchObject({ correctness: 1, hints_used: 0 });
  });
});
