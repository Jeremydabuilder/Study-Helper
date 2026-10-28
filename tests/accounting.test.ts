import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicTransport, LLMProvider, LLMRequest, LLMResponse, LLMTransport, classifyFetchFailure, credentialFingerprint } from '../src/ai/llm';
import { AIError } from '../src/ai/provider';
import { MemoryLedger } from '../src/ai/ledger';
import { reservationUsd } from '../src/ai/pricing';
import { openDb } from '../src/server/db';
import { DbLedger, recoverOrphans } from '../src/server/services/ledger';
import { aiInfo, deriveVerification, metered, usageReport } from '../src/server/services/common';
import { baseCfg } from './helpers';

const CONCEPTS = JSON.stringify({ concepts: [{ name: 'Photosynthesis', summary: 'How plants make glucose.', quotes: [], prerequisites: [] }] });
const resp = (text: string, usage: LLMResponse['usage'] = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }, stopReason = 'end_turn'): LLMResponse => ({ text, model: 'claude-sonnet-5-5', stopReason, requestId: 'r', usage });
const EX = { subjectName: 'Sci', maxConcepts: 5, chunks: [{ id: '0', label: 'p.1', text: 'Photosynthesis turns light into glucose.' }] };

class T implements LLMTransport {
  provider = 'anthropic'; defaultModel = 'claude-sonnet-5-5'; credentialFingerprint = 'fpA'; n = 0; inflight = 0; maxInflight = 0;
  constructor(public script: (n: number, r: LLMRequest) => LLMResponse | Error | Promise<LLMResponse | Error>) {}
  async complete(r: LLMRequest) {
    const n = ++this.n; this.inflight++; this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try { const out = await this.script(n, r); if (out instanceof Error) throw out; return out; } finally { this.inflight--; }
  }
}
const mk = (over = {}) => { let now = Date.UTC(2026, 9, 26, 20); const clock = { get now() { return now; }, set now(v: number) { now = v; } }; const db = openDb(':memory:'); const cfg = baseCfg(over); return { db, cfg, clock, env: { db, cfg, now: () => clock.now } }; };
const rows = (db: ReturnType<typeof openDb>) => db.all<any>('SELECT * FROM ai_usage ORDER BY id');

describe('reservations are atomic', () => {
  it('parallel calls cannot spend the same budget: only as many start as the budget can hold', async () => {
    const { env, db } = mk({ aiDailyBudgetUsd: 0.15 }); // each extract reserves ≈ $0.05–0.07 at default limits
    const one = reservationUsd('claude-sonnet-5-5', 1000, 4000);
    const t = new T(async () => { await new Promise((r) => setTimeout(r, 30)); return resp(CONCEPTS); });
    const llm = metered(env as any, new LLMProvider(t));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => llm.extractConcepts(EX)));
    const started = t.n, refused = results.filter((r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason.code === 'budget_reached').length;
    expect(started).toBeLessThanOrEqual(Math.floor(0.15 / one));
    expect(started).toBeGreaterThan(1); expect(refused).toBeGreaterThan(0);
    expect(started + refused).toBe(8);
    expect(t.maxInflight).toBe(started); // they really were concurrent, and reservations still held
    expect(rows(db).every((r) => r.status === 'settled')).toBe(true);
  });
  it('every reserved request gets a unique identity even for the same purpose and attempt', async () => {
    const { env, db } = mk();
    const t = new T(async () => { await new Promise((r) => setTimeout(r, 10)); return resp(CONCEPTS); });
    const llm = metered(env as any, new LLMProvider(t));
    await Promise.all([llm.extractConcepts(EX), llm.extractConcepts(EX), llm.extractConcepts(EX)]);
    const r = rows(db);
    expect(new Set(r.map((x) => x.request_uid)).size).toBe(3);
    expect(r.every((x) => x.input_tokens === 1000 && x.billing === 'reported')).toBe(true); // none overwritten by a sibling
  });
  it('settling twice is impossible and a request cannot exceed its own reservation hold', () => {
    const { env, db } = mk();
    const l = new DbLedger(env as any);
    const id = l.reserve({ purpose: 'extract', provider: 'anthropic', model: 'claude-sonnet-5-5', attempt: 1, maxOutputTokens: 1000, inputBytes: 100, credFp: null });
    expect(usageReport({ ...env, ai: { live: true } } as any).inFlight).toBe(1);
    const rec = { purpose: 'extract', provider: 'anthropic', model: 'claude-sonnet-5-5', attempt: 1, outcome: 'ok', latencyMs: 5, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, billing: 'reported' as const, stopReason: 'end_turn', requestId: null };
    l.settle(id, rec); const cost = rows(db)[0].est_cost_usd; l.settle(id, { ...rec, inputTokens: 99999 });
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0].reserved_usd).toBe(0); expect(cost).toBeCloseTo((100 * 2 + 10 * 10) / 1e6, 9);
  });
});

describe('abandoned reservations', () => {
  it('a reservation whose process died stays held as unknown billing, never silently released or counted as zero', () => {
    const { env, db } = mk();
    const l = new DbLedger(env as any);
    l.reserve({ purpose: 'generate', provider: 'anthropic', model: 'claude-sonnet-5-5', attempt: 1, maxOutputTokens: 6000, inputBytes: 5000, credFp: null });
    expect(recoverOrphans(db)).toBe(1); // what happens when the workspace reopens after a crash
    const r = rows(db)[0];
    expect(r).toMatchObject({ status: 'abandoned', billing: 'unknown', reserved_usd: 0 });
    expect(r.unknown_usd).toBeGreaterThan(0);
    expect(usageReport({ ...env, ai: { live: true } } as any).unknownBilling.heldUsd).toBeCloseTo(r.unknown_usd, 9);
  });
  it('an expired in-flight reservation is recovered on the next reserve; a late response then reconciles to its real cost', () => {
    const { env, db, clock } = mk();
    const l = new DbLedger(env as any);
    const id = l.reserve({ purpose: 'extract', provider: 'anthropic', model: 'claude-sonnet-5-5', attempt: 1, maxOutputTokens: 4000, inputBytes: 2000, credFp: null });
    clock.now += env.cfg.aiTimeoutMs + 61_000;
    l.reserve({ purpose: 'extract', provider: 'anthropic', model: 'claude-sonnet-5-5', attempt: 1, maxOutputTokens: 4000, inputBytes: 2000, credFp: null });
    expect(rows(db)[0]).toMatchObject({ status: 'abandoned', billing: 'unknown' });
    l.settle(id, { purpose: 'extract', provider: 'anthropic', model: 'claude-sonnet-5-5', attempt: 1, outcome: 'ok', latencyMs: 9, inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, billing: 'reported', stopReason: 'end_turn', requestId: 'x' });
    expect(rows(db)[0]).toMatchObject({ status: 'settled', billing: 'reported', unknown_usd: 0 });
    expect(rows(db)[0].est_cost_usd).toBeCloseTo((500 * 2 + 50 * 10) / 1e6, 9);
  });
  it('held unknown spend counts against the budget until it ages out of the 24 h window', async () => {
    const { env, clock } = mk({ aiDailyBudgetUsd: 0.1 });
    const t = new T(() => new AIError('timeout', 'timed out', undefined, 'unknown'));
    const llm = metered(env as any, new LLMProvider(t));
    await expect(llm.extractConcepts(EX)).rejects.toMatchObject({ code: 'timeout' });
    await expect(llm.extractConcepts(EX)).rejects.toMatchObject({ code: 'timeout' });
    await expect(llm.extractConcepts(EX)).rejects.toMatchObject({ code: 'budget_reached' }); // two unconfirmed timeouts hold the budget
    clock.now += 25 * 3600_000;
    await expect(llm.extractConcepts(EX)).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('billing certainty', () => {
  it('confirmed zero (429, auth, connection refused) is distinct from unknown (timeout, dropped connection)', async () => {
    const { env, db } = mk();
    const cases: [AIError | Error, string, number][] = [
      [new AIError('rate_limited', 'busy', 1000, 'none_reported'), 'none_reported', 0],
      [new AIError('not_configured', 'bad key', undefined, 'none_reported'), 'none_reported', 0],
      [new AIError('unavailable', 'refused', undefined, 'not_sent'), 'not_sent', 0],
      [new AIError('timeout', 'slow'), 'unknown', 1],
    ];
    for (const [err, billing, held] of cases) {
      const llm = metered(env as any, new LLMProvider(new T(() => err)));
      await llm.gradeAnswer({ question: { prompt: 'q', kind: 'short_answer', rubric: [] }, answer: 'a', reasoning: '', excerpts: [] }).catch(() => {});
      const r = rows(db).at(-1);
      expect(r.billing).toBe(billing); expect(r.est_cost_usd).toBe(0); expect(r.unknown_usd > 0).toBe(!!held);
    }
  });
  it('classifies low-level fetch failures conservatively', () => {
    expect(classifyFetchFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toMatchObject({ code: 'timeout', billing: 'unknown' });
    expect(classifyFetchFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toMatchObject({ billing: 'not_sent' });
    expect(classifyFetchFailure(new TypeError('fetch failed'))).toMatchObject({ billing: 'unknown' });
  });
  it('a refused, empty or truncated 200 still records its reported usage and cost', async () => {
    const { env, db } = mk();
    for (const [stop, text, outcome] of [['refusal', '', 'refused'], ['end_turn', '  ', 'empty'], ['max_tokens', '{"concepts":[', 'truncated']] as const) {
      const llm = metered(env as any, new LLMProvider(new T(() => resp(text, { input: 700, output: 90, cacheRead: 0, cacheWrite: 0 }, stop))));
      await llm.extractConcepts(EX).catch(() => {});
      const r = rows(db).filter((x) => x.outcome === outcome);
      expect(r.length).toBeGreaterThan(0);
      expect(r[0]).toMatchObject({ billing: 'reported', input_tokens: 700, output_tokens: 90 });
      expect(r[0].est_cost_usd).toBeCloseTo((700 * 2 + 90 * 10) / 1e6, 9);
    }
  });
  it('an empty reply is retried once (both billed); a refusal is not retried', async () => {
    const { env, db } = mk();
    const t = new T((n) => (n === 1 ? resp('') : resp(CONCEPTS)));
    await metered(env as any, new LLMProvider(t)).extractConcepts(EX);
    expect(rows(db).map((r) => [r.attempt, r.outcome])).toEqual([[1, 'empty'], [2, 'ok']]);
    const t2 = new T(() => resp('', undefined, 'refusal'));
    await metered(env as any, new LLMProvider(t2)).extractConcepts(EX).catch(() => {});
    expect(t2.n).toBe(1);
  });
  it('missing usage is labelled estimated and held at the conservative reservation, not zero', async () => {
    const { env, db } = mk();
    await metered(env as any, new LLMProvider(new T(() => resp(CONCEPTS, null)))).extractConcepts(EX);
    const r = rows(db)[0];
    expect(r.billing).toBe('estimated'); expect(r.est_cost_usd).toBeCloseTo(r.worst_usd, 9); expect(r.est_cost_usd).toBeGreaterThan(0);
    expect(usageReport({ ...env, ai: { live: true } } as any).billing.estimated).toBe(1);
  });
  it('the in-process ledger used by the evaluation runner applies the same budget guard', () => {
    const l = new MemoryLedger({ budgetUsd: 0.01 });
    const p = { purpose: 'extract', provider: 'anthropic', model: 'claude-sonnet-5-5', attempt: 1, maxOutputTokens: 4000, inputBytes: 100, credFp: null };
    expect(() => l.reserve(p)).toThrow(/Budget/);
    expect(l.rows).toHaveLength(0);
  });
});

describe('verification state', () => {
  const info = (llm: any, env: ReturnType<typeof mk>) => aiInfo({ db: env.db, cfg: env.cfg, now: env.env.now, ai: metered(env.env as any, llm), workspace: 'real' } as any);
  it('connection ≠ study output: invalid structured output never counts as verified', async () => {
    const e = mk(); const t = new T(() => resp('OK'));
    const llm = new LLMProvider(t); const m = metered(e.env as any, llm);
    expect(info(llm, e).mode).toBe('configured_unverified');
    await m.verify!(undefined);
    expect(info(llm, e).mode).toBe('connection_verified');
    t.script = () => resp('not json at all');
    await m.extractConcepts(EX).catch(() => {});
    const bad = info(llm, e);
    expect(bad.mode).toBe('output_problem');
    expect(bad.verification.find((v) => v.task === 'extract')!.status).toBe('output_invalid');
    t.script = () => resp(CONCEPTS);
    await m.extractConcepts(EX);
    expect(info(llm, e).verification.find((v) => v.task === 'extract')!.status).toBe('output_verified');
  });
  it('success is keyed to provider + model + credential: a model or key change starts unverified', async () => {
    const e = mk(); const t = new T(() => resp(CONCEPTS));
    const llm = new LLMProvider(t); await metered(e.env as any, llm).extractConcepts(EX);
    expect(deriveVerification(e.db, llm).find((v) => v.task === 'extract')!.status).toBe('output_verified');
    const other = new LLMProvider(Object.assign(new T(() => resp(CONCEPTS)), { credentialFingerprint: 'fpB' }));
    expect(deriveVerification(e.db, other).find((v) => v.task === 'extract')!.status).toBe('unverified');
    const newModel = new LLMProvider(t, { tasks: { extract: { model: 'claude-haiku-5-5' } } } as any);
    expect(deriveVerification(e.db, newModel).find((v) => v.task === 'extract')!.status).toBe('unverified');
  });
  it('a later authentication failure outranks an older success', async () => {
    const e = mk(); const t = new T(() => resp(CONCEPTS));
    const llm = new LLMProvider(t); const m = metered(e.env as any, llm);
    await m.extractConcepts(EX);
    e.clock.now += 1000; t.script = () => new AIError('not_configured', 'rejected', undefined, 'none_reported');
    await m.extractConcepts(EX).catch(() => {});
    expect(info(llm, e).mode).toBe('verify_failed');
  });
  it('credential fingerprints never contain the secret', () => {
    const f = credentialFingerprint('anthropic', 'sk-ant-SECRET', 'https://api.anthropic.com');
    expect(f).toMatch(/^[0-9a-f]{12}$/); expect(f).not.toContain('SECRET');
    expect(f).not.toBe(credentialFingerprint('anthropic', 'sk-ant-OTHER', 'https://api.anthropic.com'));
  });
});
