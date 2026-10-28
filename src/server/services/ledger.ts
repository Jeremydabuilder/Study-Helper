/**
 * Database-backed request ledger. reserve() is one synchronous BEGIN IMMEDIATE transaction: it sums everything already
 * spent, held for unknown billing, and reserved by requests still in flight, and records the new reservation in the
 * same step. Parallel calls therefore cannot each spend the same remaining budget.
 */
import { randomUUID } from 'node:crypto';
import { AIError, BillingKind, PreRequest, RequestLedger, RequestRecord } from '../../ai/provider';
import { costOfRecord } from '../../ai/ledger';
import { reservationUsd } from '../../ai/pricing';
import type { Db } from '../db';
import { AppConfig, getSetting } from './common';

const DAY = 86_400_000;
type Env = { db: Db; now: () => number; cfg: AppConfig };

export const budgetUsd = (e: { db: Db; cfg: AppConfig }) => getSetting<number>(e.db, 'ai_daily_budget_usd', e.cfg.aiDailyBudgetUsd);
export const requestLimit = (e: { db: Db; cfg: AppConfig }) => getSetting<number>(e.db, 'ai_daily_limit', e.cfg.aiDailyLimit);

/** Unsettled reservations past their expiry: the request may or may not have been billed, so hold the worst case. */
export function recoverExpired(db: Db, now: number): number {
  return Number(db.run("UPDATE ai_usage SET status='abandoned', outcome='abandoned', billing='unknown', unknown_usd=worst_usd, reserved_usd=0 WHERE status='reserved' AND expires_at < ?", now).changes);
}
/** At startup every open reservation belongs to a request that died with the previous process. */
export function recoverOrphans(db: Db): number {
  return Number(db.run("UPDATE ai_usage SET status='abandoned', outcome='abandoned', billing='unknown', unknown_usd=worst_usd, reserved_usd=0 WHERE status='reserved'").changes);
}

export function window(db: Db, now: number) {
  return db.get<{ n: number; spent: number; unknown: number; reserved: number }>(
    'SELECT COUNT(*) n, COALESCE(SUM(est_cost_usd),0) spent, COALESCE(SUM(unknown_usd),0) unknown, COALESCE(SUM(reserved_usd),0) reserved FROM ai_usage WHERE ts > ?', now - DAY)!;
}

export class DbLedger implements RequestLedger {
  constructor(private e: Env) {}

  reserve(p: PreRequest): string {
    const { db, now, cfg } = this.e;
    return db.tx(() => {
      const t = now();
      recoverExpired(db, t);
      const w = window(db, t);
      if (w.n >= requestLimit(this.e)) throw new AIError('limit_reached', `Daily AI request limit reached (${requestLimit(this.e)}). Offline mode still works, or raise the limit in Settings.`);
      const worst = reservationUsd(p.model, p.inputBytes, p.maxOutputTokens, cfg.aiPriceOverride);
      const held = w.spent + w.unknown + w.reserved, budget = budgetUsd(this.e);
      if (held + worst > budget) {
        throw new AIError('budget_reached', `Daily AI budget reached: about $${w.spent.toFixed(3)} spent, $${(w.unknown + w.reserved).toFixed(3)} held for in-flight or unconfirmed requests, of $${budget.toFixed(2)}. This request could cost up to $${worst.toFixed(3)}. The budget is a guardrail based on list-price estimates, not a hard ceiling; provider billing is authoritative. Offline mode still works, or raise the budget in Settings.`);
      }
      const uid = randomUUID();
      db.run(`INSERT INTO ai_usage (ts,purpose,ok,provider,model,attempt,outcome,status,worst_usd,reserved_usd,expires_at,cred_fp,request_uid,usage_source,est_cost_usd,price_known)
        VALUES (?,?,0,?,?,?,?,?,?,?,?,?,?,?,0,1)`, t, p.purpose, p.provider, p.model, p.attempt, 'pending', 'reserved', worst, worst, t + cfg.aiTimeoutMs + 60_000, p.credFp, uid, 'none');
      return uid;
    });
  }

  settle(id: string, r: RequestRecord) {
    const { db, cfg } = this.e;
    db.tx(() => {
      const row = db.get<{ worst_usd: number }>('SELECT worst_usd FROM ai_usage WHERE request_uid = ?', id);
      if (!row) return;
      const c = costOfRecord(r, row.worst_usd, cfg.aiPriceOverride); // also correct for a late settle after the reservation was abandoned
      db.run(`UPDATE ai_usage SET status='settled', outcome=?, ok=?, error=?, ms=?, model=?, attempt=?, billing=?, input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=?,
        usage_source=?, est_cost_usd=?, price_known=?, stop_reason=?, request_id=?, reserved_usd=0, unknown_usd=0 WHERE request_uid=?`,
        r.outcome, Number(r.outcome === 'ok'), r.outcome === 'ok' ? null : r.outcome, r.latencyMs, r.model, r.attempt, r.billing, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens,
        r.billing === 'reported' ? 'provider' : r.billing === 'estimated' ? 'estimated' : 'none', c.usd, Number(c.known), r.stopReason, r.requestId, id);
    });
  }

  fail(id: string, f: { outcome: string; billing: BillingKind; latencyMs: number }) {
    const { db } = this.e;
    db.tx(() => {
      // unknown billing keeps the worst-case hold; a confirmed-not-sent or provider-error response releases it
      db.run(`UPDATE ai_usage SET status='settled', outcome=?, ok=0, error=?, ms=?, billing=?, reserved_usd=0, est_cost_usd=0, unknown_usd=CASE WHEN ?='unknown' THEN worst_usd ELSE 0 END WHERE request_uid=?`,
        f.outcome, f.outcome, f.latencyMs, f.billing, f.billing, id);
    });
  }
}
