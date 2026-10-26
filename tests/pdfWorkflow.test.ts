import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { LLMProvider, LLMRequest, LLMTransport } from '../src/ai/llm';
import { generateQuestions } from '../src/server/services/questions';
import { startServer, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });
const f = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url));
const HISTORY = f('samples/dust-bowl-packet.pdf'), ALGEBRA = f('samples/absolute-value-review.pdf'), SCAN = f('tests/fixtures/scanned.pdf'), PNG = f('samples/notebook-screenshot.png');

async function upload(sub: string, body: Buffer | Uint8Array | string, o: { name?: string; type?: string; path?: string } = {}) {
  const r = await fetch(`http://127.0.0.1:${s.port}${o.path ?? `/api/subjects/${sub}/files`}?filename=${encodeURIComponent(o.name ?? 'packet.pdf')}`, { method: 'POST', headers: { 'content-type': o.type ?? 'application/pdf', 'x-workspace': 'real' }, body: body as BodyInit });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const mkSubject = async (name = 'History') => (await s.call('POST', '/api/subjects', { name })).body.id as string;
const db = () => s.rt.ctx('real').db;

class Script implements LLMTransport {
  provider = 'fake'; defaultModel = 'fake'; calls: string[] = [];
  constructor(public h: (u: string) => string) {}
  async complete(r: LLMRequest) { this.calls.push(r.user); return this.h(r.user); }
}
const QUOTE = 'a huge dust storm swept the Plains and drew national attention to the crisis';
const extractReply = JSON.stringify({ concepts: [{ name: 'Black Sunday', summary: 'The April 1935 dust storm that drew national attention.', quotes: [QUOTE], prerequisites: [] }] });
const qReply = JSON.stringify({ questions: [{ kind: 'explain', prompt: 'Explain why Black Sunday mattered to the country.', rubric: { key_points: [{ point: 'National attention', keywords: ['attention'] }] }, hints: ['h1'], worked_example: 'w', explanation: 'e', difficulty: 2, source_quote: 'drew national attention to the crisis' },
  { kind: 'explain', prompt: 'What happened on April 14, 1935 on the Plains?', rubric: { key_points: [{ point: 'Dust storm', keywords: ['dust'] }] }, hints: ['h1'], worked_example: 'w', explanation: 'e', difficulty: 2 }] });

describe('upload validation', () => {
  it('rejects non-PDF/image content by its bytes, not its name or claimed type', async () => {
    s = await startServer(); const sub = await mkSubject();
    const r = await upload(sub, 'just some text pretending to be a pdf', { name: 'notes.pdf' });
    expect(r.status).toBe(415); expect(r.body.error).toMatchObject({ code: 'unsupported_type' }); expect(r.body.error.message).toMatch(/PDF.*PNG, JPEG or WebP/);
    expect((await upload(sub, Buffer.from('PK\u0003\u0004docx'), { name: 'a.docx', type: 'application/octet-stream' })).status).toBe(415);
    expect((await upload(sub, Buffer.alloc(0))).status).toBe(400);
    expect(db().get<any>('SELECT COUNT(*) n FROM sources').n).toBe(0);
  });
  it('gives a clear error for a damaged PDF and stores nothing', async () => {
    s = await startServer(); const sub = await mkSubject();
    const r = await upload(sub, f('tests/fixtures/corrupt.pdf'));
    expect(r.status).toBe(422); expect(r.body.error).toMatchObject({ code: 'pdf_corrupt' });
    expect(db().get<any>('SELECT COUNT(*) n FROM source_files').n).toBe(0);
  });
  it('enforces size limits before reading', async () => {
    s = await startServer(); const sub = await mkSubject();
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(15 * 1024 * 1024 + 10)]);
    const r = await upload(sub, big);
    expect(r.status).toBe(413); expect(r.body.error.code).toBe('file_too_large');
    const png = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(10 * 1024 * 1024 + 10)]);
    expect((await upload(sub, png, { type: 'image/png' })).status).toBe(413);
  });
  it('refuses cross-origin uploads and other content types', async () => {
    s = await startServer(); const sub = await mkSubject();
    const x = await fetch(`http://127.0.0.1:${s.port}/api/subjects/${sub}/files?filename=a.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf', origin: 'https://evil.example' }, body: HISTORY });
    expect(x.status).toBe(403);
    const t = await fetch(`http://127.0.0.1:${s.port}/api/subjects/${sub}/files?filename=a.pdf`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: HISTORY });
    expect(t.status).toBe(415);
  });
});

describe('text PDF: upload → page preview → confirm', () => {
  it('reads each page locally, keeps the original bytes separately, and builds nothing until confirmed', async () => {
    s = await startServer({ llm: new LLMProvider(new Script(() => extractReply)) }); const sub = await mkSubject();
    const up = await upload(sub, HISTORY, { name: 'Dust Bowl Packet.pdf' });
    expect(up.status).toBe(200); expect(up.body).toMatchObject({ duplicate: false, status: 'draft', pageCount: 2, method: 'pdf_text', emptyPages: [] });
    const id = up.body.id;
    const blocked = await s.call('POST', `/api/sources/${id}/extract`, {});
    expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe('not_confirmed');
    const rv = (await s.call('GET', `/api/sources/${id}/review`)).body;
    expect(rv.pages).toHaveLength(2); expect(rv.pages[1].text).toMatch(/Black Sunday/); expect(rv.pages[0].text).toMatch(/Great Plow-Up/); expect(rv.status).toBe('draft');
    // the stored original is byte-identical and served with its own type
    const file = await fetch(`http://127.0.0.1:${s.port}${rv.file.url}`);
    expect(file.headers.get('content-type')).toBe('application/pdf'); expect(Buffer.from(await file.arrayBuffer()).equals(HISTORY)).toBe(true);
    // page-aware chunk labels from the real page numbers
    const labels = db().all<any>('SELECT label FROM source_chunks WHERE source_id=? ORDER BY idx', id).map((r) => r.label);
    expect(labels.some((l) => l.startsWith('p. 1,'))).toBe(true); expect(labels.some((l) => l.startsWith('p. 2,'))).toBe(true);
    // drafts are not used for practice material
    expect((await s.call('POST', `/api/sources/${id}/confirm`, {})).body.status).toBe('confirmed');
    const ex = (await s.call('POST', `/api/sources/${id}/extract`, {})).body;
    expect(ex.created).toBe(1);
    const concept = (await s.call('GET', `/api/subjects/${sub}`)).body.concepts[0];
    expect(concept.refs[0]).toMatchObject({ label: expect.stringMatching(/^p\. 2, ¶/) }); expect(concept.support).toBe('source');
  });
  it('the same file uploaded twice is recognised, not duplicated', async () => {
    s = await startServer(); const sub = await mkSubject();
    const a = await upload(sub, HISTORY), b = await upload(sub, HISTORY);
    expect(b.body).toMatchObject({ id: a.body.id, duplicate: true });
    expect(db().get<any>('SELECT COUNT(*) n FROM source_files').n).toBe(1);
  });
  it('flags guessed superscripts for the student to review and keeps the original text untouched by edits', async () => {
    s = await startServer(); const sub = await mkSubject('Algebra');
    const up = await upload(sub, ALGEBRA, { name: 'Review.pdf' });
    const rv = (await s.call('GET', `/api/sources/${up.body.id}/review`)).body;
    expect(rv.pages[1].text).toContain('x^2'); expect(rv.pages[1].reviewMath).toBe(true); expect(rv.pages[0].reviewMath).toBe(false);
    expect(rv.pages[0].text).toContain('|x − 3| < 5');
    const orig = db().get<any>('SELECT original_text, text FROM sources WHERE id=?', up.body.id).original_text;
    const ed = await s.call('PUT', `/api/sources/${up.body.id}/pages/2`, { text: rv.pages[1].text.replace(/x\^2/g, 'x²'), baseRev: rv.rev });
    expect(ed.status).toBe(200); expect(ed.body.rev).toBe(2);
    const row = db().get<any>('SELECT original_text, text FROM sources WHERE id=?', up.body.id);
    expect(row.original_text).toBe(orig); expect(row.text).toContain('x²'); expect(row.original_text).toContain('x^2');
    expect(db().get<any>("SELECT COUNT(*) n FROM source_revisions WHERE source_id=?", up.body.id).n).toBe(2);
    expect(db().get<any>('SELECT COUNT(*) n FROM source_chunks WHERE source_id=? AND uncertain=1', up.body.id).n).toBe(0); // reviewed text no longer needs a look
  });
  it('a stale edit from another tab cannot overwrite a newer one', async () => {
    s = await startServer(); const sub = await mkSubject();
    const id = (await upload(sub, HISTORY)).body.id;
    expect((await s.call('PUT', `/api/sources/${id}/pages/1`, { text: 'First fix', baseRev: 1 })).status).toBe(200);
    const late = await s.call('PUT', `/api/sources/${id}/pages/1`, { text: 'Second tab', baseRev: 1 });
    expect(late.status).toBe(409); expect(late.body.error).toMatchObject({ code: 'stale_edit', rev: 2 });
    expect((await s.call('PUT', `/api/sources/${id}/pages/9`, { text: 'x', baseRev: 2 })).status).toBe(400);
  });
});

describe('scans and screenshots: honest fallback, no fake extraction', () => {
  it('a scanned PDF is stored, shows empty pages, and cannot be confirmed until text is supplied', async () => {
    s = await startServer(); const sub = await mkSubject('Science');
    const up = await upload(sub, SCAN, { name: 'scan.pdf' });
    expect(up.body).toMatchObject({ status: 'draft', pageCount: 1, method: 'none', emptyPages: [1] });
    expect(db().get<any>('SELECT text FROM sources WHERE id=?', up.body.id).text).toBe('');
    const c = await s.call('POST', `/api/sources/${up.body.id}/confirm`, {});
    expect(c.status).toBe(422); expect(c.body.error.code).toBe('no_text'); expect(c.body.error.message).toMatch(/scan or a photo/);
    const ed = await s.call('PUT', `/api/sources/${up.body.id}/pages/1`, { text: 'Photosynthesis: plants turn light, water and carbon dioxide into glucose and oxygen.', baseRev: 1 });
    expect(ed.status).toBe(200);
    expect((await s.call('POST', `/api/sources/${up.body.id}/confirm`, {})).body.status).toBe('confirmed');
    expect(db().get<any>('SELECT kind FROM source_revisions WHERE source_id=? AND rev=2', up.body.id).kind).toBe('transcribed');
  });
  it('a screenshot is accepted as an image to transcribe, never read by pretend OCR', async () => {
    s = await startServer(); const sub = await mkSubject('Science');
    const up = await upload(sub, PNG, { name: 'notes.png', type: 'image/png' });
    expect(up.status).toBe(200); expect(up.body).toMatchObject({ status: 'draft', method: 'none', pageCount: 1 });
    const rv = (await s.call('GET', `/api/sources/${up.body.id}/review`)).body;
    expect(rv.file.kind).toBe('png'); expect(rv.pages[0].noText).toBe(true);
    const img = await fetch(`http://127.0.0.1:${s.port}${rv.file.url}`); expect(img.headers.get('content-type')).toBe('image/png');
  });
  it('a mixed PDF needs an explicit acknowledgement before blank pages are left out', async () => {
    s = await startServer(); const sub = await mkSubject();
    const id = (await upload(sub, HISTORY)).body.id;
    await s.call('PUT', `/api/sources/${id}/pages/2`, { text: '', baseRev: 1 });
    const c = await s.call('POST', `/api/sources/${id}/confirm`, {});
    expect(c.status).toBe(409); expect(c.body.error).toMatchObject({ code: 'empty_pages', emptyPages: [2] });
    expect((await s.call('POST', `/api/sources/${id}/confirm`, { acknowledgeEmptyPages: true })).body).toMatchObject({ status: 'confirmed', emptyPages: [2] });
  });
});

describe('corrections and re-upload do not leave stale evidence behind', () => {
  async function built() {
    const t = new Script((u) => (u.includes('Identify up to') ? extractReply : qReply));
    s = await startServer({ llm: new LLMProvider(t) }); const sub = await mkSubject();
    const id = (await upload(sub, HISTORY)).body.id;
    await s.call('POST', `/api/sources/${id}/confirm`, {}); await s.call('POST', `/api/sources/${id}/extract`, {});
    const concept = (await s.call('GET', `/api/subjects/${sub}`)).body.concepts[0];
    await s.call('PATCH', `/api/concepts/${concept.id}`, { status: 'confirmed' });
    await generateQuestions(s.rt.ctx('real'), concept.id, { focus: 'practice' });
    return { sub, id, concept };
  }
  it('questions record the exact page their quote came from', async () => {
    const { id } = await built();
    const qs = db().all<any>('SELECT id, prompt, source_note FROM questions ORDER BY rowid');
    expect(qs).toHaveLength(2);
    expect(qs[0].source_note).toMatch(/p\. 2/); expect(qs[1].source_note).toBe('');
    expect(db().get<any>('SELECT label, stale FROM question_evidence WHERE source_id=?', id)).toMatchObject({ stale: 0, label: expect.stringMatching(/^p\. 2/) });
  });
  it('editing around a quote keeps it linked; editing the quote itself retires the question and marks the concept’s support stale', async () => {
    const { id, concept } = await built();
    let rv = (await s.call('GET', `/api/sources/${id}/review`)).body;
    // an edit elsewhere on the page: the quote is found again at its new location
    const fixed = await s.call('PUT', `/api/sources/${id}/pages/2`, { text: 'Intro line added by the student.\n' + rv.pages[1].text, baseRev: rv.rev });
    expect(fixed.body.reconcile).toMatchObject({ refsRelinked: 1, refsStale: 0, questionsRetired: 0 });
    // the passage itself is changed
    rv = (await s.call('GET', `/api/sources/${id}/review`)).body;
    const changed = await s.call('PUT', `/api/sources/${id}/pages/2`, { text: rv.pages[1].text.replace('drew national attention to the crisis', 'was mostly ignored by the newspapers'), baseRev: rv.rev });
    expect(changed.body.reconcile).toMatchObject({ refsStale: 1, questionsRetired: 1, conceptsDowngraded: 1 });
    const c = (await s.call('GET', `/api/subjects/${sub(concept)}`)).body.concepts[0];
    expect(c.support).toBe('unverified'); expect(c.supportNote).toMatch(/changed or removed/);
    const q = db().all<any>('SELECT retired_at, retired_reason FROM questions ORDER BY rowid');
    expect(q[0].retired_at).not.toBeNull(); expect(q[1].retired_at).toBeNull(); // only the question built on the changed passage
    expect(db().get<any>('SELECT stale FROM concept_refs').stale).toBe(1);
  });
  it('replacing the file re-reads the text, keeps history, and reports what no longer matches', async () => {
    const { sub: subId, id } = await built();
    const r = await upload(subId, ALGEBRA, { path: `/api/sources/${id}/replace`, name: 'new.pdf' });
    expect(r.status).toBe(200); expect(r.body.reconcile).toMatchObject({ refsStale: 1, questionsRetired: 1 });
    expect(r.body.pageCount).toBe(3);
    expect(db().get<any>('SELECT COUNT(*) n FROM source_revisions WHERE source_id=?', id).n).toBe(2);
    expect(db().get<any>('SELECT COUNT(*) n FROM source_files').n).toBe(2); // the old original stays in history
    const same = await upload(subId, ALGEBRA, { path: `/api/sources/${id}/replace`, name: 'again.pdf' });
    expect(same.status).toBe(409);
    // retired questions are never served again
    const { pickQuestion } = await import('../src/server/services/questions');
    const conceptId = db().get<any>('SELECT id FROM concepts').id;
    const picked = await pickQuestion(s.rt.ctx('real'), { conceptId, purpose: 'transfer', exclude: [] });
    expect(picked.prompt).toMatch(/April 14, 1935/); // the question tied to the replaced passage is skipped
  });
  it('deleting the material removes its stored file too', async () => {
    const { id } = await built();
    await s.call('DELETE', `/api/sources/${id}`);
    expect(db().get<any>('SELECT COUNT(*) n FROM source_files').n).toBe(0);
  });
});
const sub = (c: { id: string }) => db().get<any>('SELECT subject_id s FROM concepts WHERE id=?', c.id).s as string;
