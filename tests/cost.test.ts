import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProvider } from '../src/ai/factory';
import { GroqTransport } from '../src/ai/groq';
import { AnthropicTransport, LLMProvider, LLMRequest, LLMResponse, LLMTransport } from '../src/ai/llm';
import { AIError } from '../src/ai/provider';
import { estimateCost, priceFor, reservationUsd } from '../src/ai/pricing';
import { configFromEnv } from '../src/server/config';
import { baseCfg, NOTES, startServer, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); vi.restoreAllMocks(); });

const CONCEPTS = JSON.stringify({ concepts: [{ name: 'Photosynthesis', summary: 'How plants make glucose.', quotes: ['the process plants use to turn light, water and carbon dioxide into glucose and oxygen'], prerequisites: [] }] });
const resp = (text: string, usage = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }, stopReason = 'end_turn'): LLMResponse => ({ text, model: 'claude-sonnet-5-5', stopReason, requestId: 'req_1', usage });

class Scripted implements LLMTransport {
  provider = 'anthropic'; defaultModel = 'claude-sonnet-5-5'; reqs: LLMRequest[] = [];
  constructor(public script: (n: number, r: LLMRequest) => LLMResponse | Error) {}
  async complete(r: LLMRequest) { this.reqs.push(r); const out = this.script(this.reqs.length, r); if (out instanceof Error) throw out; return out; }
}
async function withSource(opts: Parameters<typeof startServer>[0]) {
  s = await startServer(opts);
  const sub = (await s.call('POST', '/api/subjects', { name: 'Science' })).body.id;
  const src = (await s.call('POST', `/api/subjects/${sub}/sources`, { title: 'n', text: NOTES })).body.id;
  return { sub, src };
}
const rows = () => s.rt.ctx('real').db.all<any>('SELECT * FROM ai_usage ORDER BY id');

describe('pricing (list prices as of docs check; estimates only)', () => {
  it('prices Sonnet 5.5 and Haiku 5.5 from provider-reported tokens, incl. Haiku’s long-prompt tier', () => {
    const u = { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(estimateCost('claude-sonnet-5-5', u).usd).toBeCloseTo(0.01 * 2 + 0.002 * 10, 6); // $0.04
    expect(estimateCost('claude-haiku-5-5', u).usd).toBeCloseTo(0.01 * 0.1 + 0.002 * 0.5, 6); // $0.002
    const long = { inputTokens: 150_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(priceFor('claude-haiku-5-5', 150_000).price.inPerM).toBe(0.5);
    expect(estimateCost('claude-haiku-5-5', long).usd).toBeCloseTo(0.15 * 0.5 + 0.001 * 2.5, 6);
  });
  it('flags unknown models (conservative fallback) and honours explicit overrides', () => {
    expect(estimateCost('some-groq-model', { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }).known).toBe(false);
    expect(estimateCost('some-groq-model', { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 }, { inPerM: 0.1, outPerM: 0.2 })).toEqual({ usd: expect.closeTo(0.3, 6), known: true });
    // reservation: input ≤ bytes + 300 overhead, output ≤ max_tokens, +10% — a conservative policy, not a ceiling
    expect(reservationUsd('claude-sonnet-5-5', 7000, 4000)).toBeCloseTo(((7300 * 2 + 4000 * 10) / 1e6) * 1.1, 6);
  });
});

describe('request accounting', () => {
  it('records provider-reported tokens, model, latency and cost; a repair retry is a separate billable request', async () => {
    const t = new Scripted((n) => (n === 1 ? resp('not json', { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0 }) : resp(CONCEPTS, { input: 1500, output: 300, cacheRead: 0, cacheWrite: 0 })));
    const { src } = await withSource({ llm: new LLMProvider(t) });
    expect((await s.call('POST', `/api/sources/${src}/extract`, {})).status).toBe(200);
    const r = rows();
    expect(r.map((x) => [x.purpose, x.attempt, x.outcome])).toEqual([['extract', 1, 'invalid_output'], ['extract', 2, 'ok']]);
    expect(r[0]).toMatchObject({ model: 'claude-sonnet-5-5', input_tokens: 1200, output_tokens: 80, billing: 'reported', status: 'settled', provider: 'anthropic' });
    expect(r[0].est_cost_usd).toBeCloseTo((1200 * 2 + 80 * 10) / 1e6, 8);
    const usage = (await s.call('GET', '/api/ai/usage')).body;
    expect(usage.billableRequests).toBe(2);
    expect(usage.spentUsd).toBeCloseTo((1200 * 2 + 80 * 10 + 1500 * 2 + 300 * 10) / 1e6, 8);
    expect(usage.byPurpose[0]).toMatchObject({ key: 'extract', requests: 2, retries: 1, failures: 1 });
    expect(usage.policy).toMatch(/not a guaranteed dollar ceiling/i);
  });
  it('failed requests (429/5xx/timeouts) are logged but not billed', async () => {
    const t = new Scripted(() => new AIError('rate_limited', 'busy', 3000));
    const { src } = await withSource({ llm: new LLMProvider(t) });
    expect((await s.call('POST', `/api/sources/${src}/extract`, {})).status).toBe(429);
    expect(rows()).toHaveLength(1); expect(rows()[0]).toMatchObject({ outcome: 'rate_limited', est_cost_usd: 0 });
    expect((await s.call('GET', '/api/ai/usage')).body.billableRequests).toBe(0);
  });
  it('an unusable-but-billed response (truncated at the output limit) is billed once and NOT retried', async () => {
    const t = new Scripted(() => resp('{"concepts": [{"name": "Photo', { input: 900, output: 4000, cacheRead: 0, cacheWrite: 0 }, 'max_tokens'));
    const { src } = await withSource({ llm: new LLMProvider(t) });
    const r = await s.call('POST', `/api/sources/${src}/extract`, {});
    expect(r.status).toBe(502); expect(r.body.error.message).toMatch(/cut off at the 4000-token output limit.*AI_MAX_OUTPUT_EXTRACT/);
    expect(t.reqs).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ outcome: 'truncated', output_tokens: 4000 });
  });
  it('estimates (and labels) usage when a provider omits it', async () => {
    const t = new Scripted(() => ({ ...resp(CONCEPTS), usage: null }));
    const { src } = await withSource({ llm: new LLMProvider(t) });
    await s.call('POST', `/api/sources/${src}/extract`, {});
    expect(rows()[0]).toMatchObject({ billing: 'estimated' });
    expect(rows()[0].est_cost_usd).toBeGreaterThan(0); // held at the conservative reservation, never zero
    expect((await s.call('GET', '/api/ai/usage')).body.estimatedUsageRequests).toBe(1);
  });
});

describe('server-side budget enforcement', () => {
  it('blocks BEFORE the request when the worst case would exceed the daily budget', async () => {
    const t = new Scripted(() => resp(CONCEPTS));
    const { src } = await withSource({ llm: new LLMProvider(t), cfg: { aiDailyBudgetUsd: 0.001 } });
    const r = await s.call('POST', `/api/sources/${src}/extract`, {});
    expect(r.status).toBe(429); expect(r.body.error.code).toBe('ai_budget_reached'); expect(r.body.error.message).toMatch(/billing is authoritative/i);
    expect(t.reqs).toHaveLength(0); expect(rows()).toHaveLength(0);
  });
  it('also gates the repair retry: the second request is not sent once the budget is spent', async () => {
    const t = new Scripted((n) => (n === 1 ? resp('garbage', { input: 3000, output: 3000, cacheRead: 0, cacheWrite: 0 }) : resp(CONCEPTS)));
    // first request projects to ~$0.05 worst case; after it ~$0.036 is spent, so another worst-case request cannot fit in $0.07
    const { src } = await withSource({ llm: new LLMProvider(t), cfg: { aiDailyBudgetUsd: 0.07 } });
    const r = await s.call('POST', `/api/sources/${src}/extract`, {});
    expect(r.body.error.code).toBe('ai_budget_reached');
    expect(t.reqs).toHaveLength(1);
    expect(rows().map((x) => x.outcome)).toEqual(['invalid_output']);
  });
  it('the budget is configurable at runtime and shown in the usage display; 0 turns AI off', async () => {
    const t = new Scripted(() => resp(CONCEPTS));
    const { src } = await withSource({ llm: new LLMProvider(t) });
    await s.call('PUT', '/api/settings', { aiDailyBudgetUsd: 0 });
    expect((await s.call('POST', `/api/sources/${src}/extract`, {})).status).toBe(429);
    expect((await s.call('GET', '/api/settings')).body.aiDailyBudgetUsd).toBe(0);
    await s.call('PUT', '/api/settings', { aiDailyBudgetUsd: 5 });
    expect((await s.call('POST', `/api/sources/${src}/extract`, {})).status).toBe(200);
    expect((await s.call('GET', '/api/status')).body.ai).toMatchObject({ dailyBudgetUsd: 5, live: true });
  });
  it('the spend window is rolling 24h: yesterday’s spend ages out', async () => {
    const t = new Scripted(() => resp(CONCEPTS, { input: 1000, output: 100000, cacheRead: 0, cacheWrite: 0 }));
    const { src } = await withSource({ llm: new LLMProvider(t), cfg: { aiDailyBudgetUsd: 1.03 } });
    expect((await s.call('POST', `/api/sources/${src}/extract`, { force: true })).status).toBe(200); // ~$1.00 spent
    expect((await s.call('POST', `/api/sources/${src}/extract`, { force: true })).status).toBe(429);
    s.clock.now += 25 * 3600_000;
    expect((await s.call('POST', `/api/sources/${src}/extract`, { force: true })).status).toBe(200);
  });
});

describe('avoiding unnecessary calls', () => {
  it('does not re-extract a source that already produced concepts unless forced', async () => {
    const t = new Scripted(() => resp(CONCEPTS));
    const { src } = await withSource({ llm: new LLMProvider(t) });
    await s.call('POST', `/api/sources/${src}/extract`, {});
    const again = await s.call('POST', `/api/sources/${src}/extract`, {});
    expect(again.body).toMatchObject({ created: 0, reused: true });
    expect(t.reqs).toHaveLength(1);
    await s.call('POST', `/api/sources/${src}/extract`, { force: true });
    expect(t.reqs).toHaveLength(2);
  });
});

describe('per-task model, output limits and effort', () => {
  it('sends the configured model / max_tokens / effort per task (Haiku routing is opt-in, Sonnet is the default)', async () => {
    const t = new Scripted(() => resp(CONCEPTS));
    const p = new LLMProvider(t, { tasks: { extract: { model: 'claude-haiku-5-5', maxOutputTokens: 1234, effort: 'low' }, grade: { maxOutputTokens: 700, effort: 'high' } } });
    expect(p.modelFor('extract')).toBe('claude-haiku-5-5'); expect(p.modelFor('generate')).toBe('claude-sonnet-5-5'); expect(p.modelFor('grade')).toBe('claude-sonnet-5-5');
    await p.extractConcepts({ subjectName: 'S', chunks: [{ id: '1', label: 'p', text: 'x' }], maxConcepts: 3 });
    expect(t.reqs[0]).toMatchObject({ model: 'claude-haiku-5-5', maxTokens: 1234, effort: 'low' });
  });
  it('configFromEnv reads models, limits, effort, budget; invalid effort is ignored; groq is never the default', () => {
    const c = configFromEnv({ ANTHROPIC_API_KEY: 'k', GROQ_API_KEY: 'g', GROQ_MODEL: 'm', AI_MODEL_EXTRACT: 'claude-haiku-5-5', AI_MAX_OUTPUT_GRADE: '800', AI_EFFORT_GRADE: 'bogus', AI_EFFORT_EXTRACT: 'low', AI_DAILY_BUDGET_USD: '0.25' } as never);
    expect(c.aiProvider).toBe('anthropic'); expect(c.model).toBe('claude-sonnet-5-5');
    expect(c.aiTasks.extract).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' }); expect(c.aiTasks.grade).toMatchObject({ maxOutputTokens: 800 }); expect(c.aiTasks.grade!.effort).toBeUndefined();
    expect(c.aiDailyBudgetUsd).toBe(0.25);
    expect(buildProvider(c)!.name).toMatch(/^anthropic:/);
  });
  it('Anthropic transport: effort only for models that support it, thinking blocks ignored, provider usage parsed', async () => {
    const bodies: any[] = [];
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: 'msg_1', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ANSWER' }], usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }), { headers: { 'request-id': 'req_abc' } }); }) as unknown as typeof fetch;
    const t = new AnthropicTransport('k', 'claude-sonnet-5-5', f);
    const r = await t.complete({ system: 's', user: 'u', maxTokens: 321, timeoutMs: 1000, model: 'claude-sonnet-5-5', effort: 'low' });
    expect(r).toMatchObject({ text: 'ANSWER', requestId: 'req_abc', usage: { input: 11, output: 22, cacheRead: 3, cacheWrite: 4 }, stopReason: 'end_turn' });
    expect(bodies[0]).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 321, output_config: { effort: 'low' } });
    await t.complete({ system: 's', user: 'u', maxTokens: 5, timeoutMs: 1000, model: 'claude-3-old', effort: 'low' });
    expect(bodies[1].output_config).toBeUndefined();
  });
});

describe('optional Groq transport (opt-in, unverified against the live API)', () => {
  it('uses OpenAI-compatible chat completions with JSON mode and maps usage/limits/errors', async () => {
    let seen: { url: string; headers: any; body: any } | null = null;
    const mk = (status: number, body: unknown, headers: Record<string, string> = {}) => new GroqTransport('gk', 'some-model', (async (u: string, init: RequestInit) => { seen = { url: u, headers: init.headers, body: JSON.parse(String(init.body)) }; return new Response(JSON.stringify(body), { status, headers }); }) as unknown as typeof fetch);
    const ok = await mk(200, { model: 'some-model', choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4 } }).complete({ system: 's', user: 'u', maxTokens: 50, timeoutMs: 1000, model: 'some-model' });
    expect(ok).toMatchObject({ text: '{"a":1}', usage: { input: 9, output: 4 }, stopReason: 'stop' });
    expect(seen!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(seen!.body).toMatchObject({ response_format: { type: 'json_object' }, max_completion_tokens: 50 });
    expect(seen!.headers.authorization).toBe('Bearer gk');
    await expect(mk(429, {}, { 'retry-after': '4' }).complete({ system: 's', user: 'u', maxTokens: 5, timeoutMs: 1000, model: 'm' })).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 4000 });
    const p = new LLMProvider(mk(200, { choices: [{ message: { content: '{"concepts":[' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 50 } }));
    await expect(p.extractConcepts({ subjectName: 'S', chunks: [], maxConcepts: 3 })).rejects.toMatchObject({ code: 'malformed' });
  });
  it('is never selected implicitly: needs AI_PROVIDER=groq plus key AND model; no silent fallback', () => {
    expect(buildProvider(baseCfg({ groqKey: 'g', groqModel: 'm' }))).toBeNull(); // provider defaults to anthropic, which has no key
    expect(buildProvider(baseCfg({ aiProvider: 'groq', groqKey: 'g', groqModel: null, anthropicKey: 'a' }))).toBeNull(); // no model => off, NOT anthropic
    expect(buildProvider(baseCfg({ aiProvider: 'groq', groqKey: 'g', groqModel: 'm' }))!.name).toBe('groq:m');
  });
});

describe('setup states and secrets', () => {
  it('walks offline → configured-unverified → connection-verified, and verify_failed on rejected credentials', async () => {
    s = await startServer();
    expect((await s.call('GET', '/api/status')).body.ai.mode).toBe('offline');
    expect((await s.call('POST', '/api/ai/verify', {})).status).toBe(409);
    await s.close();

    const t = new Scripted(() => resp('OK'));
    s = await startServer({ llm: new LLMProvider(t) });
    expect((await s.call('GET', '/api/status')).body.ai).toMatchObject({ mode: 'configured_unverified', live: true });
    const v = await s.call('POST', '/api/ai/verify', {});
    expect(v.body.results).toEqual([{ model: 'claude-sonnet-5-5', ok: true, latencyMs: expect.any(Number) }]);
    expect(v.body.ai.mode).toBe('connection_verified'); // HTTP works; no study output has been validated
    expect(rows()[0]).toMatchObject({ purpose: 'verify', outcome: 'ok' });
    t.script = () => new AIError('not_configured', 'rejected');
    s.clock.now += 1000;
    const bad = await s.call('POST', '/api/ai/verify', {});
    expect(bad.body.results[0]).toMatchObject({ ok: false }); expect(bad.body.ai.mode).toBe('verify_failed');
  });
  it('the sample workspace never uses a paid model', async () => {
    s = await startServer({ llm: new LLMProvider(new Scripted(() => resp('OK'))) });
    expect((await s.call('POST', '/api/ai/verify', {}, 'demo')).status).toBe(409);
    expect((await s.call('GET', '/api/status', undefined, 'demo')).body.ai.live).toBe(false);
  });
  it('reports calendar state and the exact redirect URI to register', async () => {
    s = await startServer({ cfg: { googleRedirectUri: 'http://localhost:8787/api/calendar/oauth/callback' } });
    const c = (await s.call('GET', '/api/status')).body;
    expect(c.calendar).toMatchObject({ state: 'not_configured', redirectUri: 'http://localhost:8787/api/calendar/oauth/callback' });
    expect(c.boundary).toMatch(/no login/i);
  });
  it('never exposes or logs credentials', async () => {
    const CANARY = 'sk-ant-CANARY-9f8e7d6c5b4a';
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a.map(String).join(' ')); });
    const t = new AnthropicTransport(CANARY, 'claude-sonnet-5-5', (async (_u: string, init: RequestInit) => new Response('{}', { status: String((init.headers as any)['x-api-key']) === CANARY ? 401 : 200 })) as unknown as typeof fetch);
    const { src } = await withSource({ llm: new LLMProvider(t), cfg: { anthropicKey: CANARY, appSecret: 'A'.repeat(40), google: { clientId: 'gid-CANARY', clientSecret: 'gsecret-CANARY', redirectUri: 'http://x/cb' } } });
    const seen: string[] = [];
    const grab = async (m: string, p: string, b?: unknown) => { seen.push(JSON.stringify((await s.call(m, p, b)).body)); };
    await grab('POST', `/api/sources/${src}/extract`, {}); await grab('POST', '/api/ai/verify', {});
    for (const p of ['/api/status', '/api/ai/usage', '/api/settings', '/api/meta', '/api/calendar', '/api/today']) await grab('GET', p);
    const all = seen.join('\n') + logs.join('\n');
    for (const secret of [CANARY, 'A'.repeat(40), 'gsecret-CANARY', 'gid-CANARY']) expect(all).not.toContain(secret);
  });
});

describe('ANTHROPIC_BASE_URL safety', () => {
  it('only accepts https (or http on localhost) so a key is never sent in clear text to a remote host', () => {
    expect(configFromEnv({ ANTHROPIC_BASE_URL: 'http://evil.example.com' } as never).anthropicBaseUrl).toBe('https://api.anthropic.com');
    expect(configFromEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8798/' } as never).anthropicBaseUrl).toBe('http://127.0.0.1:8798');
    expect(configFromEnv({ ANTHROPIC_BASE_URL: 'https://proxy.example.com' } as never).anthropicBaseUrl).toBe('https://proxy.example.com');
    expect(configFromEnv({} as never).anthropicBaseUrl).toBe('https://api.anthropic.com');
  });
});
