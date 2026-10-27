import { afterEach, describe, expect, it } from 'vitest';
import { LLMProvider, LLMRequest, LLMTransport } from '../src/ai/llm';
import { diagnose } from '../src/core/diagnosis';
import { nextAction } from '../src/core/nextAction';
import { token } from './helpers';
import { startServer, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });
const db = () => s.rt.ctx('real').db;

describe('diagnosis: six kinds, no guessing', () => {
  const base = { questionKind: 'explain', correctness: 0.3, gradeStatus: 'graded' as const };
  it('classifies from the evidence the app can see', () => {
    expect(diagnose({ ...base, idk: true })?.kind).toBe('missing_knowledge');
    expect(diagnose({ ...base, questionKind: 'math', mathTags: ['sign_error'], slipTag: true, hasWorking: true })?.kind).toBe('slip');
    expect(diagnose({ ...base, questionKind: 'math', mathTags: ['sign_error'], slipTag: true })).toMatchObject({ kind: 'unknown_cause', possible: 'slip', certainty: 'unknown' }); // no working: a guess is not a finding
    expect(diagnose({ ...base, questionKind: 'math', mathTags: ['flipped_inequality'] })?.kind).toBe('reasoning_error');
    expect(diagnose({ ...base, questionKind: 'multiple_choice', chosenMisconception: 'Mixed up with “B”', confusedWith: { id: 'b', name: 'B' } })).toMatchObject({ kind: 'concept_confusion', confusedWith: { name: 'B' } });
    expect(diagnose({ ...base, correctness: 0.5, rubricMet: 1, rubricTotal: 2 })?.kind).toBe('partial_explanation');
    expect(diagnose({ ...base, rubricMet: 0, rubricTotal: 2, correctness: 0.1 })?.kind).toBe('missing_knowledge');
    expect(diagnose({ ...base, gradeStatus: 'uncertain' })?.kind).toBe('unreliable');
    expect(diagnose({ ...base, reportedUnclear: true })?.kind).toBe('unreliable');
    expect(diagnose({ ...base, correctness: 0.9 })).toBeNull();
  });
});

describe('next action follows the evidence', () => {
  const b = { mistake: null, correctness: 1, independent: true, confidence: 3 as const, missedPoints: [], streakIndependent: 1, failuresOnConcept: 0, questionKind: 'explain', conceptName: 'X' };
  it('maps each situation to a different next step', () => {
    expect(nextAction({ ...b, mistake: 'missing_knowledge', correctness: 0, failuresOnConcept: 1 })).toMatchObject({ type: 'teach_then_practice', focus: 'simpler' });
    expect(nextAction({ ...b, mistake: 'concept_confusion', correctness: 0, failuresOnConcept: 1, confusedWith: { id: 'y', name: 'Y' } })).toMatchObject({ type: 'discriminate', focus: 'discriminate', contrast: { name: 'Y' } });
    expect(nextAction({ ...b, mistake: 'slip', correctness: 0, failuresOnConcept: 1 })).toMatchObject({ type: 'targeted_fix', focus: 'practice' });
    expect(nextAction({ ...b, mistake: 'partial_explanation', correctness: 0.5, failuresOnConcept: 1, missedPoints: ['B'] })).toMatchObject({ type: 'targeted_fix', focus: 'gap', gapPoints: ['B'] });
    expect(nextAction({ ...b, confidence: 1 })).toMatchObject({ type: 'another_application' });
    expect(nextAction({ ...b, independent: false })).toMatchObject({ type: 'another_application' }); // right with a hint is not independent success
    expect(nextAction({ ...b, streakIndependent: 2 })).toMatchObject({ type: 'move_on', closeSlot: true });
    expect(nextAction({ ...b, mistake: 'unreliable', correctness: null })).toMatchObject({ type: 'confirm_grade' });
  });
  it('a second miss does not repeat the same explanation: it simplifies, via a prerequisite when one exists', () => {
    expect(nextAction({ ...b, mistake: 'reasoning_error', correctness: 0, failuresOnConcept: 2, prerequisite: { id: 'p', name: 'P' } })).toMatchObject({ type: 'simplify', prerequisite: { name: 'P' }, alternativeRepresentation: true });
    expect(nextAction({ ...b, mistake: 'reasoning_error', correctness: 0, failuresOnConcept: 2 })).toMatchObject({ type: 'simplify', focus: 'simpler', alternativeRepresentation: true });
  });
});

const LABEL_B = 'Mixed up with “Second Continental Congress”';
async function histSetup(llm?: LLMProvider) {
  s = await startServer(llm ? { llm } : {});
  const sub = (await s.call('POST', '/api/subjects', { name: 'History' })).body.id;
  const mk = async (name: string, summary: string) => { const id = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name, summary })).body.id; await s.call('PATCH', `/api/concepts/${id}`, { status: 'confirmed' }); return id as string; };
  const A = await mk('First Continental Congress', 'Met in 1774 to respond to the Intolerable Acts; it sought repeal and a boycott of British goods, not independence.');
  const B = await mk('Second Continental Congress', 'Met from 1775 and managed the war; it created the Continental Army and adopted the Declaration of Independence in 1776.');
  const mc = (prompt: string, wrongLabel: string | null) => {
    const id = `q-${Math.random().toString(36).slice(2, 8)}`;
    db().run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,choices,answer_spec,hints,worked_example,explanation,difficulty,heldout,origin,grounding,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, A, sub, 'multiple_choice', prompt, JSON.stringify([{ text: 'Met in 1774 and called for a boycott of British goods' }, { text: 'Adopted the Declaration of Independence', ...(wrongLabel ? { misconception: wrongLabel } : {}) }]), JSON.stringify({ type: 'choice', correct: 0 }), JSON.stringify(['h']), 'w', 'The First Congress (1774) answered the Intolerable Acts with a boycott.', 1, 0, 'ai', 'none', Date.now());
    return id;
  };
  const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 20, conceptIds: [A] })).body.id;
  return { sub, A, B, mc, sid };
}
const answer = async (sid: string, ans: string, extra: any = {}) => {
  const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
  const r = await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: v.question.id, answer: ans, clientToken: token(), ...extra });
  return { view: v, r: r.body };
};

describe('ask → attempt → diagnose → follow-up (offline provider, history)', () => {
  it('a wrong choice that names the other Congress is ONE observed confusion, not yet a pattern, and the next question is a discrimination question', async () => {
    const { mc, sid } = await histSetup();
    mc('Which describes the First Continental Congress?', LABEL_B);
    const { r } = await answer(sid, '1');
    expect(r.feedback.mistake).toMatchObject({ kind: 'concept_confusion', label: LABEL_B });
    expect(r.feedback.pattern).toBeNull(); expect(r.feedback.misconception).toBeNull();
    expect(r.feedback.next).toMatchObject({ type: 'discriminate' }); expect(r.feedback.next.reason).toMatch(/Second Continental Congress/);
    expect(db().get<any>('SELECT COUNT(*) n FROM observed_mistakes').n).toBe(1); expect(db().get<any>('SELECT COUNT(*) n FROM misconceptions').n).toBe(0);
    expect(db().get<any>('SELECT mistake_kind FROM attempts').mistake_kind).toBe('concept_confusion');
    // the follow-up is written for exactly this confusion
    await s.call('POST', `/api/sessions/${sid}/next`, {});
    const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
    expect(v.question.prompt).toMatch(/First Continental Congress.*rather than.*Second Continental Congress|Second Continental Congress.*rather than.*First Continental Congress/);
    expect(v.why).toMatch(/tell them apart/);
    expect(db().get<any>('SELECT focus, contrast_id FROM questions WHERE id=?', v.question.id)).toMatchObject({ focus: 'discriminate' });
  });
  it('the same confusion on a second DIFFERENT question becomes an inferred pattern with both attempts as evidence', async () => {
    const { mc, sid } = await histSetup();
    mc('Q1: Which describes the First Continental Congress?', LABEL_B); mc('Q2: Which body first answered the Intolerable Acts?', LABEL_B);
    const one = await answer(sid, '1'); expect(one.r.feedback.pattern).toBeNull();
    await s.call('POST', `/api/sessions/${sid}/next`, {});
    // the adaptive follow-up (offline discrimination MC) also carries the same labelled distractor
    const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
    const choices = JSON.parse(db().get<any>('SELECT choices FROM questions WHERE id=?', v.question.id).choices);
    const wrong = choices.findIndex((c: any) => c.misconception);
    const two = await answer(sid, String(wrong));
    expect(two.r.feedback.pattern).toMatchObject({ count: 2 });
    const m = db().get<any>('SELECT * FROM misconceptions');
    expect(m.label).toBe(LABEL_B);
    expect(db().get<any>('SELECT COUNT(*) n FROM misconception_evidence WHERE misconception_id=?', m.id).n).toBe(2);
    // two misses in a row: do not repeat the same explanation
    expect(two.r.feedback.next).toMatchObject({ type: 'simplify' });
    expect(two.r.feedback.altRepresentation).toBe(true); expect(two.r.feedback.explanation).toMatch(/different way/);
  });
  it('two misses with a known prerequisite inserts a prerequisite check next', async () => {
    const { mc, sid, A, B } = await histSetup();
    db().run('INSERT INTO concept_prereqs (concept_id, prereq_id) VALUES (?,?)', A, B);
    mc('Q1 a', LABEL_B); mc('Q2 a', LABEL_B); mc('Q3 a', LABEL_B);
    await answer(sid, '1'); await s.call('POST', `/api/sessions/${sid}/next`, {});
    const v1 = (await s.call('GET', `/api/sessions/${sid}`)).body;
    const choices = JSON.parse(db().get<any>('SELECT choices FROM questions WHERE id=?', v1.question.id).choices);
    const r2 = await answer(sid, String(Math.max(0, choices.findIndex((c: any) => c.misconception))));
    expect(r2.r.feedback.next).toMatchObject({ type: 'simplify' }); expect(r2.r.feedback.next.reason).toMatch(/building block.*Second Continental Congress/);
    await s.call('POST', `/api/sessions/${sid}/next`, {});
    const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
    expect(v.concept.name).toBe('Second Continental Congress');
  });
  it('“I don’t know” is missing knowledge: explanation, worked example, then a fresh question', async () => {
    const { mc, sid } = await histSetup();
    mc('Q1 only', null);
    const { r } = await answer(sid, '', { idk: true });
    expect(r.feedback.mistake).toMatchObject({ kind: 'missing_knowledge' }); expect(r.feedback.next.type).toBe('teach_then_practice');
    expect(r.feedback.workedExample).toBeTruthy();
    expect(db().get<any>('SELECT COUNT(*) n FROM misconceptions').n).toBe(0); // a gap is shown by the concept's level, never as a "misconception"
  });
});

// ---- scripted AI: partial credit, gap follow-up, clarification, unclear reports
class Script implements LLMTransport {
  provider = 'fake'; defaultModel = 'fake'; seen: string[] = [];
  constructor(public h: (u: string) => string) {}
  async complete(r: LLMRequest) { this.seen.push(r.user); return this.h(r.user); }
}
const grade = (o: any) => JSON.stringify({ correctness: 0.5, confidence: 'high', feedback: 'You have the first idea; the second is missing.', points: [{ point: 'Responded to the Intolerable Acts', met: true }, { point: 'Wanted repeal, not independence', met: false }], mistake_kind: 'partial_explanation', ...o });
async function openSetup(t: Script) {
  const base = await histSetup(new LLMProvider(t));
  const id = 'q-open';
  db().run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,answer_spec,rubric,hints,worked_example,explanation,difficulty,heldout,origin,grounding,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, base.A, base.sub, 'explain',
    'Explain what the First Continental Congress did and what it wanted.', JSON.stringify({ type: 'text' }), JSON.stringify({ keyPoints: [{ point: 'Responded to the Intolerable Acts', keywords: ['intolerable'] }, { point: 'Wanted repeal, not independence', keywords: ['repeal'] }], sample: null }), JSON.stringify(['h']), 'w', 'It answered the Intolerable Acts and sought repeal, not independence.', 2, 0, 'ai', 'none', Date.now());
  return base;
}

describe('partial credit, gap follow-up, clarification and unclear reports (scripted AI)', () => {
  it('partial credit is diagnosed as a partly right explanation and the next question targets the missing idea', async () => {
    const t = new Script((u) => (u.includes('Grade the student') ? grade({}) : JSON.stringify({ questions: [{ kind: 'short_answer', prompt: 'GAP: what did the First Congress want instead of independence?', rubric: { key_points: [{ point: 'Wanted repeal, not independence', keywords: ['repeal'] }] }, hints: ['h'], worked_example: 'w', explanation: 'e', difficulty: 2 }] })));
    const { sid } = await openSetup(t);
    const { r } = await answer(sid, 'It met because of the Intolerable Acts.');
    expect(r.feedback).toMatchObject({ verdict: 'partial', mistake: { kind: 'partial_explanation' }, pattern: null });
    expect(r.feedback.next).toMatchObject({ type: 'targeted_fix' });
    await s.call('POST', `/api/sessions/${sid}/next`, {});
    const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
    expect(v.question.prompt).toMatch(/^GAP:/); expect(t.seen.some((u) => /missed these ideas: "Wanted repeal, not independence"/.test(u))).toBe(true);
  });
  it('clarification stays on this attempt: it never sends another question, and it is saved with the attempt', async () => {
    const t = new Script((u) => (u.includes('A student asks a question') ? JSON.stringify({ answer: 'It wanted the Acts repealed, which is different from independence.' }) : u.includes('Grade the student') ? grade({}) : '{}'));
    const { sid } = await openSetup(t);
    // a different unseen question that must never leak into the clarification context
    db().run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,answer_spec,rubric,hints,worked_example,explanation,difficulty,heldout,origin,grounding,created_at) SELECT 'q-held', concept_id, subject_id, 'explain', 'HELDOUT-MARKER-ZEBRA question', answer_spec, rubric, hints, worked_example, explanation, 2, 1, 'ai', 'none', created_at FROM questions WHERE id='q-open'`);
    const { r } = await answer(sid, 'It met because of the Intolerable Acts.');
    const c = await s.call('POST', `/api/attempts/${r.attemptId}/clarify`, { text: 'Why is repeal different from independence?' });
    expect(c.status).toBe(200); expect(c.body.clarifications[0]).toMatchObject({ ask: 'Why is repeal different from independence?', ai: true });
    const sent = t.seen.find((u) => u.includes('A student asks a question'))!;
    expect(sent).not.toMatch(/ZEBRA/); expect(sent).toMatch(/Explain what the First Continental Congress did/);
    expect((await s.call('GET', `/api/sessions/${sid}`)).body.clarifications).toHaveLength(1); // survives a reload, still on the same question
    for (let i = 0; i < 3; i++) await s.call('POST', `/api/attempts/${r.attemptId}/clarify`, { text: `follow up ${i}` });
    expect((await s.call('POST', `/api/attempts/${r.attemptId}/clarify`, { text: 'one too many' })).status).toBe(409);
  });
  it('without an AI provider, clarification says so and returns what is known instead of pretending', async () => {
    const { mc, sid } = await histSetup(); mc('Q', LABEL_B);
    const { r } = await answer(sid, '1');
    const c = await s.call('POST', `/api/attempts/${r.attemptId}/clarify`, { text: 'why?' });
    expect(c.body.clarifications[0]).toMatchObject({ ai: false }); expect(c.body.clarifications[0].answer).toMatch(/can’t answer free-form questions without an AI provider/);
  });
  it('clarification is closed during test mode feedback hold', async () => {
    const t = new Script((u) => (u.includes('Grade the student') ? grade({}) : '{}'));
    const { A } = await openSetup(t);
    const ex = await s.call('POST', '/api/sessions', { mode: 'exam', minutes: 10, conceptIds: [A], abandonExisting: true });
    const v = (await s.call('GET', `/api/sessions/${ex.body.id}`)).body;
    const r = await s.call('POST', `/api/sessions/${ex.body.id}/answer`, { questionId: v.question.id, answer: 'x', clientToken: token() });
    expect((await s.call('POST', `/api/attempts/${r.body.attemptId}/clarify`, { text: 'tell me the answer' })).status).toBe(409);
  });
  it('reporting a question as unclear removes it from evidence and from future practice', async () => {
    const { mc, sid, A } = await histSetup(); const q = mc('Ambiguous?', LABEL_B);
    const { r } = await answer(sid, '1');
    expect(db().get<any>('SELECT level FROM concept_state WHERE concept_id=?', A).level).toBeTruthy();
    const u = await s.call('POST', `/api/attempts/${r.attemptId}/report-unclear`, {});
    expect(u.body.feedback).toMatchObject({ gradeStatus: 'uncertain', mistake: { kind: 'unreliable' }, pattern: null });
    expect(db().get<any>('SELECT retired_at, reported_unclear FROM questions WHERE id=?', q)).toMatchObject({ reported_unclear: 1 });
    expect(db().get<any>('SELECT COUNT(*) n FROM observed_mistakes').n).toBe(0);
    expect(db().get<any>("SELECT grade_status FROM attempts WHERE id=?", r.attemptId).grade_status).toBe('uncertain'); // not counted, but kept in history
  });
});

describe('generic wrong answers are not patterns, and drilling stops after three misses', () => {
  async function mathSetup() {
    s = await startServer();
    const sub = (await s.call('POST', '/api/subjects', { name: 'Math' })).body.id;
    const c = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name: 'Absolute value equations', skillTag: 'math.abs_equation', summary: 'Two cases.' })).body.id;
    await s.call('PATCH', `/api/concepts/${c}`, { status: 'confirmed' });
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 30, conceptIds: [c] })).body.id;
    return { c, sid };
  }
  it('a wrong math answer with no identifiable cause is described honestly and never becomes a recurring pattern', async () => {
    const { sid } = await mathSetup();
    let last: any;
    for (let i = 0; i < 2; i++) { last = (await answer(sid, 'x = 98765')).r; if (i === 0) await s.call('POST', `/api/sessions/${sid}/next`, {}); }
    expect(last.feedback.mistake).toMatchObject({ kind: 'unknown_cause', label: 'Wrong answer, cause unknown', certainty: 'unknown' });
    expect(last.feedback.mistake.why).toMatch(/does not show why/); expect(last.feedback.pattern).toBeNull();
    expect(db().get<any>('SELECT COUNT(*) n FROM misconceptions').n).toBe(0);
    expect(db().get<any>('SELECT COUNT(*) n FROM observed_mistakes').n).toBe(2);
  });
  it('three misses in a row stop the drilling for that concept, say why, and do not pretend more of the same would help', async () => {
    const { sid } = await mathSetup();
    let r: any;
    for (let i = 0; i < 3; i++) { r = (await answer(sid, 'x = 98765')).r; if (i < 2) await s.call('POST', `/api/sessions/${sid}/next`, {}); }
    expect(r.feedback.next.reason).toMatch(/Three misses in a row.*moving on.*from the basics/);
    const slots = JSON.parse(db().get<any>('SELECT slots FROM sessions WHERE id=?', sid).slots);
    expect(slots.every((x: any) => x.done >= x.n)).toBe(true); // nothing left to drill on this concept
    const n = await s.call('POST', `/api/sessions/${sid}/next`, {});
    expect(n.body.phase).toBe('done');
  });
});
