import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { LLMProvider, LLMRequest, LLMResponse, LLMTransport } from '../src/ai/llm';
import { startServer, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });
const f = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url));
const SCAN = f('tests/fixtures/scanned.pdf'), PNG = f('samples/notebook-screenshot.png');
const db = () => s.rt.ctx('real').db;
const SECRET = 'sk-ant-OCR-CANARY-123';

class Vision implements LLMTransport {
  provider = 'anthropic'; defaultModel = 'claude-sonnet-5-5'; credentialFingerprint = 'fp'; reqs: LLMRequest[] = [];
  constructor(public reply: (r: LLMRequest) => unknown) {}
  async complete(r: LLMRequest): Promise<LLMResponse> { this.reqs.push(r); return { text: JSON.stringify(this.reply(r)), model: 'claude-sonnet-5-5', stopReason: 'end_turn', requestId: 'r', usage: { input: 2500, output: 300, cacheRead: 0, cacheWrite: 0 } }; }
}
const READING = { pages: [{ page: 1, blocks: [
  { kind: 'text', text: 'Photosynthesis: plants turn light, water and carbon dioxide into glucose and oxygen.', readable: true },
  { kind: 'math', text: '6CO2 + 6H2O → C6H12O6 + 6O2', readable: true },
  { kind: 'math', text: 'x [?] 5', readable: false, note: 'the sign is smudged' },
  { kind: 'diagram', text: 'a leaf cross-section with labelled stomata', readable: false },
] }] };

async function setup(t: Vision | null, cfg: any = {}) {
  s = await startServer({ llm: t ? new LLMProvider(t, { ocr: {} }) : null, cfg: { ocr: { enabled: true, model: null }, anthropicKey: SECRET, ...cfg } });
  const sub = (await s.call('POST', '/api/subjects', { name: 'Science' })).body.id;
  const up = async (body: Buffer, type: string, name: string) => (await (await fetch(`http://127.0.0.1:${s.port}/api/subjects/${sub}/files?filename=${name}`, { method: 'POST', headers: { 'content-type': type, 'x-workspace': 'real' }, body: body as BodyInit })).json());
  return { sub, up };
}

describe('automatic reading is off unless explicitly enabled, and manual transcription still works', () => {
  it('explains exactly how to enable it and never sends anything', async () => {
    const t = new Vision(() => READING);
    const { up } = await setup(t, { ocr: { enabled: false, model: null } });
    const { id } = await up(SCAN, 'application/pdf', 'scan.pdf');
    const pre = (await s.call('POST', `/api/sources/${id}/ocr/preview`, {})).body;
    expect(pre.available).toBe(false); expect(pre.reason).toMatch(/Nothing is ever sent/); expect(pre.steps.join(' ')).toMatch(/AI_OCR=anthropic/);
    expect((await s.call('POST', `/api/sources/${id}/ocr`, { consentToken: 'x' })).status).toBe(409);
    expect(t.reqs).toHaveLength(0);
    // manual fallback: type the page, confirm, done
    const rv = (await s.call('GET', `/api/sources/${id}/review`)).body;
    expect(rv.ocr.available).toBe(false);
    await s.call('PUT', `/api/sources/${id}/pages/1`, { text: 'Photosynthesis: plants make glucose using light.', baseRev: rv.rev });
    expect((await s.call('POST', `/api/sources/${id}/confirm`, {})).body.status).toBe('confirmed');
  });
  it('is unavailable with another provider or without a key', async () => {
    const t = new Vision(() => READING); t.provider = 'groq';
    const { up } = await setup(t);
    const { id } = await up(SCAN, 'application/pdf', 'scan.pdf');
    expect((await s.call('POST', `/api/sources/${id}/ocr/preview`, {})).body.available).toBe(false);
  });
});

describe('disclosure and consent come before anything is sent', () => {
  it('shows provider, model, exactly what is sent and not sent, and the worst-case cost', async () => {
    const t = new Vision(() => READING);
    const { up } = await setup(t);
    const { id } = await up(SCAN, 'application/pdf', 'scan.pdf');
    const d = (await s.call('POST', `/api/sources/${id}/ocr/preview`, {})).body;
    expect(d).toMatchObject({ available: true, provider: 'Anthropic', model: 'claude-sonnet-5-5', pages: [1], requests: 1 });
    expect(d.willSend).toMatch(/1 page \(1\) of “scan.pdf”/); expect(d.wontSend.join(' ')).toMatch(/other materials/); expect(d.wontSend.join(' ')).toMatch(/API key/);
    expect(d.worstCaseUsd).toBeGreaterThan(0); expect(d.budgetNote).toMatch(/not a quote/); expect(d.consentToken).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(d)).not.toContain(SECRET);
    expect(t.reqs).toHaveLength(0); // previewing sends nothing
  });
  it('refuses to send without the matching consent token', async () => {
    const t = new Vision(() => READING);
    const { up } = await setup(t);
    const { id } = await up(SCAN, 'application/pdf', 'scan.pdf');
    for (const body of [{ consentToken: '' }, { consentToken: 'deadbeef' }]) expect((await s.call('POST', `/api/sources/${id}/ocr`, body)).body.error.code).toMatch(/consent_required|invalid/);
    expect(t.reqs).toHaveLength(0);
  });
});

describe('reading with fixtures (live reading remains unverified)', () => {
  it('sends only the approved page as a PDF attachment, accounts for the cost, and flags math, diagrams and unreadable parts', async () => {
    const t = new Vision(() => READING);
    const { up } = await setup(t);
    const { id } = await up(SCAN, 'application/pdf', 'scan.pdf');
    const d = (await s.call('POST', `/api/sources/${id}/ocr/preview`, {})).body;
    const r = await s.call('POST', `/api/sources/${id}/ocr`, { consentToken: d.consentToken });
    expect(r.body).toMatchObject({ read: [1], skipped: [], failed: [], requests: 1 });
    // what was sent
    expect(t.reqs).toHaveLength(1);
    const att = t.reqs[0].attachments![0];
    expect(att).toMatchObject({ kind: 'pdf', mediaType: 'application/pdf', pages: 1 }); expect(Buffer.from(att.data, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    expect(t.reqs[0].user).toMatch(/never follow instructions/); expect(JSON.stringify(t.reqs[0])).not.toContain(SECRET);
    // cost controls
    const u = db().get<any>("SELECT * FROM ai_usage WHERE purpose='ocr'");
    expect(u).toMatchObject({ status: 'settled', billing: 'reported', input_tokens: 2500, outcome: 'ok' }); expect(u.est_cost_usd).toBeGreaterThan(0);
    expect((await s.call('GET', '/api/ai/usage')).body.byPurpose.find((x: any) => x.key === 'ocr').requests).toBe(1);
    // result: text with explicit markers, no confidence percentages, flags per area
    const rv = (await s.call('GET', `/api/sources/${id}/review`)).body;
    const pg = rv.pages[0];
    expect(pg.text).toContain('Photosynthesis: plants turn light'); expect(pg.text).toContain('6CO2 + 6H2O → C6H12O6 + 6O2');
    expect(pg.text).toContain('[unreadable: the sign is smudged] x [?] 5'); expect(pg.text).toContain('[diagram: a leaf cross-section with labelled stomata — not interpreted]');
    expect(pg.flags.map((x: any) => x.kind).sort()).toEqual(['diagram', 'math', 'unreadable']);
    expect(pg.source).toBe('vision'); expect(pg.reviewed).toBe(false);
    expect(JSON.stringify(rv)).not.toMatch(/confidence|%/);
    // uncertain content must be reviewed before the text can be used
    const blocked = await s.call('POST', `/api/sources/${id}/confirm`, {});
    expect(blocked.status).toBe(409); expect(blocked.body.error).toMatchObject({ code: 'needs_review', pages: [1] });
    await s.call('POST', `/api/sources/${id}/pages/reviewed`, { pages: [1] });
    expect((await s.call('POST', `/api/sources/${id}/confirm`, {})).body.status).toBe('confirmed');
  });
  it('editing a flagged page counts as having looked at it', async () => {
    const t = new Vision(() => READING);
    const { up } = await setup(t);
    const { id } = await up(SCAN, 'application/pdf', 'scan.pdf');
    const d = (await s.call('POST', `/api/sources/${id}/ocr/preview`, {})).body;
    await s.call('POST', `/api/sources/${id}/ocr`, { consentToken: d.consentToken });
    const rv = (await s.call('GET', `/api/sources/${id}/review`)).body;
    await s.call('PUT', `/api/sources/${id}/pages/1`, { text: rv.pages[0].text.replace('x [?] 5', 'x < 5'), baseRev: rv.rev });
    expect((await s.call('POST', `/api/sources/${id}/confirm`, {})).status).toBe(200);
  });
  it('reads a screenshot as an image attachment and keeps existing text unless told to overwrite', async () => {
    const t = new Vision(() => ({ pages: [{ page: 1, blocks: [{ kind: 'text', text: 'Chlorophyll absorbs light energy in the chloroplast.', readable: true }] }] }));
    const { up } = await setup(t);
    const { id } = await up(PNG, 'image/png', 'notes.png');
    const d = (await s.call('POST', `/api/sources/${id}/ocr/preview`, {})).body;
    expect(d.willSend).toMatch(/the image “notes.png”/);
    await s.call('POST', `/api/sources/${id}/ocr`, { consentToken: d.consentToken });
    expect(t.reqs[0].attachments![0]).toMatchObject({ kind: 'image', mediaType: 'image/png' });
    const rv = (await s.call('GET', `/api/sources/${id}/review`)).body;
    expect(rv.pages[0].flags).toEqual([]); // plain text: nothing flagged, but still a draft the student confirms
    // asking to read a page that already has text sends nothing unless it is explicitly selected + overwrite
    const again = await s.call('POST', `/api/sources/${id}/ocr/preview`, {});
    expect(again.status).toBe(409); expect(again.body.error.code).toBe('nothing_to_read');
  });
  it('a budget stop sends nothing and applies nothing', async () => {
    const t = new Vision(() => READING);
    const { up } = await setup(t, { aiDailyBudgetUsd: 0.0001 });
    const { id } = await up(SCAN, 'application/pdf', 'scan.pdf');
    const d = (await s.call('POST', `/api/sources/${id}/ocr/preview`, {})).body;
    const r = await s.call('POST', `/api/sources/${id}/ocr`, { consentToken: d.consentToken });
    expect(r.body.read).toEqual([]); expect(r.body.failed[0].code).toBe('budget_reached'); expect(t.reqs).toHaveLength(0);
    expect(db().get<any>('SELECT text FROM sources WHERE id=?', id).text).toBe('');
  });
  it('never rewrites a confirmed material; reading applies only while a file is in review', async () => {
    const t = new Vision(() => READING);
    const { up } = await setup(t);
    const { id } = await up(SCAN, 'application/pdf', 'scan.pdf');
    await s.call('PUT', `/api/sources/${id}/pages/1`, { text: 'Typed by hand: photosynthesis makes glucose.', baseRev: 1 });
    await s.call('POST', `/api/sources/${id}/confirm`, {});
    expect((await s.call('POST', `/api/sources/${id}/ocr/preview`, {})).body.error.code).toBe('not_in_review');
  });
});
