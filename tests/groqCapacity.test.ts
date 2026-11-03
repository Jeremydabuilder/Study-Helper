/** Groq's Free tier is small and shared by every student. These tests check the app's own rules for it (pacing, cooldown, honest waits, limits) with a fake Groq: they show the rules hold, NOT that the Free tier supports any number of students. */
import { afterEach, describe, expect, it } from 'vitest';
import { GroqTransport } from '../src/ai/groq';
import { GroqCapacity, parseDuration, waitWords } from '../src/ai/groqCapacity';
import { LLMProvider } from '../src/ai/llm';
import { configFromEnv } from '../src/server/config';
import { HostedHarness } from './hostedHarness';
import { PG_AVAILABLE } from './pgHarness';

const req = { system: 'sys', user: 'hello', model: 'm', maxTokens: 500, timeoutMs: 2000 };
const ok = (text = '{"reply":"hi"}', usage = { prompt_tokens: 100, completion_tokens: 20 }) => Response.json({ id: 'x', model: 'm', choices: [{ message: { content: text }, finish_reason: 'stop' }], usage });
const tooMany = (msg: string, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error: { message: msg, code: 'rate_limit_exceeded' } }), { status: 429, headers });
function clock() { let t = 1_000_000; return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } }; }

describe('reading Groq\'s wait times', () => {
  it('parses durations and words them plainly', () => {
    expect(parseDuration('7m12.5s')).toBe(432_500); expect(parseDuration('2m59.56s')).toBe(179_560); expect(parseDuration('250ms')).toBe(250); expect(parseDuration('1h2m3s')).toBe(3_723_000); expect(parseDuration('soon')).toBeNull();
    expect(waitWords(2000)).toBe('5 seconds'); expect(waitWords(42_000)).toBe('45 seconds'); expect(waitWords(12 * 60_000)).toBe('12 minutes'); expect(waitWords(3 * 3_600_000)).toBe('3 hours');
  });
});

describe('pacing and cooldown', () => {
  it('a 429 pauses EVERY student: twenty clicks on "retry" send one request, not twenty', async () => {
    const c = clock(); let calls = 0;
    const t = new GroqTransport('key', 'm', (async () => { calls++; return tooMany('Rate limit reached for model on tokens per minute (TPM). Please try again in 20s.', { 'retry-after': '20' }); }) as typeof fetch, new GroqCapacity({ now: c.now, sleep: c.sleep }));
    const first = await t.complete(req).catch((e) => e);
    expect(first).toMatchObject({ code: 'rate_limited', retryAfterMs: 20_000, billing: 'none_reported' }); expect(first.message).toMatch(/about 20 seconds/);
    for (let i = 0; i < 20; i++) await expect(t.complete(req)).rejects.toMatchObject({ code: 'rate_limited', billing: 'not_sent' });
    expect(calls).toBe(1);
    c.advance(21_000);
    calls = 0; const t2 = t; (t2 as any).fetchImpl = (async () => { calls++; return ok(); });
    expect((await t2.complete(req)).text).toBe('{"reply":"hi"}'); expect(calls).toBe(1);
  });
  it('a daily allowance refusal is explained as such and keeps its long wait', async () => {
    const c = clock();
    const t = new GroqTransport('key', 'm', (async () => tooMany('Rate limit reached for model on tokens per day (TPD): Limit 200000. Please try again in 14m22.848s.')) as typeof fetch, new GroqCapacity({ now: c.now, sleep: c.sleep }));
    const e = await t.complete(req).catch((x) => x);
    expect(e.retryAfterMs).toBe(862_848); expect(e.message).toMatch(/shared free allowance is used up[\s\S]*about 15 minutes/);
    c.advance(60_000);
    await expect(t.complete(req)).rejects.toThrow(/about 14 minutes/);
  });
  it('without any header the wait backs off 10 s, 20 s, 40 s … up to 2 minutes and resets after a success', async () => {
    const c = clock(); const cap = new GroqCapacity({ now: c.now, sleep: c.sleep });
    expect(cap.rateLimited(null, false)).toBe(10_000); c.advance(10_001); expect(cap.rateLimited(null, false)).toBe(20_000); c.advance(20_001);
    for (let i = 0; i < 8; i++) cap.rateLimited(null, false);
    expect(cap.rateLimited(null, false)).toBe(120_000);
    cap.success(); c.advance(130_000); expect(cap.rateLimited(null, false)).toBe(10_000);
  });
  it('stops early when the headers say nothing is left, and pauses briefly after a provider outage', async () => {
    const c = clock(); let calls = 0;
    const t = new GroqTransport('key', 'm', (async () => { calls++; return calls === 1 ? new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '8s' } }) : new Response('down', { status: 503 }); }) as typeof fetch, new GroqCapacity({ now: c.now, sleep: c.sleep }));
    await t.complete(req);
    await expect(t.complete(req)).rejects.toMatchObject({ code: 'rate_limited', billing: 'not_sent' }); expect(calls).toBe(1);
    c.advance(9000); await expect(t.complete(req)).rejects.toMatchObject({ code: 'unavailable' }); // the outage itself
    await expect(t.complete(req)).rejects.toMatchObject({ code: 'rate_limited' }); expect(calls).toBe(2); // and then nobody else is sent into it
  });
  it('paces requests per minute instead of bursting, refuses a wait longer than the limit, and serves callers in order', async () => {
    const c = clock(); let calls = 0; const starts: number[] = [];
    const cap = new GroqCapacity({ rpm: 3, tpm: 100000, maxConcurrent: 5, maxWaitMs: 5000, now: c.now, sleep: c.sleep });
    const t = new GroqTransport('key', 'm', (async () => { calls++; starts.push(c.now()); return ok(); }) as typeof fetch, cap);
    for (let i = 0; i < 3; i++) await t.complete(req);
    expect(starts.every((s) => s === starts[0])).toBe(true);
    const e = await t.complete(req).catch((x) => x);   // the 4th would have to wait ~60 s
    expect(e).toMatchObject({ code: 'rate_limited', billing: 'not_sent' }); expect(e.message).toMatch(/per-minute limit[\s\S]*about/); expect(calls).toBe(3);
    c.advance(61_000); expect((await t.complete(req)).text).toBeTruthy(); expect(calls).toBe(4);
  });
  it('limits simultaneous calls and tokens per minute, and rejects a task that can never fit', async () => {
    let running = 0, peak = 0;
    const cap = new GroqCapacity({ maxConcurrent: 2, rpm: 100, tpm: 100000, maxWaitMs: 5000 });
    const t = new GroqTransport('key', 'm', (async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running--; return ok(); }) as typeof fetch, cap);
    await Promise.all(Array.from({ length: 8 }, () => t.complete(req)));
    expect(peak).toBe(2);
    const small = new GroqTransport('key', 'm', (async () => ok()) as typeof fetch, new GroqCapacity({ tpm: 1000 }));
    await expect(small.complete({ ...req, user: 'x'.repeat(9000) })).rejects.toMatchObject({ code: 'rejected', billing: 'not_sent' });
  });
  it('treats a Groq "json_validate_failed" as an unusable answer to repeat once, never as a crash, and sends no images', async () => {
    let calls = 0;
    const t = new GroqTransport('key', 'm', (async () => { calls++; return calls === 1 ? new Response(JSON.stringify({ error: { code: 'json_validate_failed', message: 'bad' } }), { status: 400 }) : ok('{"reply":"second try"}'); }) as typeof fetch);
    const p = new LLMProvider(t);
    expect((await (p as any).chat({ mode: 'general', direct: true, context: '', history: [], message: 'hi' })).reply).toBe('second try'); expect(calls).toBe(2);
    await expect(t.complete({ ...req, attachments: [{ kind: 'image', mediaType: 'image/png', data: 'x' }] })).rejects.toMatchObject({ billing: 'not_sent' });
  });
});

describe('configuration', () => {
  it('Groq is chosen only by the operator, costs nothing on the Free tier in the ledger, and the model is operator-set', () => {
    const c = configFromEnv({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'k', GROQ_MODEL: 'some/model', GROQ_RPM: '20' });
    expect(c.aiProvider).toBe('groq'); expect(c.groqModel).toBe('some/model'); expect(c.aiPriceOverride).toEqual({ inPerM: 0, outPerM: 0 }); expect(c.groqCapacity).toEqual({ rpm: 20 });
    expect(configFromEnv({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'k', AI_PRICE_IN_PER_MTOK: '0.15', AI_PRICE_OUT_PER_MTOK: '0.6' }).aiPriceOverride).toEqual({ inPerM: 0.15, outPerM: 0.6 });
    const none = configFromEnv({ AI_PROVIDER: 'groq' }); expect(none.groqKey).toBeNull(); // no key: no provider, and no other provider is used instead
    expect(configFromEnv({ ANTHROPIC_API_KEY: 'a', GROQ_API_KEY: 'g' }).aiProvider).toBe('anthropic');
  });
});

const d = describe.skipIf(!PG_AVAILABLE);
const open: HostedHarness[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.stop(); });
const MATH = 'Worksheet\n1. Solve for x: 2x + 3 = 11\n2. Solve x - 5 = 2';
d('hosted: students keep their work when the shared allowance is refused', () => {
  it('homework and answers are saved first; a refusal shows how long to wait for everyone; nothing hammers Groq; recovery works', async () => {
    let calls = 0, mode: 'busy' | 'ok' = 'busy';
    const transport = new GroqTransport('key', 'm', (async () => { calls++; return mode === 'busy' ? tooMany('Rate limit reached for model on tokens per minute (TPM). Please try again in 30s.', { 'retry-after': '30' }) : ok(JSON.stringify({ text: 'Look at what is being done to x.', clarifying_question: null, basis: 'general', uncertain: null, final_answer: null })); }) as typeof fetch, new GroqCapacity());
    const h = await HostedHarness.start({ oidc: false, limits: { AUTH_GUESTS: '1' }, provider: new LLMProvider(transport) }); open.push(h);
    const a = await h.guest('a'), b = await h.guest('b');
    const sub = (await a.post('/api/subjects', { name: 'Algebra' })).body.id;
    const src = (await a.post(`/api/subjects/${sub}/sources`, { title: 'WS', kind: 'teacher_instructions', text: MATH })).body.id;
    const hw = (await a.post('/api/homework', { sourceId: src })).body.id;
    const q = (await a.post(`/api/homework/${hw}/confirm`, { plan: 'new', dueDate: '2026-12-01' })).body.questions[0].id;
    expect((await a.put(`/api/homework/questions/${q}/work`, { text: 'x = 4' })).status).toBe(200);
    const refused = await a.post(`/api/homework/questions/${q}/help`, { action: 'hint' });
    expect(refused.status).toBe(429); expect(refused.body.error).toMatchObject({ code: 'ai_rate_limited', retryAfterMs: 30_000, retryable: true });
    expect(refused.body.error.message).toMatch(/about 30 seconds/); expect(refused.body.error.message).not.toMatch(/groq|gpt|api key/i);
    expect((await a.get(`/api/homework/${hw}`)).body.questions[0].work.text).toBe('x = 4');      // saved before and after
    expect((await a.get(`/api/homework/questions/${q}/help`)).body.help).toHaveLength(0);          // a refused request is not recorded as help
    const before = calls;
    for (let i = 0; i < 10; i++) expect((await b.post('/api/conversations', { mode: 'general' })).status).toBe(200);
    const convo = (await b.post('/api/conversations', { mode: 'general' })).body.id;
    for (let i = 0; i < 10; i++) expect((await b.post(`/api/conversations/${convo}/messages`, { text: 'hello' })).status).toBe(429);
    expect(calls).toBe(before);                                                                      // the other student's retries never reached Groq
    const state = (await b.get('/api/account/assistant')).body;
    expect(state.state).toBe('cooling'); expect(state.waitMs).toBeGreaterThan(0);
    mode = 'ok';
    const gate = (await import('../src/ai/groqCapacity')).activeCapacity()!; (gate as any).cooldownUntil = 0;
    const good = await a.post(`/api/homework/questions/${q}/help`, { action: 'hint' });
    expect(good.status).toBe(200); expect(good.body.text).toMatch(/being done to x/);
  });
  it('shared daily token and request caps pause the assistant for everyone with an honest message, and per-person shares keep one student from using it all', async () => {
    const h = await HostedHarness.start({ limits: { LIMIT_GLOBAL_DAILY_TOKENS: '4000' } }); open.push(h);
    const s = await h.join('cap@example.test');
    const results: number[] = [];
    for (let i = 0; i < 4; i++) { const c = (await s.post('/api/conversations', { mode: 'general' })).body.id; results.push((await s.post(`/api/conversations/${c}/messages`, { text: `hello ${i}` })).status); }
    expect(results.slice(0, 2)).toEqual([200, 200]); expect(results.slice(2).every((x) => x === 429)).toBe(true);
    const last = await (async () => { const c = (await s.post('/api/conversations', { mode: 'general' })).body.id; return s.post(`/api/conversations/${c}/messages`, { text: 'again' }); })();
    expect(last.body.error.message).toMatch(/shared free allowance[\s\S]*within 24 hours/);
    expect((await s.get('/api/account/assistant')).body.state).toBe('paused_global');
    const h2 = await HostedHarness.start({ limits: { LIMIT_USER_DAILY_TOKENS: '4000', LIMIT_GLOBAL_DAILY_AI_REQUESTS: '50' } }); open.push(h2);
    const a = await h2.join('fair-a@example.test'), b = await h2.join('fair-b@example.test');
    const say = async (s: typeof a, n: number) => { const out: number[] = []; for (let i = 0; i < n; i++) { const c = (await s.post('/api/conversations', { mode: 'general' })).body.id; out.push((await s.post(`/api/conversations/${c}/messages`, { text: `hi ${i}` })).status); } return out; };
    expect(await say(a, 3)).toEqual([200, 200, 429]);   // 520 + 520 + the 3000 hold exceeds her share
    expect(await say(b, 1)).toEqual([200]);             // another student still has theirs
    expect((await b.get('/api/account/assistant')).body.state).toBe('available');
  });
});
