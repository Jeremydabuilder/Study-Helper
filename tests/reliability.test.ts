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

async function setup(batches: any[][]) {
  let n = 0;
  const t: LLMTransport = { provider: 'fake', defaultModel: 'fake', complete: async (r: LLMRequest) => {
    if (r.user.includes('Identify up to')) return JSON.stringify({ concepts: [{ name: 'Soil Conservation Service', summary: 'Created in 1935 to teach soil-holding methods.', quotes: ['created in 1935 to teach farmers methods that hold soil'] }] });
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
  it('a real but unrelated quote is labelled unconfirmed, never as “from your material”; no quote is labelled as such', async () => {
    const { cid, db } = await setup([[
      Q({ prompt: 'Why did the Soil Conservation Service teach contour plowing?', rubric: { key_points: [{ point: 'Holds soil', keywords: ['soil', 'hold'] }] }, source_quote: 'created in 1935 to teach farmers methods that hold soil' }),
      Q({ prompt: 'Who photographed the human cost of the Dust Bowl?', rubric: { key_points: [{ point: 'Dorothea Lange', keywords: ['Lange', 'photographs'] }] }, source_quote: 'a 1934 law that regulated grazing on public land' }),
      Q({ prompt: 'Name one effect of the Dust Bowl on families.', rubric: { key_points: [{ point: 'Left the Plains', keywords: ['migration', 'left'] }] } }),
    ]]);
    await generateQuestions(s.rt.ctx('real'), cid, { focus: 'practice' });
    const qs = db.all<any>('SELECT prompt, grounding, source_note FROM questions ORDER BY rowid');
    expect(qs.map((q) => q.grounding)).toEqual(['source', 'weak', 'none']);
    expect(qs[0].source_note).toMatch(/^From your material/);
    expect(qs[1].source_note).toMatch(/does not clearly contain what the answer needs/); expect(qs[1].source_note).not.toMatch(/^From your material/);
    expect(qs[2].source_note).toBe('Not tied to a passage in your material.');
    expect(db.all<any>('SELECT support FROM question_evidence ORDER BY rowid').map((r) => r.support)).toEqual(['supported', 'quote_only']);
  });
  it('checks of the student’s material (diagnostic) reject unsupported questions and regenerate once with a strict request', async () => {
    const bad = Q({ prompt: 'Who photographed the human cost of the Dust Bowl?', rubric: { key_points: [{ point: 'Dorothea Lange', keywords: ['Lange'] }] }, source_quote: 'a 1934 law that regulated grazing on public land' });
    const good = Q({ prompt: 'What did the Soil Conservation Service teach farmers?', rubric: { key_points: [{ point: 'Holds soil', keywords: ['soil'] }] }, source_quote: 'created in 1935 to teach farmers methods that hold soil' });
    const { cid, db, calls } = await setup([[bad], [good]]);
    const r = await generateQuestions(s.rt.ctx('real'), cid, { focus: 'diagnostic' });
    expect(calls()).toBe(2); expect(r).toMatchObject({ inserted: 1 });
    expect(db.all<any>('SELECT prompt, grounding FROM questions').map((q) => q.grounding)).toEqual(['source']);
  });
  it('if regeneration is also unsupported nothing ungrounded is served and the error says why', async () => {
    const bad = Q({ prompt: 'Who photographed the human cost of the Dust Bowl?', rubric: { key_points: [{ point: 'Lange', keywords: ['Lange'] }] } });
    const { cid, db } = await setup([[bad], [bad]]);
    await expect(generateQuestions(s.rt.ctx('real'), cid, { focus: 'transfer' })).rejects.toThrow(/could not be tied to your material/);
    expect(db.get<any>('SELECT COUNT(*) n FROM questions').n).toBe(0);
  });
});
