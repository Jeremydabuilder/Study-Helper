import { randomUUID } from 'node:crypto';
import { AIError, BillingKind, PreRequest, RequestLedger, RequestRecord } from '../../ai/provider';
import { costOfRecord } from '../../ai/ledger';
import { reservationUsd } from '../../ai/pricing';
import { HttpError } from '../services/common';
import { Pool, tx } from './pg';

/**
 * Shared limits for a hosted pilot. Everything that must be atomic across students (and across server instances) is a PostgreSQL transaction;
 * process-local gates only protect this process's CPU and memory.
 */
export interface Limits {
  userDailyRequests: number; userDailyUsd: number; globalDailyUsd: number;
  userConcurrentAi: number; globalConcurrentAi: number;
  userDailyUploads: number; userDailyUploadMb: number; userStorageMb: number;
  userDailyChat: number; userDailyExtractions: number;
  globalConcurrentExtractions: number; userConcurrentExtractions: number;
  /** a reservation that never settled (a crashed process) stops counting as "in flight" after this long, but keeps its worst-case cost held for 24 hours */
  reservationTtlMs: number;
}
export const DEFAULT_LIMITS: Limits = {
  userDailyRequests: 60, userDailyUsd: 0.3, globalDailyUsd: 5,
  userConcurrentAi: 2, globalConcurrentAi: 6,
  userDailyUploads: 12, userDailyUploadMb: 60, userStorageMb: 150,
  userDailyChat: 40, userDailyExtractions: 15,
  globalConcurrentExtractions: 2, userConcurrentExtractions: 1,
  reservationTtlMs: 3 * 60_000,
};

const DAY_MS = 86_400_000;
const LOCK_LEDGER = 727_002;

/** Shown to students. It never names operators, models, keys or other students. */
const MSG = {
  userRequests: 'You have used today’s study-assistant allowance. Everything else keeps working, and it resets within 24 hours.',
  userBudget: 'You have used today’s study-assistant allowance. Everything else keeps working, and it resets within 24 hours.',
  global: 'The study assistant is paused for everyone for now to keep costs under control. Practice, notes and reviews still work; try again later.',
  busy: 'Your study assistant is already working on other requests. Wait a moment and try again.',
  busyGlobal: 'The study assistant is busy right now. Try again in a minute.',
};

/**
 * The shared ledger. One transaction per reservation, serialised with a transaction-level advisory lock, so concurrent requests (from any instance)
 * cannot each spend the same remaining allowance. Reservations hold the worst case until the real usage is known; a request that dies mid-flight keeps its hold.
 */
export class PgLedger implements RequestLedger {
  constructor(private pool: Pool, private userId: string, private limits: Limits, private now: () => number, private priceOverride: { inPerM?: number; outPerM?: number } = {}) {}

  async reserve(p: PreRequest): Promise<string> {
    const worst = reservationUsd(p.model, p.inputBytes, p.maxOutputTokens, this.priceOverride);
    const id = randomUUID();
    const now = new Date(this.now());
    const L = this.limits;
    await tx(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_LEDGER]);
      // a reservation that outlived its time-to-live belongs to a request that died: keep its worst case held as unknown billing
      await c.query("UPDATE ai_requests SET status = 'abandoned', unknown_usd = worst_usd, reserved_usd = 0, outcome = 'abandoned', billing = 'unknown' WHERE status = 'reserved' AND created_at < $1", [new Date(now.getTime() - L.reservationTtlMs)]);
      const since = new Date(now.getTime() - DAY_MS);
      const mine = (await c.query("SELECT COUNT(*)::int n, COALESCE(SUM(usd + reserved_usd + unknown_usd),0) held, COUNT(*) FILTER (WHERE status = 'reserved')::int inflight FROM ai_requests WHERE user_id = $1 AND created_at > $2", [this.userId, since])).rows[0];
      const all = (await c.query("SELECT COALESCE(SUM(usd + reserved_usd + unknown_usd),0) held, COUNT(*) FILTER (WHERE status = 'reserved')::int inflight FROM ai_requests WHERE created_at > $1", [since])).rows[0];
      if (all.held + worst > L.globalDailyUsd) throw new AIError('budget_reached', MSG.global);
      if (all.inflight >= L.globalConcurrentAi) throw new AIError('rate_limited', MSG.busyGlobal, 3000);
      if (mine.n >= L.userDailyRequests) throw new AIError('limit_reached', MSG.userRequests);
      if (mine.held + worst > L.userDailyUsd) throw new AIError('budget_reached', MSG.userBudget);
      if (mine.inflight >= L.userConcurrentAi) throw new AIError('rate_limited', MSG.busy, 2000);
      await c.query('INSERT INTO ai_requests (id, user_id, purpose, provider, model, attempt, status, worst_usd, reserved_usd, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)',
        [id, this.userId, p.purpose, p.provider, p.model, p.attempt, 'reserved', worst, now]);
    });
    return id;
  }

  async settle(id: string, r: RequestRecord): Promise<void> {
    await tx(this.pool, async (c) => {
      const row = (await c.query('SELECT worst_usd FROM ai_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!row) return;
      const cost = costOfRecord(r, row.worst_usd, this.priceOverride); // also right for a late settle after the hold was abandoned
      await c.query("UPDATE ai_requests SET status = 'settled', usd = $2, reserved_usd = 0, unknown_usd = 0, outcome = $3, billing = $4, input_tokens = $5, output_tokens = $6, model = $7, settled_at = $8 WHERE id = $1",
        [id, cost.usd, r.outcome, r.billing, r.inputTokens, r.outputTokens, r.model, new Date(this.now())]);
    });
  }

  async fail(id: string, f: { outcome: string; billing: BillingKind; latencyMs: number }): Promise<void> {
    // unknown billing keeps the worst-case hold; a confirmed-not-sent or provider-error response releases it
    await this.pool.query("UPDATE ai_requests SET status = 'settled', outcome = $2, billing = $3, reserved_usd = 0, usd = 0, unknown_usd = CASE WHEN $3 = 'unknown' THEN worst_usd ELSE 0 END, settled_at = $4 WHERE id = $1",
      [id, f.outcome, f.billing, new Date(this.now())]);
  }
}

/** Student-facing numbers for the assistant allowance (never dollar amounts or model names). */
export async function assistantState(pool: Pool, userId: string, limits: Limits, now: number) {
  const since = new Date(now - DAY_MS);
  const mine = (await pool.query('SELECT COUNT(*)::int n, COALESCE(SUM(usd + reserved_usd + unknown_usd),0) held FROM ai_requests WHERE user_id = $1 AND created_at > $2', [userId, since])).rows[0];
  const all = (await pool.query('SELECT COALESCE(SUM(usd + reserved_usd + unknown_usd),0) held FROM ai_requests WHERE created_at > $1', [since])).rows[0];
  const globalPaused = all.held >= limits.globalDailyUsd;
  const userPaused = mine.n >= limits.userDailyRequests || mine.held >= limits.userDailyUsd;
  return { state: globalPaused ? 'paused_global' : userPaused ? 'paused_user' : 'available', usedRequests: mine.n, dailyRequests: limits.userDailyRequests } as const;
}

/** Operator report: totals only, never content. */
export async function spendReport(pool: Pool, now: number) {
  const since = new Date(now - DAY_MS);
  const g = (await pool.query("SELECT COUNT(*)::int n, COALESCE(SUM(usd),0) usd, COALESCE(SUM(unknown_usd),0) unknown, COALESCE(SUM(reserved_usd),0) reserved FROM ai_requests WHERE created_at > $1", [since])).rows[0];
  const top = (await pool.query("SELECT COUNT(*)::int n, COALESCE(SUM(usd + unknown_usd + reserved_usd),0) held FROM ai_requests WHERE created_at > $1 AND user_id IS NOT NULL GROUP BY user_id ORDER BY held DESC LIMIT 5", [since])).rows;
  return { last24h: g, topFiveUsers: top.map((t) => ({ requests: t.n, usd: t.held })) };
}

/** Atomically count one use against a daily cap. Rejects with a student-readable 429 when the cap is reached; the count is never exceeded under concurrency. */
export async function consumeQuota(pool: Pool, userId: string, kind: string, o: { limit: number; bytes?: number; bytesLimit?: number; now: number; message: string }) {
  const day = new Date(o.now).toISOString().slice(0, 10);
  const bytes = Math.max(0, Math.floor(o.bytes ?? 0));
  if (o.bytesLimit !== undefined && bytes > o.bytesLimit) throw new HttpError(413, 'too_large', o.message);
  const r = await pool.query(
    `INSERT INTO usage_counters (user_id, day, kind, n, bytes) VALUES ($1,$2,$3,1,$4)
     ON CONFLICT (user_id, day, kind) DO UPDATE SET n = usage_counters.n + 1, bytes = usage_counters.bytes + $4
       WHERE usage_counters.n < $5 AND ($6::bigint IS NULL OR usage_counters.bytes + $4 <= $6)
     RETURNING n`, [userId, day, kind, bytes, o.limit, o.bytesLimit ?? null]);
  if (!r.rowCount) throw new HttpError(429, 'daily_limit', o.message, { retryable: false });
}

/** Process-local concurrency gate: at most `total` running, `perKey` per student. A full gate refuses at once (never queues), so one student's slow job cannot stall others. */
export class Gate {
  private running = 0; private byKey = new Map<string, number>();
  constructor(private total: number, private perKey: number, private message: string) {}
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.total || (this.byKey.get(key) ?? 0) >= this.perKey) throw new HttpError(429, 'busy', this.message, { retryable: true, retryAfterMs: 5000 });
    this.running++; this.byKey.set(key, (this.byKey.get(key) ?? 0) + 1);
    try { return await fn(); }
    finally { this.running--; const n = (this.byKey.get(key) ?? 1) - 1; n <= 0 ? this.byKey.delete(key) : this.byKey.set(key, n); }
  }
  get active() { return this.running; }
}

/** Sliding-window rate limiter keyed by student (or IP for signed-out endpoints). Process-local: it bounds abuse of this instance, it is not an accounting system. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}
  check(key: string): { ok: boolean; retryAfterMs: number } {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return { ok: false, retryAfterMs: this.windowMs - (t - arr[0]) }; }
    arr.push(t); this.hits.set(key, arr);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.length || t - v[v.length - 1] > this.windowMs) this.hits.delete(k);
    return { ok: true, retryAfterMs: 0 };
  }
}
