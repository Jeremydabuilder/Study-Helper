import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AIError, PreRequest } from '../src/ai/provider';
import { reservationUsd } from '../src/ai/pricing';
import { Gate, PgLedger, RateLimiter, DEFAULT_LIMITS, Limits, consumeQuota, assistantState } from '../src/server/hosted/limits';
import { PG_AVAILABLE, TestDb, createTestDb } from './pgHarness';

const d = describe.skipIf(!PG_AVAILABLE);
let db: TestDb;
beforeAll(async () => { if (PG_AVAILABLE) db = await createTestDb(); });
afterAll(async () => { await db?.drop(); });
let clock = Date.UTC(2026, 9, 29, 12, 0, 0);
const now = () => clock;
const P = (o: Partial<PreRequest> = {}): PreRequest => ({ purpose: 'generate', provider: 'anthropic', model: 'claude-sonnet-5-5', attempt: 1, maxOutputTokens: 1000, inputBytes: 4000, credFp: null, ...o });
const L = (o: Partial<Limits> = {}): Limits => ({ ...DEFAULT_LIMITS, ...o });
const ledger = (user: string, lim: Limits) => new PgLedger(db.pool, user, lim, now);
const rec = (o: object = {}) => ({ purpose: 'generate', provider: 'anthropic', model: 'claude-sonnet-5-5', attempt: 1, outcome: 'ok', latencyMs: 5, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, billing: 'reported' as const, stopReason: 'end_turn', requestId: null, ...o });
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof AIError ? e.code : `other:${e?.message}`));

d('shared spending ledger (real PostgreSQL)', () => {
  it('per-user daily request cap, and one student reaching it does not affect another', async () => {
    const lim = L({ userDailyRequests: 3, userConcurrentAi: 10 });
    const a = ledger('alice', lim), b = ledger('bob', lim);
    for (let i = 0; i < 3; i++) await a.settle(await a.reserve(P()), rec());
    expect(await code(a.reserve(P()))).toBe('limit_reached');
    expect(await code(b.reserve(P()))).toBe('ok'); // an expensive neighbour does not block bob
  });

  it('concurrent reservations never overspend: 30 simultaneous requests against room for exactly 5', async () => {
    const worst = reservationUsd('claude-sonnet-5-5', 4000, 1000); // exactly what one P() reserves
    const lim = L({ userDailyRequests: 1000, userDailyUsd: 100, globalDailyUsd: worst * 5.5, userConcurrentAi: 100, globalConcurrentAi: 100 });
    clock += 3 * 86_400_000; // a fresh 24h window
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => code(ledger(`u${i % 6}`, lim).reserve(P()))));
    const ok = results.filter((r) => r === 'ok').length;
    expect(ok).toBe(5); // exactly the number that fit: no overspend, no needless refusals
    expect(results.filter((r) => r === 'budget_reached').length).toBe(30 - ok);
    const held = (await db.pool.query("SELECT COALESCE(SUM(reserved_usd),0) h FROM ai_requests WHERE created_at > $1", [new Date(clock - 1000)])).rows[0].h;
    expect(held).toBeLessThanOrEqual(worst * 5.5 + 1e-9); // the global guardrail held under contention
  });

  it('concurrency caps: a student cannot have more than N requests in flight; the rest are told to wait (retryable), not charged', async () => {
    clock += 3 * 86_400_000;
    const lim = L({ userConcurrentAi: 2, globalConcurrentAi: 50, userDailyRequests: 100, userDailyUsd: 100, globalDailyUsd: 100 });
    const a = ledger('carol', lim);
    const ids = [await a.reserve(P()), await a.reserve(P())];
    const err = await a.reserve(P()).catch((e) => e);
    expect(err).toBeInstanceOf(AIError); expect(err.code).toBe('rate_limited'); expect(err.retryable).toBe(true);
    await a.settle(ids[0], rec());
    expect(await code(a.reserve(P()))).toBe('ok'); // a slot freed
    await ledger('dave', lim).reserve(P()); // another student unaffected
  });

  it('a failed request with unknown billing keeps its hold; a confirmed-not-sent one releases it; settle uses the reported cost', async () => {
    clock += 3 * 86_400_000;
    const lim = L({ userConcurrentAi: 50 });
    const a = ledger('erin', lim);
    const unknown = await a.reserve(P()); await a.fail(unknown, { outcome: 'timeout', billing: 'unknown', latencyMs: 9 });
    const notSent = await a.reserve(P()); await a.fail(notSent, { outcome: 'error', billing: 'not_sent', latencyMs: 1 });
    const ok = await a.reserve(P()); await a.settle(ok, rec({ inputTokens: 1000, outputTokens: 200 }));
    const rows = (await db.pool.query("SELECT id, unknown_usd, usd, reserved_usd FROM ai_requests WHERE user_id = 'erin'")).rows;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[unknown].unknown_usd).toBeGreaterThan(0); expect(by[notSent].unknown_usd).toBe(0); expect(by[notSent].usd).toBe(0);
    expect(by[ok].usd).toBeCloseTo((1000 * 2 + 200 * 10) / 1e6, 6); expect(by[ok].reserved_usd).toBe(0);
  });

  it('a reservation from a crashed process stops counting as in flight after its TTL but keeps its worst-case cost held for 24h', async () => {
    clock += 3 * 86_400_000;
    const lim = L({ userConcurrentAi: 1, userDailyUsd: 100, globalDailyUsd: 100, reservationTtlMs: 60_000 });
    const a = ledger('frank', lim);
    await a.reserve(P()); // never settled: the process "died"
    expect(await code(a.reserve(P()))).toBe('rate_limited');
    clock += 61_000;
    expect(await code(a.reserve(P()))).toBe('ok');
    const abandoned = (await db.pool.query("SELECT status, unknown_usd FROM ai_requests WHERE user_id = 'frank' AND status = 'abandoned'")).rows;
    expect(abandoned).toHaveLength(1); expect(abandoned[0].unknown_usd).toBeGreaterThan(0);
  });

  it('student-facing state distinguishes "your allowance" from "paused for everyone" without exposing amounts', async () => {
    clock += 3 * 86_400_000;
    const lim = L({ userDailyRequests: 1, userConcurrentAi: 5 });
    const a = ledger('gina', lim); await a.settle(await a.reserve(P()), rec());
    expect(await assistantState(db.pool, 'gina', lim, clock)).toMatchObject({ state: 'paused_user' });
    expect(await assistantState(db.pool, 'hank', lim, clock)).toMatchObject({ state: 'available' });
    const err = await a.reserve(P()).catch((e) => e);
    expect(err.message).not.toMatch(/\$|usd|budget|model|claude/i);
  });
});

d('daily quotas and gates', () => {
  it('upload quota is atomic under concurrency and bounded by count and bytes', async () => {
    const opts = { limit: 5, bytesLimit: 10_000_000, now: clock, message: 'Upload limit reached for today.' };
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeQuota(db.pool, 'ivy', 'upload', { ...opts, bytes: 100 }).then(() => 'ok', (e) => e.code)));
    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect(results.filter((r) => r === 'daily_limit')).toHaveLength(15);
    await expect(consumeQuota(db.pool, 'jack', 'upload', { ...opts, bytes: 20_000_000 })).rejects.toMatchObject({ code: 'too_large' });
    await consumeQuota(db.pool, 'kim', 'upload', { ...opts, bytes: 6_000_000 }); // different student unaffected
    await expect(consumeQuota(db.pool, 'kim', 'upload', { ...opts, bytes: 6_000_000 })).rejects.toMatchObject({ code: 'daily_limit' }); // byte cap
  });

  it('gate refuses instead of queueing and frees slots on failure, so a stuck job cannot stall others', async () => {
    const g = new Gate(2, 1, 'busy');
    let release!: () => void;
    const long = g.run('a', () => new Promise<void>((r) => { release = r; }));
    await expect(g.run('a', async () => 1)).rejects.toMatchObject({ code: 'busy' }); // same student: one at a time
    await g.run('b', async () => 1); // another student still runs
    await expect(g.run('c', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await g.run('c', async () => 1); // the failed job released its slot
    release(); await long;
    expect(g.active).toBe(0);
  });

  it('rate limiter allows a burst up to the cap per key then refuses with a retry time, per key', () => {
    let t = 0; const r = new RateLimiter(3, 1000, () => t);
    expect([1, 2, 3, 4].map(() => r.check('x').ok)).toEqual([true, true, true, false]);
    expect(r.check('y').ok).toBe(true);
    t = 1100; expect(r.check('x').ok).toBe(true);
  });
});
