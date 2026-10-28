/**
 * Memory conclusions must be earned. Clocks are injected (s.clock), so "next day" is simulated time, not real time.
 * All results here are SIMULATED learning scenarios checking the app's rules, not evidence that anyone learned anything.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, token, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });
const db = () => s.rt.ctx('real').db;
const HOURS = 3600_000;
const LABEL = (n: string) => `Mixed up with “${n}”`;

async function setup() {
  s = await startServer();
  const sub = (await s.call('POST', '/api/subjects', { name: 'History' })).body.id;
  const mk = async (name: string, summary: string) => { const id = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name, summary })).body.id; await s.call('PATCH', `/api/concepts/${id}`, { status: 'confirmed' }); return id as string; };
  const A = await mk('First Continental Congress', 'Met in 1774 to answer the Intolerable Acts; it sought repeal and a boycott, not independence.');
  const B = await mk('Second Continental Congress', 'Met from 1775, ran the war and adopted the Declaration of Independence in 1776.');
  const C = await mk('Constitutional Convention', 'Met in 1787 in Philadelphia and wrote the Constitution.');
  let n = 0;
  /** A multiple-choice question about A. wrong = the distractor's mix-up label (null = no label). contrast/tests mark it as written to test that confusion. */
  const mcq = (o: { prompt?: string; wrong?: string | null; contrast?: string | null; held?: boolean } = {}) => {
    const id = `q${++n}`;
    db().run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,choices,answer_spec,hints,worked_example,explanation,difficulty,heldout,origin,grounding,focus,contrast_id,tests_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, A, sub, 'multiple_choice', o.prompt ?? `Question ${id} about the First Congress`, JSON.stringify([{ text: 'Met in 1774 and called for a boycott' }, { text: 'Adopted the Declaration of Independence', ...(o.wrong ? { misconception: o.wrong } : {}) }]),
      JSON.stringify({ type: 'choice', correct: 0 }), JSON.stringify(['h']), 'w', 'The First Congress (1774) boycotted British goods.', 1, o.held ? 1 : 0, 'ai', 'none', o.contrast ? 'discriminate' : null, o.contrast ?? null, o.contrast ? `${A}|confusion:${o.contrast}` : null, Date.now() + n);
    return id;
  };
  return { sub, A, B, C, mcq };
}
const session = async (A: string) => (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [A], abandonExisting: true })).body.id as string;
const answer = async (sid: string, pick: 'right' | 'wrong', extra: any = {}) => {
  const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
  const row = db().get<any>('SELECT choices, answer_spec FROM questions WHERE id=?', v.question.id);
  const ch = JSON.parse(row.choices), correct = JSON.parse(row.answer_spec).correct as number;
  const wrongs = ch.map((c: any, i: number) => ({ c, i })).filter((x: any) => x.i !== correct);
  const idx = pick === 'right' ? correct : (wrongs.find((x: any) => x.c.misconception) ?? wrongs[0]).i;
  if (extra.hint) await s.call('POST', `/api/sessions/${sid}/hint`, { questionId: v.question.id });
  if (extra.reveal) await s.call('POST', `/api/sessions/${sid}/reveal`, { questionId: v.question.id });
  const r = await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: v.question.id, answer: String(idx), clientToken: token(), ...(extra.reveal ? { revealedOnly: false } : {}) });
  return { v, r: r.body };
};
const mems = async () => (await s.call('GET', '/api/memory')).body.memories.filter((m: any) => m.appMade);
/** offline comparison questions are open-ended (self-graded); these tests drive the multiple-choice discrimination questions */
const retireCompare = () => db().run("UPDATE questions SET retired_at = 1 WHERE kind = 'compare'");
const next = (sid: string) => s.call('POST', `/api/sessions/${sid}/next`, {});

describe('improvement is separate for each confusion and needs targeted, delayed evidence', () => {
  it('two different misconceptions on one concept are tracked separately; an answer that tests one does not repair the other', async () => {
    const { A, B, C, mcq } = await setup();
    mcq({ wrong: LABEL('Second Continental Congress') });
    const s1 = await session(A);
    const first = await answer(s1, 'wrong');
    // a second, different confusion on the same concept (recorded through the same code path, with its own supporting attempt)
    db().run("INSERT INTO attempts (id,session_id,question_id,concept_id,answer_text,correctness,grade_status,grade_source,created_at) VALUES ('a-c',NULL,?,?,'1',0,'graded','deterministic',?)", first.v.question.id, A, s.clock.now);
    const { recordMistakeMemory } = await import('../src/server/services/teachingMemory');
    recordMistakeMemory(s.rt.ctx('real'), { conceptId: A, attemptId: 'a-c', questionId: 'q-other', kind: 'concept_confusion', label: LABEL('Constitutional Convention'), description: 'd', confusedWith: { id: C, name: 'Constitutional Convention' }, patternFormed: false, distinctQuestions: 1 });
    expect((await mems()).map((m: any) => m.provenance.label).sort()).toEqual([LABEL('Constitutional Convention'), LABEL('Second Continental Congress')]);
    // targeted questions for each confusion
    mcq({ prompt: 'Which describes the First rather than the Second Congress?', contrast: B, wrong: LABEL('Second Continental Congress') });
    mcq({ prompt: 'Which describes the First rather than the Convention?', contrast: C, wrong: LABEL('Constitutional Convention') });
    s.clock.now += 25 * HOURS;
    const s2 = await session(A);
    const got = await answer(s2, 'right');
    const served = db().get<any>('SELECT contrast_id FROM questions WHERE id=?', got.v.question.id).contrast_id;
    expect([B, C]).toContain(served);
    const ms = await mems();
    const hit = ms.find((m: any) => m.provenance.confusedWith.id === served), other = ms.find((m: any) => m.provenance.confusedWith.id !== served);
    expect(hit.check.state).toBe('improved'); expect(hit.check.later.targeted).toBe(true);
    expect(other.check.state).toBe('unchecked'); // the unrelated confusion is NOT repaired by this answer
    expect(db().get<any>("SELECT COUNT(*) n FROM followups WHERE kind='repair_check' AND status='open'").n).toBeGreaterThan(0); // the later check on the other confusion stays open
  });

  it('immediate correction is encouraging but not a later check; next-day independent success on a different targeted question is', async () => {
    const { A, B, mcq } = await setup();
    mcq({ wrong: LABEL('Second Continental Congress') });
    const s1 = await session(A);
    const w = await answer(s1, 'wrong');
    expect(w.r.feedback.mistake).toMatchObject({ kind: 'concept_confusion', certainty: 'likely' });
    // immediate follow-up (generated discrimination question) answered correctly in the same session
    await next(s1);
    const imm = await answer(s1, 'right');
    expect(imm.r.feedback.verdict).toBe('correct');
    expect(imm.r.feedback.memoryNote).toMatch(/saved as corrected for now.*later question, on another day/);
    let m = (await mems())[0];
    expect(m.check.state).toBe('corrected_now'); expect(m.check.later).toBeUndefined();
    expect(db().get<any>("SELECT COUNT(*) n FROM followups WHERE kind='repair_check' AND status='open'").n).toBe(1); // the later review is still open
    // next day: a different, unseen question aimed at the same confusion
    retireCompare();
    s.clock.now += 25 * HOURS;
    const s2 = await session(A);
    const v = (await s.call('GET', `/api/sessions/${s2}`)).body;
    expect(v.why).toMatch(/before \(saved in Memory\)/);
    const later = await answer(s2, 'right');
    expect(later.r.feedback.memoryNote).toMatch(/later, independent answer.*suggests it improved.*not proof/);
    m = (await mems())[0];
    expect(m.check).toMatchObject({ state: 'improved', now: { targeted: true }, later: { targeted: true } });
    expect(m.check.later.attemptId).not.toBe(m.check.now.attemptId);
    expect(m.check.state).not.toBe('mastered');
    expect(db().get<any>("SELECT COUNT(*) n FROM followups WHERE kind='repair_check' AND status='open'").n).toBe(0); // closed only now
    expect(m.provenance.history.map((e: any) => e.type)).toEqual(['mistake', 'corrected_now', 'improved']); // provenance kept
    void B;
  });

  it('an unrelated correct question on the same concept does not touch the note, even a day later', async () => {
    const { A, mcq } = await setup();
    mcq({ wrong: LABEL('Second Continental Congress') });
    const s1 = await session(A); await answer(s1, 'wrong'); await s.call('POST', `/api/sessions/${s1}/finish`, {});
    mcq({ prompt: 'A plain question with no mix-up distractor', wrong: null });
    s.clock.now += 25 * HOURS;
    // test mode asks for the plain question: no targeted question is chosen by memory there
    const ex = (await s.call('POST', '/api/sessions', { mode: 'exam', minutes: 10, conceptIds: [A], abandonExisting: true })).body.id;
    const v = (await s.call('GET', `/api/sessions/${ex}`)).body;
    expect(db().get<any>('SELECT prompt, focus FROM questions WHERE id=?', v.question.id)).toMatchObject({ prompt: expect.stringMatching(/plain question/), focus: null });
    await answer(ex, 'right');
    expect((await mems())[0].check.state).toBe('unchecked');
    expect((await mems())[0].provenance.history.map((e: any) => e.type)).toEqual(['mistake']);
  });

  it('hinted or answer-seen successes never count as the later check', async () => {
    const { A, mcq } = await setup();
    mcq({ wrong: LABEL('Second Continental Congress') });
    const s1 = await session(A); await answer(s1, 'wrong'); await s.call('POST', `/api/sessions/${s1}/finish`, {});
    s.clock.now += 25 * HOURS;
    const s2 = await session(A);
    await answer(s2, 'right', { hint: true }); retireCompare(); await next(s2);
    expect((await mems())[0].check.state).toBe('unchecked');
    await answer(s2, 'right', { reveal: true });
    expect((await mems())[0].check.state).toBe('unchecked');
  });

  it('a dismissed note stays inactive: evidence and repeat mistakes do not revive it', async () => {
    const { A, mcq } = await setup();
    mcq({ wrong: LABEL('Second Continental Congress') });
    const s1 = await session(A); await answer(s1, 'wrong'); await s.call('POST', `/api/sessions/${s1}/finish`, {});
    const id = (await mems())[0].id;
    await s.call('POST', `/api/memory/${id}/status`, { status: 'dismissed' });
    mcq({ wrong: LABEL('Second Continental Congress') }); mcq({ wrong: LABEL('Second Continental Congress') });
    s.clock.now += 25 * HOURS;
    const s2 = await session(A);
    retireCompare(); await answer(s2, 'right'); retireCompare(); await next(s2); retireCompare(); await answer(s2, 'wrong');
    const m = (await mems())[0];
    expect(m).toMatchObject({ dismissed: true }); expect(m.check.state).toBe('unchecked'); expect(m.provenance.attemptIds).toHaveLength(1);
  });
});

describe('a corrected grade reverses the conclusions that depended on it, with a trail', () => {
  it('"I was actually right" on the mistaken answer withdraws the note, the observed mistake and the pattern', async () => {
    const { A, mcq } = await setup();
    mcq({ wrong: LABEL('Second Continental Congress') }); mcq({ wrong: LABEL('Second Continental Congress') });
    const s1 = await session(A);
    const a1 = await answer(s1, 'wrong'); await next(s1); const a2 = await answer(s1, 'wrong');
    expect(db().get<any>("SELECT COUNT(*) n FROM misconceptions WHERE status='active'").n).toBe(1);
    expect((await mems())[0].basis).toBe('inferred');
    await s.call('POST', `/api/attempts/${a1.r.attemptId}/self-grade`, { correctness: 1 });
    // the pattern needed two different questions; one is gone, so it is withdrawn (kept, not deleted)
    expect(db().get<any>("SELECT status, note FROM misconceptions")).toMatchObject({ status: 'dismissed', note: expect.stringMatching(/Withdrawn.*regraded/) });
    let m = (await mems())[0];
    expect(m.basis).toBe('observed'); expect(m.provenance.attemptIds).toEqual([a2.r.attemptId]);
    expect(m.provenance.history.map((e: any) => e.type)).toContain('revoked');
    expect(db().get<any>('SELECT COUNT(*) n FROM observed_mistakes').n).toBe(1);
    await s.call('POST', `/api/attempts/${a2.r.attemptId}/report-unclear`, {});
    m = (await mems())[0];
    expect(m.provenance.invalidated).toBe(true); expect(m.provenance.history.map((e: any) => e.type)).toContain('invalidated');
    expect(db().get<any>("SELECT COUNT(*) n FROM followups WHERE kind='repair_check' AND status='open'").n).toBe(0); // nothing left to re-check
    expect(db().get<any>('SELECT COUNT(*) n FROM observed_mistakes').n).toBe(0);
  });

  it('regrading the later success as missed takes the note back from “improved”', async () => {
    const { A, mcq } = await setup();
    mcq({ wrong: LABEL('Second Continental Congress') });
    const s1 = await session(A); await answer(s1, 'wrong'); await s.call('POST', `/api/sessions/${s1}/finish`, {});
    s.clock.now += 25 * HOURS;
    const s2 = await session(A);
    const ok = await answer(s2, 'right');
    expect((await mems())[0].check.state).toBe('improved');
    await s.call('POST', `/api/attempts/${ok.r.attemptId}/self-grade`, { correctness: 0 }); // the student says they actually missed it
    const m = (await mems())[0];
    expect(m.check.state).toBe('unchecked'); expect(m.check.later).toBeUndefined();
    expect(m.provenance.history.map((e: any) => e.type)).toEqual(expect.arrayContaining(['improved', 'revoked']));
    expect(db().get<any>("SELECT COUNT(*) n FROM followups WHERE kind='repair_check' AND status='open'").n).toBeGreaterThan(0); // the later check is open again
  });

  it('an uncertain answer later self-graded as missed becomes an observed mistake of unknown cause, never a confident label', async () => {
    s = await startServer();
    const sub = (await s.call('POST', '/api/subjects', { name: 'English' })).body.id;
    const c = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name: 'Claim and evidence', summary: 'Support a claim with accurate evidence.' })).body.id;
    await s.call('PATCH', `/api/concepts/${c}`, { status: 'confirmed' });
    db().run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,answer_spec,rubric,hints,worked_example,explanation,difficulty,heldout,origin,grounding,created_at) VALUES ('qe',?,?,'explain','Explain how the author shows Mara’s character.',?,?,?,?,?,2,0,'ai','none',1)`, c, sub, JSON.stringify({ type: 'text' }), JSON.stringify({ keyPoints: [{ point: 'Claim', keywords: ['determined'] }], sample: null }), JSON.stringify(['h']), 'w', 'e');
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [c] })).body.id;
    const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
    const r = (await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: v.question.id, answer: 'She keeps working through the night.', clientToken: token() })).body;
    expect(r.feedback.gradeStatus).toBe('uncertain'); expect(db().get<any>('SELECT COUNT(*) n FROM observed_mistakes').n).toBe(0);
    await s.call('POST', `/api/attempts/${r.attemptId}/self-grade`, { correctness: 0 });
    expect(db().get<any>('SELECT kind, certainty FROM observed_mistakes')).toMatchObject({ kind: 'unknown_cause', certainty: 'unknown' });
  });
});
