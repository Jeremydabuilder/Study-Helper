import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PdfError, extractPdf, pdfWorkerCount } from '../src/server/pdf';

const ALGEBRA = readFileSync(new URL('../samples/absolute-value-review.pdf', import.meta.url));

describe('PDF extraction timeout really stops the work', () => {
  it('terminates the worker thread on timeout and frees it; later extractions still work', async () => {
    const t0 = Date.now();
    await expect(extractPdf(ALGEBRA, { timeoutMs: 150, testDelayMs: 30_000 })).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(5_000); // did not wait for the 30 s "page"
    expect(pdfWorkerCount()).toBe(0); // the thread is gone, not left running in the background
    const ok = await extractPdf(ALGEBRA);
    expect(ok.pageCount).toBe(3);
    expect(pdfWorkerCount()).toBe(0);
  });
  it('a damaged file also releases its worker', async () => {
    await expect(extractPdf(Buffer.from('%PDF-1.4 broken'))).rejects.toBeInstanceOf(PdfError);
    expect(pdfWorkerCount()).toBe(0);
  });
});

import { afterEach } from 'vitest';
import { LLMProvider, LLMRequest, LLMTransport } from '../src/ai/llm';
import { assessSupport } from '../src/core/grounding';
import { generateQuestions } from '../src/server/services/questions';
import { startServer, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });

const SOURCE = `Dust Bowl: a period in the 1930s when drought and wind erosion turned Plains farmland into dust storms.
Soil Conservation Service: created in 1935 to teach farmers methods that hold soil, such as contour plowing and crop rotation.
Taylor Grazing Act: a 1934 law that regulated grazing on public land so grass could recover.
Migration: hundreds of thousands of people left the Plains, many traveling to California looking for work.
`;
const Q = (over: any) => ({ kind: 'short_answer', prompt: 'Placeholder?', rubric: { key_points: [{ point: 'x', keywords: ['x'] }] }, hints: ['h'], worked_example: 'w', explanation: 'e', difficulty: 2, ...over });

async function setup(batches: any[][], assessor?: (u: string) => string | null) {
  let n = 0;
  const t: LLMTransport = { provider: 'fake', defaultModel: 'fake', complete: async (r: LLMRequest) => {
    if (r.user.includes('Identify up to')) return JSON.stringify({ concepts: [{ name: 'Soil Conservation Service', summary: 'Created in 1935 to teach soil-holding methods.', quotes: ['created in 1935 to teach farmers methods that hold soil'] }] });
    const a = assessor?.(r.user); if (a) return a;
    if (r.user.includes('decide whether the SOURCE PASSAGE supports')) return 'not json';
    return JSON.stringify({ questions: batches[Math.min(n++, batches.length - 1)] });
  } };
  s = await startServer({ llm: new LLMProvider(t) });
  const sub = (await s.call('POST', '/api/subjects', { name: 'History' })).body.id;
  const src = (await s.call('POST', `/api/subjects/${sub}/sources`, { title: 'Packet', text: SOURCE })).body.id;
  await s.call('POST', `/api/sources/${src}/extract`, {});
  const cid = (await s.call('GET', `/api/subjects/${sub}`)).body.concepts[0].id;
  await s.call('PATCH', `/api/concepts/${cid}`, { status: 'confirmed' });
  return { cid, db: s.rt.ctx('real').db, calls: () => n };
}

describe('a quote that exists is not the same as support', () => {
  it('the checker separates a passage that contains the answer’s key terms from one that merely exists', () => {
    const passage = 'Taylor Grazing Act: a 1934 law that regulated grazing on public land so grass could recover.';
    expect(assessSupport(passage, { kind: 'short_answer', keyPoints: [{ point: 'Regulated grazing', keywords: ['grazing', 'regulated'] }, { point: 'Let grass recover', keywords: ['grass'] }] }).support).toBe('supported');
    expect(assessSupport(passage, { kind: 'short_answer', keyPoints: [{ point: 'Photographs showed the human cost', keywords: ['photographs', 'Lange'] }, { point: 'Novel', keywords: ['Steinbeck'] }] }).support).toBe('quote_only');
  });
  const assess = (verdicts: Record<number, string>) => (u: string) => u.includes('decide whether the SOURCE PASSAGE supports') ? JSON.stringify({ items: Object.entries(verdicts).map(([index, verdict]) => ({ index: Number(index), verdict, note: `n${index}` })) }) : null;

  it('keyword overlap alone never says “supported”: without a semantic check a located quote is labelled “support not assessed”; the three states stay separate', async () => {
    const { cid, db } = await setup([[
      Q({ prompt: 'Why did the Soil Conservation Service teach contour plowing?', rubric: { key_points: [{ point: 'Holds soil', keywords: ['soil', 'hold'] }] }, source_quote: 'created in 1935 to teach farmers methods that hold soil' }),
      Q({ prompt: 'Who photographed the human cost of the Dust Bowl?', rubric: { key_points: [{ point: 'Dorothea Lange', keywords: ['Lange', 'photographs'] }] }, source_quote: 'a 1934 law that regulated grazing on public land' }),
      Q({ prompt: 'Name one effect of the Dust Bowl on families.', rubric: { key_points: [{ point: 'Left the Plains', keywords: ['migration', 'left'] }] } }),
    ]]);
    await generateQuestions(s.rt.ctx('real'), cid, { focus: 'practice' });
    const qs = db.all<any>('SELECT support_state, support_method, source_note, on_hold FROM questions ORDER BY rowid');
    expect(qs.map((q) => q.support_state)).toEqual(['located', 'located', 'none']); // never 'plausible' from keywords
    expect(qs[0].source_note).toMatch(/^Quote located.*not assessed.*only a heuristic/); expect(qs[1].source_note).toMatch(/Few of the answer’s key words appear/);
    expect(qs[2].source_note).toBe('Not tied to a passage in your material.'); expect(qs.every((q) => q.on_hold === 0)).toBe(true);
  });
  it('a batched semantic check marks plausible, holds conflicts and gaps, and held questions are never served', async () => {
    const t = new Map<string, any>();
    const { cid, db } = await setup([[
      Q({ prompt: 'Why did the Soil Conservation Service teach contour plowing?', rubric: { key_points: [{ point: 'Holds soil', keywords: ['soil', 'hold'] }] }, source_quote: 'created in 1935 to teach farmers methods that hold soil' }),
      Q({ prompt: 'Who photographed the human cost of the Dust Bowl?', rubric: { key_points: [{ point: 'Dorothea Lange', keywords: ['Lange', 'photographs'] }] }, source_quote: 'a 1934 law that regulated grazing on public land' }),
      Q({ prompt: 'What did migration look like?', rubric: { key_points: [{ point: 'Many families left for California', keywords: ['california'] }] }, source_quote: 'hundreds of thousands of people left the Plains, many traveling to California' }),
    ]], assess({ 0: 'supported', 1: 'insufficient', 2: 'contradicted' }));
    void t;
    const r = await generateQuestions(s.rt.ctx('real'), cid, { focus: 'practice' });
    const qs = db.all<any>('SELECT prompt, support_state, support_method, on_hold, hold_reason, grounding FROM questions ORDER BY rowid');
    expect(qs.map((q) => [q.support_state, q.on_hold])).toEqual([['plausible', 0], ['insufficient', 1], ['contradicted', 1]]);
    expect(qs[0]).toMatchObject({ support_method: 'semantic', grounding: 'source' }); expect(qs[1].hold_reason).toMatch(/may not say enough/); expect(qs[2].hold_reason).toMatch(/may conflict/);
    expect(r).toMatchObject({ inserted: 1, held: 2 });
    expect(db.get<any>("SELECT COUNT(*) n FROM ai_usage WHERE purpose='assess_support'").n).toBe(1); // one metered request for the whole batch, not one per question
    // held questions can never be picked, so they cannot influence a learning record
    const { pickQuestion } = await import('../src/server/services/questions');
    const picked = await pickQuestion(s.rt.ctx('real'), { conceptId: cid, purpose: 'practice', exclude: [] });
    expect(picked.prompt).toMatch(/contour plowing/);
    expect(db.get<any>("SELECT COUNT(*) n FROM attempts a JOIN questions q ON q.id=a.question_id WHERE q.on_hold=1").n).toBe(0);
  });
  it('deterministic rules catch a flipped relationship or wrong date even when no model checks, and hold the question', async () => {
    const { cid, db } = await setup([[
      Q({ prompt: 'When was the Soil Conservation Service created?', rubric: { key_points: [{ point: 'The Soil Conservation Service was created in 1934 to teach farmers methods that hold soil', keywords: ['1934'] }] }, source_quote: 'created in 1935 to teach farmers methods that hold soil' }),
      Q({ prompt: 'What happened to families?', rubric: { key_points: [{ point: 'Hundreds of thousands of people left the Plains', keywords: ['left'] }] }, source_quote: 'hundreds of thousands of people left the Plains' }),
    ]]);
    await generateQuestions(s.rt.ctx('real'), cid, { focus: 'practice' });
    const qs = db.all<any>('SELECT support_state, support_method, on_hold, hold_reason FROM questions ORDER BY rowid');
    expect(qs[0]).toMatchObject({ support_state: 'contradicted', support_method: 'rule', on_hold: 1 }); expect(qs[0].hold_reason).toMatch(/dates differ/);
    expect(qs[1]).toMatchObject({ support_state: 'located', on_hold: 0 });
  });
  it('an interpretive English question is not held for lacking a single key, and says several answers can be defensible', async () => {
    s = await startServer({ llm: new LLMProvider({ provider: 'fake', defaultModel: 'fake', complete: async (r: LLMRequest) => r.user.includes('Identify up to') ? JSON.stringify({ concepts: [{ name: 'Characterization', summary: 'How an author shows character.', quotes: [] }] }) : r.user.includes('decide whether the SOURCE') ? JSON.stringify({ items: [{ index: 0, verdict: 'insufficient', note: 'many readings' }] }) : JSON.stringify({ questions: [Q({ prompt: 'How does the author show Mara’s character?', rubric: { key_points: [{ point: 'Mara is determined because she keeps the light turning', keywords: ['determined'] }] }, source_quote: 'She wedged her shoulder against the great brass gear' })] }) } as LLMTransport) });
    const sub = (await s.call('POST', '/api/subjects', { name: 'English' })).body.id;
    const src = (await s.call('POST', `/api/subjects/${sub}/sources`, { title: 'Passage', text: 'Characterization: how an author shows who a person is.\nMara did not run for help. She wedged her shoulder against the great brass gear and pushed.\n' })).body.id;
    await s.call('POST', `/api/sources/${src}/extract`, {});
    const cid = (await s.call('GET', `/api/subjects/${sub}`)).body.concepts[0].id; await s.call('PATCH', `/api/concepts/${cid}`, { status: 'confirmed' });
    await generateQuestions(s.rt.ctx('real'), cid, { focus: 'practice' });
    const q = s.rt.ctx('real').db.get<any>('SELECT interpretive, support_state, on_hold, source_note FROM questions');
    expect(q).toMatchObject({ interpretive: 1, support_state: 'located', on_hold: 0 }); expect(q.source_note).toMatch(/several answers can be defensible/);
  });
  it('checks of the student’s material (diagnostic) reject unsupported questions and regenerate once with a strict request', async () => {
    const bad = Q({ prompt: 'Who photographed the human cost of the Dust Bowl?', rubric: { key_points: [{ point: 'Dorothea Lange', keywords: ['Lange'] }] }, source_quote: 'a 1934 law that regulated grazing on public land' });
    const good = Q({ prompt: 'What did the Soil Conservation Service teach farmers?', rubric: { key_points: [{ point: 'Holds soil', keywords: ['soil'] }] }, source_quote: 'created in 1935 to teach farmers methods that hold soil' });
    let n = 0;
    const { cid, db, calls } = await setup([[bad], [good]], (u) => (u.includes('decide whether the SOURCE PASSAGE supports') ? JSON.stringify({ items: [{ index: 0, verdict: n++ === 0 ? 'insufficient' : 'supported', note: '' }] }) : null));
    const r = await generateQuestions(s.rt.ctx('real'), cid, { focus: 'diagnostic' });
    expect(calls()).toBe(2); expect(r).toMatchObject({ inserted: 1 });
    expect(db.all<any>('SELECT support_state, on_hold FROM questions ORDER BY rowid').map((q) => [q.support_state, q.on_hold])).toEqual([['insufficient', 1], ['plausible', 0]]);
  });
  it('if regeneration is also unsupported nothing ungrounded is served and the error says why', async () => {
    const bad = Q({ prompt: 'Who photographed the human cost of the Dust Bowl?', rubric: { key_points: [{ point: 'Lange', keywords: ['Lange'] }] } });
    const { cid, db } = await setup([[bad], [bad]]);
    await expect(generateQuestions(s.rt.ctx('real'), cid, { focus: 'transfer' })).rejects.toThrow(/could not be tied to your material/);
    expect(db.get<any>('SELECT COUNT(*) n FROM questions').n).toBe(0);
  });
});

describe('a concept’s quote must mention the concept, not merely exist', () => {
  it('a real quote that does not mention the proposed concept leaves its support unconfirmed', async () => {
    const t: LLMTransport = { provider: 'fake', defaultModel: 'fake', complete: async () => JSON.stringify({ concepts: [
      { name: 'Soil Conservation Service', summary: 'Created in 1935.', quotes: ['created in 1935 to teach farmers methods that hold soil'] },
      { name: 'Dorothea Lange photographs', summary: 'Photographs of the era.', quotes: ['a 1934 law that regulated grazing on public land'] }] }) };
    s = await startServer({ llm: new LLMProvider(t) });
    const sub = (await s.call('POST', '/api/subjects', { name: 'History' })).body.id;
    const src = (await s.call('POST', `/api/subjects/${sub}/sources`, { title: 'Packet', text: SOURCE })).body.id;
    await s.call('POST', `/api/sources/${src}/extract`, {});
    const cs = (await s.call('GET', `/api/subjects/${sub}`)).body.concepts;
    expect(cs.find((c: any) => c.name === 'Soil Conservation Service').support).toBe('source');
    const weak = cs.find((c: any) => c.name === 'Dorothea Lange photographs');
    expect(weak.support).toBe('unverified'); expect(weak.supportNote).toMatch(/does not clearly mention/);
  });
});

describe('cancelling an upload stops the extraction', () => {
  it('an aborted signal terminates the worker immediately', async () => {
    const ac = new AbortController();
    const p = extractPdf(ALGEBRA, { testDelayMs: 30_000, signal: ac.signal, timeoutMs: 60_000 });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: 'failed', message: /cancelled/ });
    expect(pdfWorkerCount()).toBe(0);
    const pre = new AbortController(); pre.abort();
    await expect(extractPdf(ALGEBRA, { testDelayMs: 30_000, signal: pre.signal })).rejects.toMatchObject({ message: /cancelled/ });
    expect(pdfWorkerCount()).toBe(0);
  });
});

describe('the student can resolve held questions and report a wrong source link (the checks are fallible too)', () => {
  it('accept releases a held question; discard retires it; both are shown in the subject overview', async () => {
    const { cid, db } = await setup([[
      Q({ prompt: 'Held one?', rubric: { key_points: [{ point: 'Dorothea Lange', keywords: ['Lange'] }] }, source_quote: 'a 1934 law that regulated grazing on public land' }),
      Q({ prompt: 'Held two?', rubric: { key_points: [{ point: 'Dorothea Lange', keywords: ['Lange'] }] }, source_quote: 'a 1934 law that regulated grazing on public land' }),
      Q({ prompt: 'Fine one?', rubric: { key_points: [{ point: 'Holds soil', keywords: ['soil'] }] }, source_quote: 'created in 1935 to teach farmers methods that hold soil' }),
    ]], (u) => (u.includes('decide whether the SOURCE PASSAGE supports') ? JSON.stringify({ items: [{ index: 0, verdict: 'insufficient', note: 'x' }, { index: 1, verdict: 'contradicted', note: 'y' }, { index: 2, verdict: 'supported', note: '' }] }) : null));
    await generateQuestions(s.rt.ctx('real'), cid, { focus: 'practice' });
    const sub = db.get<any>('SELECT subject_id s FROM concepts WHERE id=?', cid).s;
    const held = (await s.call('GET', `/api/subjects/${sub}`)).body.heldQuestions;
    expect(held.map((h: any) => h.prompt).sort()).toEqual(['Held one?', 'Held two?']); expect(held[0].reason).toBeTruthy(); expect(held[0].quote).toMatch(/1934 law/);
    await s.call('POST', `/api/questions/${held.find((h: any) => h.prompt === 'Held one?').id}/resolve`, { action: 'accept' });
    await s.call('POST', `/api/questions/${held.find((h: any) => h.prompt === 'Held two?').id}/resolve`, { action: 'discard' });
    expect(db.get<any>("SELECT on_hold, support_state FROM questions WHERE prompt='Held one?'")).toMatchObject({ on_hold: 0, support_state: 'accepted' });
    expect(db.get<any>("SELECT retired_at FROM questions WHERE prompt='Held two?'").retired_at).not.toBeNull();
    expect((await s.call('GET', `/api/subjects/${sub}`)).body.heldQuestions).toHaveLength(0);
  });
  it('reporting a served question’s source link as wrong holds it and uncounts the answers already given to it', async () => {
    const { cid, db } = await setup([[Q({ prompt: 'What did the Soil Conservation Service teach?', rubric: { key_points: [{ point: 'Holds soil', keywords: ['soil'] }] }, source_quote: 'created in 1935 to teach farmers methods that hold soil' })]],
      (u) => (u.includes('decide whether the SOURCE PASSAGE supports') ? JSON.stringify({ items: [{ index: 0, verdict: 'supported', note: '' }] }) : null));
    await generateQuestions(s.rt.ctx('real'), cid, { focus: 'practice' });
    const qid = db.get<any>('SELECT id FROM questions').id;
    db.run("INSERT INTO attempts (id,session_id,question_id,concept_id,answer_text,correctness,grade_status,grade_source,created_at) VALUES ('a1',NULL,?,?,'x',1,'graded','ai',?)", qid, cid, Date.now());
    const r = await s.call('POST', `/api/questions/${qid}/report-support`, {});
    expect(r.body).toMatchObject({ held: true, attemptsUncounted: 1 });
    expect(db.get<any>('SELECT on_hold, support_method FROM questions WHERE id=?', qid)).toMatchObject({ on_hold: 1, support_method: 'student' });
    expect(db.get<any>("SELECT grade_status FROM attempts WHERE id='a1'").grade_status).toBe('uncertain'); // kept in history, no longer counted
  });
});
