import { AIProvider, RequestLedger, CallOpts, ClarifyInput, ExtractInput, GenerateInput, GradeInput, ReadInput, AssessItem, AssistInput, AnnotationFeedbackInput, ChatInput } from '../../ai/provider';
import { DEFAULT_TASKS, type TaskConfig } from '../../ai/llm';
import { PRICING_AS_OF } from '../../ai/pricing';
import { OfflineProvider } from '../../ai/offline';
import { Db, WorkspaceName } from '../db';
import { DEFAULT_WEIGHTS, PriorityWeights } from '../../core/priority';
import { AvailabilitySettings, DEFAULT_AVAILABILITY } from '../../core/schedule';
import { DEFAULT_PARAMS, SchedulerParams } from '../../core/learning';
import type { CalendarGateway } from './calendarGoogle';

export interface AppConfig {
  anthropicKey: string | null; model: string; anthropicBaseUrl: string;
  aiProvider: 'anthropic' | 'groq'; groqKey: string | null; groqModel: string | null;
  /** per-task overrides (model / maxOutputTokens / effort) */
  aiTasks: Partial<Record<'extract' | 'generate' | 'grade', Partial<TaskConfig>>>;
  ocr: { enabled: boolean; model: string | null; maxOutputTokens?: number };
  aiTimeoutMs: number; aiDailyLimit: number; aiDailyBudgetUsd: number; aiPriceOverride: { inPerM?: number; outPerM?: number };
  google: { clientId: string; clientSecret: string; redirectUri: string } | null;
  /** shown in setup so the operator can copy the exact redirect URI into Google Cloud Console */
  googleRedirectUri: string; googlePartial: boolean;
  appSecret: string | null; dataDir: string; production: boolean;
}

export interface Ctx {
  db: Db; workspace: WorkspaceName; now: () => number;
  /** provider for the current workspace (demo workspace never uses a paid model) */
  ai: AIProvider; offline: OfflineProvider; cfg: AppConfig;
  /** injectable for tests */ calendar: CalendarGateway;
  /** Hosted mode only: the authenticated student this context belongs to (derived from the session, never from the request body). */
  userId?: string; hosted?: boolean;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) { super(message); }
}

export const parse = <T>(s: string | null | undefined, fallback: T): T => { if (!s) return fallback; try { return JSON.parse(s) as T; } catch { return fallback; } };

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const r = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return r ? parse<T>(r.value, fallback) : fallback;
}
export function setSetting(db: Db, key: string, value: unknown, now: number) {
  db.run('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', key, JSON.stringify(value), now);
}
export const getWeights = (db: Db): PriorityWeights => ({ ...DEFAULT_WEIGHTS, ...getSetting<Partial<PriorityWeights>>(db, 'priority_weights', {}) });
export const getAvailability = (db: Db): AvailabilitySettings => ({ ...DEFAULT_AVAILABILITY, ...getSetting<Partial<AvailabilitySettings>>(db, 'availability', {}) });
export const getSchedulerParams = (db: Db): SchedulerParams => ({ ...DEFAULT_PARAMS, ...getSetting<Partial<SchedulerParams>>(db, 'scheduler_params', {}) });

export interface ProfileRow { name: string; grade: string; timezone: string; default_minutes: number; about: string }
export const getProfile = (db: Db) => db.get<ProfileRow>('SELECT name, grade, timezone, default_minutes, about FROM profile WHERE id = 1')!;

const DAY_MS = 86_400_000;
export { budgetUsd, requestLimit as callLimit } from './ledger';
import { DbLedger, budgetUsd as _budget, requestLimit as _limit, window as ledgerWindow, recoverExpired } from './ledger';

/** Spend over a rolling 24 hours: confirmed estimates, plus holds for in-flight and unconfirmed-billing requests. */
export function usageWindow(ctx: { db: Db; now: () => number }) {
  recoverExpired(ctx.db, ctx.now());
  const w = ledgerWindow(ctx.db, ctx.now());
  const billable = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM ai_usage WHERE ts > ? AND billing IN ('reported','estimated')", ctx.now() - DAY_MS)!.n;
  return { requests: w.n, billableRequests: billable, spentUsd: w.spent, heldUnknownUsd: w.unknown, reservedUsd: w.reserved, committedUsd: w.spent + w.unknown + w.reserved };
}

/**
 * Wraps a live provider with server-side enforcement: a request cap and an estimated-dollar budget, both checked inside
 * an atomic reservation BEFORE every request (retries included). See ai/pricing.ts for exactly what the reservation
 * does and does not promise. Offline providers pass through.
 */
export function metered(ctx: { db: Db; now: () => number; cfg: AppConfig }, inner: AIProvider, shared?: RequestLedger): AIProvider {
  if (!inner.live) return inner;
  const ledger = shared ?? new DbLedger(ctx);
  const o = (extra?: CallOpts): CallOpts => ({ ...extra, ledger });
  return {
    name: inner.name, live: true, label: inner.label, providerId: inner.providerId, credentialFingerprint: inner.credentialFingerprint, modelFor: inner.modelFor?.bind(inner),
    verify: inner.verify ? (opts, model) => inner.verify!(o(opts), model) : undefined,
    extractConcepts: (i: ExtractInput, opts?: CallOpts) => inner.extractConcepts(i, o(opts)),
    generateQuestions: (i: GenerateInput, opts?: CallOpts) => inner.generateQuestions(i, o(opts)),
    gradeAnswer: (i: GradeInput, opts?: CallOpts) => inner.gradeAnswer(i, o(opts)),
    assessSupport: inner.assessSupport ? (items: AssessItem[], opts?: CallOpts) => inner.assessSupport!(items, o(opts)) : undefined,
    readPages: inner.readPages ? (i: ReadInput, opts?: CallOpts) => inner.readPages!(i, o(opts)) : undefined, ocrModel: inner.ocrModel?.bind(inner),
    assist: inner.assist ? (i: AssistInput, opts?: CallOpts) => inner.assist!(i, o(opts)) : undefined,
    annotationFeedback: inner.annotationFeedback ? (i: AnnotationFeedbackInput, opts?: CallOpts) => inner.annotationFeedback!(i, o(opts)) : undefined,
    chat: inner.chat ? (i: ChatInput, opts?: CallOpts) => inner.chat!(i, o(opts)) : undefined,
    clarify: inner.clarify ? (i: ClarifyInput, opts?: CallOpts) => inner.clarify!(i, o(opts)) : undefined,
  };
}

/* ------------------------------ verification state ------------------------------ */

export type AiMode = 'offline' | 'configured_unverified' | 'connection_verified' | 'output_verified' | 'output_problem' | 'verify_failed';
export type TaskVerification = 'unverified' | 'connection_verified' | 'output_verified' | 'output_invalid' | 'auth_failed';
const TASKS = ['extract', 'generate', 'grade'] as const;

/**
 * Verification is keyed by provider + model + credential fingerprint, and the NEWEST evidence wins:
 *  - "connection verified": an authenticated HTTP 200 with provider-reported usage for this exact provider/model/credential.
 *    Says nothing about whether the model's study output is usable.
 *  - "output verified": a schema-valid result of that very task, from that exact model/credential.
 *  - an invalid/empty/truncated/refused study output is NOT evidence that the integration works.
 *  - a later authentication failure overrides earlier successes; a different model or key starts unverified.
 */
export function deriveVerification(db: Db, provider: AIProvider) {
  const fp = provider.credentialFingerprint ?? null;
  const pid = provider.providerId ?? provider.name.split(':')[0];
  const q = (model: string, where: string, ...args: unknown[]) =>
    db.get<{ t: number | null }>(`SELECT MAX(ts) t FROM ai_usage WHERE provider = ? AND model = ? AND cred_fp IS ? AND status = 'settled' AND ${where}`, pid, model, fp, ...args)?.t ?? 0;
  return TASKS.map((task) => {
    const model = provider.modelFor!(task);
    const auth = q(model, "outcome = 'not_configured'");
    const conn = q(model, "billing = 'reported'");
    const okAt = q(model, "purpose = ? AND outcome = 'ok'", task);
    const badAt = q(model, "purpose = ? AND outcome IN ('invalid_output','empty','truncated','refused')", task);
    let status: TaskVerification = 'unverified';
    if (auth > Math.max(conn, okAt)) status = 'auth_failed';
    else if (okAt && okAt >= badAt) status = 'output_verified';
    else if (badAt > okAt && conn) status = 'output_invalid';
    else if (conn) status = 'connection_verified';
    return { task, model, status, connectionAt: conn || null, outputAt: okAt || null, lastInvalidAt: badAt > okAt ? badAt : null };
  });
}

export function aiInfo(ctx: Ctx) {
  if (ctx.hosted) {
    // students never see model names, token limits, spend or verification detail: that is operator information
    const live = ctx.ai.live;
    return { mode: live ? 'hosted' : 'offline', detail: live ? 'The study assistant is available.' : 'The study assistant is not available right now. Math practice, notes and reviews still work.', provider: 'study assistant', live, label: 'Study assistant', providerName: 'study assistant', tasks: [], verification: [], callsToday: 0, dailyLimit: 0, spentUsd: 0, heldUsd: 0, committedUsd: 0, dailyBudgetUsd: 0, pricingAsOf: '' };
  }
  const w = usageWindow(ctx);
  const live = ctx.ai.live;
  const tasks = TASKS.map((t) => ({ task: t, model: ctx.ai.modelFor?.(t) ?? null, maxOutputTokens: ctx.cfg.aiTasks[t]?.maxOutputTokens ?? DEFAULT_TASKS[t].maxOutputTokens, effort: ctx.cfg.aiTasks[t]?.effort ?? DEFAULT_TASKS[t].effort ?? null }));
  let mode: AiMode = 'offline', detail = ctx.cfg.aiProvider === 'groq' ? 'AI_PROVIDER=groq is set but GROQ_API_KEY is missing.' : 'No ANTHROPIC_API_KEY is set. Math works fully offline; other subjects use basic templates.';
  let verification: ReturnType<typeof deriveVerification> = [];
  if (live) {
    verification = deriveVerification(ctx.db, ctx.ai);
    const st = verification.map((v) => v.status);
    const names = (s: TaskVerification) => verification.filter((v) => v.status === s).map((v) => v.task).join(', ');
    if (st.includes('auth_failed')) { mode = 'verify_failed'; detail = 'The provider rejected the credentials for a configured model since the last success. Fix the key in .env and restart.'; }
    else if (st.every((s) => s === 'output_verified')) { mode = 'output_verified'; detail = 'Each task has returned schema-valid study output from its configured model and credential.'; }
    else if (st.includes('output_invalid')) { mode = 'output_problem'; detail = `The connection works but the latest ${names('output_invalid')} output was unusable (invalid, empty, truncated or refused). That is not proof the integration works — check the model/limits and run "Verify study output".`; }
    else if (st.every((s) => s !== 'unverified')) { mode = 'connection_verified'; detail = `Authenticated connection confirmed. Study output (the structured results the app relies on) is verified for: ${names('output_verified') || 'no task yet'}; not yet for: ${verification.filter((v) => v.status !== 'output_verified').map((v) => v.task).join(', ')}. Run "Verify study output".`; }
    else { mode = 'configured_unverified'; detail = `Credentials are configured but no authenticated request has succeeded yet for ${[...new Set(verification.filter((v) => v.status === 'unverified').map((v) => v.model))].join(', ')}. Use “Verify connection”.`; }
  }
  return {
    mode, detail, provider: ctx.ai.name, live, label: ctx.ai.label, providerName: live ? ctx.ai.providerId ?? ctx.ai.name.split(':')[0] : 'offline', tasks, verification,
    callsToday: w.requests, dailyLimit: _limit(ctx), spentUsd: w.spentUsd, heldUsd: w.heldUnknownUsd + w.reservedUsd, committedUsd: w.committedUsd, dailyBudgetUsd: _budget(ctx), pricingAsOf: PRICING_AS_OF,
  };
}

export function usageReport(ctx: Ctx) {
  const w = usageWindow(ctx);
  const since = ctx.now() - DAY_MS;
  const rows = ctx.db.all<any>('SELECT * FROM ai_usage WHERE ts > ? ORDER BY ts DESC', since);
  const sum = <K extends string>(key: (r: any) => K) => {
    const m = new Map<K, { requests: number; inputTokens: number; outputTokens: number; usd: number; retries: number; failures: number }>();
    for (const r of rows) {
      const k = key(r); const e = m.get(k) ?? { requests: 0, inputTokens: 0, outputTokens: 0, usd: 0, retries: 0, failures: 0 };
      e.requests++; e.inputTokens += r.input_tokens ?? 0; e.outputTokens += r.output_tokens ?? 0; e.usd += r.est_cost_usd; if (r.attempt > 1) e.retries++; if (r.outcome !== 'ok') e.failures++;
      m.set(k, e);
    }
    return [...m.entries()].map(([k, v]) => ({ key: k, ...v }));
  };
  const lat = rows.filter((r) => r.outcome === 'ok').map((r) => r.ms as number).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);
  const by = (b: string) => rows.filter((r) => r.billing === b).length;
  return {
    windowHours: 24, requests: w.requests, billableRequests: w.billableRequests, spentUsd: w.spentUsd, heldUsd: w.heldUnknownUsd + w.reservedUsd, committedUsd: w.committedUsd,
    inFlight: rows.filter((r) => r.status === 'reserved').length, reservedUsd: w.reservedUsd,
    unknownBilling: { requests: rows.filter((r) => r.billing === 'unknown').length, heldUsd: w.heldUnknownUsd },
    billing: { reported: by('reported'), estimated: by('estimated'), noneReported: by('none_reported'), notSent: by('not_sent'), unknown: by('unknown') },
    budgetUsd: _budget(ctx), requestLimit: _limit(ctx), pricingAsOf: PRICING_AS_OF,
    policy: 'Before each request the server reserves a conservative worst case (input ≤ bytes sent + overhead, output ≤ max_tokens, +10%) against budget minus everything already spent or held, then reconciles with provider-reported usage. Requests with unknown billing (e.g. a timeout) stay held at their worst case for 24 h. This is a guardrail based on list-price estimates, NOT a guaranteed dollar ceiling; your provider’s billing is authoritative.',
    byPurpose: sum((r) => r.purpose), byModel: sum((r) => r.model ?? 'unknown'),
    latencyMs: { p50: pct(0.5), p95: pct(0.95) }, estimatedUsageRequests: by('estimated'), unknownPriceRequests: rows.filter((r) => !r.price_known).length,
    recent: rows.filter((r) => r.status !== 'reserved' || true).slice(0, 15).map((r) => ({ at: r.ts, purpose: r.purpose, model: r.model, attempt: r.attempt, outcome: r.outcome, billing: r.billing, inputTokens: r.input_tokens, outputTokens: r.output_tokens, latencyMs: r.ms, usd: r.est_cost_usd, heldUsd: r.unknown_usd + r.reserved_usd })),
  };
}

export const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
