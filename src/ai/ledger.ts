import { randomUUID } from 'node:crypto';
import { AIError, BillingKind, PreRequest, RequestLedger, RequestRecord } from './provider';
import { Override, estimateCost, reservationUsd } from './pricing';

/** Cost of a finished request, from provider-reported usage when present, else the conservative reservation. */
export function costOfRecord(r: Pick<RequestRecord, 'model' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'billing'>, reserved: number, ov: Override): { usd: number; known: boolean } {
  if (r.billing === 'none_reported' || r.billing === 'not_sent') return { usd: 0, known: true };
  if (r.billing === 'reported') {
    const c = estimateCost(r.model, { inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens }, ov);
    return { usd: c.usd, known: c.known };
  }
  return { usd: reserved, known: estimateCost(r.model, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, ov).known }; // estimated / unknown: hold the reservation
}

export interface LedgerRow extends RequestRecord { id: string; usd: number; known: boolean; reservedUsd: number }

/** In-process ledger (evaluation runner, tests). Same semantics as the database ledger, no persistence. */
export class MemoryLedger implements RequestLedger {
  rows: LedgerRow[] = [];
  private open = new Map<string, { p: PreRequest; reserved: number }>();
  constructor(private o: { budgetUsd?: number; requestLimit?: number; priceOverride?: Override } = {}) {}
  get spentUsd() { return this.rows.reduce((a, r) => a + r.usd, 0); }
  get reservedUsd() { return [...this.open.values()].reduce((a, r) => a + r.reserved, 0); }
  reserve(p: PreRequest): string {
    if (this.o.requestLimit !== undefined && this.rows.length + this.open.size >= this.o.requestLimit) throw new AIError('limit_reached', `Request limit ${this.o.requestLimit} reached.`);
    const worst = reservationUsd(p.model, p.inputBytes, p.maxOutputTokens, this.o.priceOverride);
    if (this.o.budgetUsd !== undefined && this.spentUsd + this.reservedUsd + worst > this.o.budgetUsd)
      throw new AIError('budget_reached', `Budget $${this.o.budgetUsd.toFixed(2)} would be exceeded (spent+held ≈ $${(this.spentUsd + this.reservedUsd).toFixed(4)}, this request could cost up to $${worst.toFixed(4)}).`);
    const id = randomUUID();
    this.open.set(id, { p, reserved: worst });
    return id;
  }
  settle(id: string, r: RequestRecord) {
    const o = this.open.get(id); if (!o) return; this.open.delete(id);
    const c = costOfRecord(r, o.reserved, this.o.priceOverride ?? {});
    this.rows.push({ ...r, id, usd: c.usd, known: c.known, reservedUsd: 0 });
  }
  fail(id: string, f: { outcome: string; billing: BillingKind; latencyMs: number }) {
    const o = this.open.get(id); if (!o) return; this.open.delete(id);
    const rec: RequestRecord = { purpose: o.p.purpose, provider: o.p.provider, model: o.p.model, attempt: o.p.attempt, outcome: f.outcome, latencyMs: f.latencyMs, inputTokens: null, outputTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0, billing: f.billing, stopReason: null, requestId: null };
    this.rows.push({ ...rec, id, usd: costOfRecord(rec, o.reserved, this.o.priceOverride ?? {}).usd, known: true, reservedUsd: 0 });
  }
}
