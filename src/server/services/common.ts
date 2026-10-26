import { AIError, AIProvider, CallOpts, ExtractInput, GenerateInput, GradeInput, PreRequest, RequestRecord } from '../../ai/provider';
import { DEFAULT_TASKS, type TaskConfig } from '../../ai/llm';
import { PRICING_AS_OF, estimateCost, projectCost } from '../../ai/pricing';
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
export const callLimit = (ctx: { db: Db; cfg: AppConfig }) => getSetting<number>(ctx.db, 'ai_daily_limit', ctx.cfg.aiDailyLimit);
export const budgetUsd = (ctx: { db: Db; cfg: AppConfig }) => getSetting<number>(ctx.db, 'ai_daily_budget_usd', ctx.cfg.aiDailyBudgetUsd);

/** Estimated spend and billable-request count over a rolling 24 hours. */
export function usageWindow(ctx: { db: Db; now: () => number }) {
  const r = ctx.db.get<{ n: number; usd: number }>('SELECT COUNT(*) n, COALESCE(SUM(est_cost_usd),0) usd FROM ai_usage WHERE ts > ? AND outcome IN (\'ok\',\'invalid_output\',\'truncated\')', ctx.now() - DAY_MS)!;
  const all = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM ai_usage WHERE ts > ?', ctx.now() - DAY_MS)!.n;
  return { billableRequests: r.n, requests: all, spentUsd: r.usd };
}

/**
 * Wraps a live provider with server-side enforcement: a daily request cap and a daily estimated-dollar budget,
 * checked BEFORE every HTTP request (a repair retry is checked and counted like any other). Every request is
 * logged with provider-reported tokens, model, latency and an estimated cost. Offline providers pass through.
 */
export function metered(ctx: { db: Db; now: () => number; cfg: AppConfig }, inner: AIProvider): AIProvider {
  if (!inner.live) return inner;
  const gate = (p: PreRequest) => {
    const w = usageWindow(ctx);
    if (w.requests >= callLimit(ctx)) throw new AIError('limit_reached', `Daily AI request limit reached (${callLimit(ctx)}). Offline mode still works, or raise the limit in Settings.`);
    const budget = budgetUsd(ctx);
    const worst = projectCost(p.model, p.inputChars, p.maxOutputTokens, ctx.cfg.aiPriceOverride);
    if (w.spentUsd + worst > budget) {
      throw new AIError('budget_reached', `Daily AI budget reached: about $${w.spentUsd.toFixed(3)} spent of $${budget.toFixed(2)} (this request could cost up to $${worst.toFixed(3)}). Offline mode still works, or raise the budget in Settings. Provider billing is authoritative.`);
    }
    lastPre.set(`${p.purpose}:${p.attempt}`, p);
  };
  const lastPre = new Map<string, PreRequest>();
  const record = (r: RequestRecord) => {
    const pre = lastPre.get(`${r.purpose}:${r.attempt}`);
    const billed = r.outcome === 'ok' || r.outcome === 'invalid_output' || r.outcome === 'truncated';
    let usage = { inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens };
    let source = r.usageSource;
    if (billed && source === 'none') { source = 'estimated'; usage = { ...usage, inputTokens: Math.ceil((pre?.inputChars ?? 0) / 3.5), outputTokens: Math.ceil((pre?.maxOutputTokens ?? 0) * 0.25) }; }
    const cost = billed ? estimateCost(r.model, usage, ctx.cfg.aiPriceOverride) : { usd: 0, known: true };
    ctx.db.run(`INSERT INTO ai_usage (ts,purpose,ok,error,ms,provider,model,attempt,outcome,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,usage_source,est_cost_usd,price_known,stop_reason,request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ctx.now(), r.purpose, Number(r.outcome === 'ok'), r.outcome === 'ok' ? null : r.outcome, r.latencyMs, r.provider, r.model, r.attempt, r.outcome,
      billed ? usage.inputTokens : null, billed ? usage.outputTokens : null, usage.cacheReadTokens, usage.cacheWriteTokens, billed ? source : 'none', cost.usd, Number(cost.known), r.stopReason, r.requestId);
    lastPre.delete(`${r.purpose}:${r.attempt}`);
  };
  const o = (extra?: CallOpts): CallOpts => ({ beforeRequest: (p) => { extra?.beforeRequest?.(p); gate(p); }, onRequest: (r) => { record(r); extra?.onRequest?.(r); } });
  return {
    name: inner.name, live: true, label: inner.label, modelFor: inner.modelFor?.bind(inner),
    verify: inner.verify ? (opts, model) => inner.verify!(o(opts), model) : undefined,
    extractConcepts: (i: ExtractInput, opts?: CallOpts) => inner.extractConcepts(i, o(opts)),
    generateQuestions: (i: GenerateInput, opts?: CallOpts) => inner.generateQuestions(i, o(opts)),
    gradeAnswer: (i: GradeInput, opts?: CallOpts) => inner.gradeAnswer(i, o(opts)),
  };
}

export type AiMode = 'offline' | 'configured_unverified' | 'verified' | 'verify_failed';

export function aiInfo(ctx: Ctx) {
  const w = usageWindow(ctx);
  const live = ctx.ai.live;
  const tasks = (['extract', 'generate', 'grade'] as const).map((t) => ({ task: t, model: ctx.ai.modelFor?.(t) ?? null, maxOutputTokens: ctx.cfg.aiTasks[t]?.maxOutputTokens ?? DEFAULT_TASKS[t].maxOutputTokens, effort: ctx.cfg.aiTasks[t]?.effort ?? DEFAULT_TASKS[t].effort ?? null }));
  const models = [...new Set(tasks.map((t) => t.model).filter((m): m is string => !!m))];
  let mode: AiMode = 'offline', detail = ctx.cfg.aiProvider === 'groq' ? 'AI_PROVIDER=groq is set but GROQ_API_KEY and GROQ_MODEL are both required.' : 'No ANTHROPIC_API_KEY is set. Math works fully offline; other subjects use basic templates.';
  let verifiedAt: number | null = null, lastError: string | null = null;
  if (live) {
    const okRows = ctx.db.all<{ model: string; ts: number }>("SELECT model, MAX(ts) ts FROM ai_usage WHERE outcome IN ('ok','invalid_output') GROUP BY model");
    const okBy = new Map(okRows.map((r) => [r.model, r.ts]));
    const unverified = models.filter((m) => !okBy.has(m));
    const lastAuth = ctx.db.get<{ ts: number; model: string }>("SELECT ts, model FROM ai_usage WHERE outcome = 'not_configured' ORDER BY ts DESC LIMIT 1");
    const authFailedLast = lastAuth && models.includes(lastAuth.model) && lastAuth.ts > (okBy.get(lastAuth.model) ?? 0);
    verifiedAt = models.length ? Math.min(...models.map((m) => okBy.get(m) ?? Infinity)) : null;
    if (verifiedAt === Infinity) verifiedAt = null;
    if (authFailedLast) { mode = 'verify_failed'; lastError = 'The provider rejected the API key.'; detail = 'The provider rejected the credentials. Check the key in .env and restart.'; }
    else if (unverified.length) { mode = 'configured_unverified'; detail = `Credentials are configured but no request has succeeded yet for ${unverified.join(', ')}. Use “Verify connection”.`; }
    else { mode = 'verified'; detail = 'A real request to each configured model has succeeded.'; }
  }
  const limit = callLimit(ctx);
  return {
    mode, detail, provider: ctx.ai.name, live, label: ctx.ai.label, providerName: live ? ctx.ai.name.split(':')[0] : 'offline', tasks, verifiedAt, lastError,
    callsToday: w.requests, dailyLimit: limit, spentUsd: w.spentUsd, dailyBudgetUsd: budgetUsd(ctx), pricingAsOf: PRICING_AS_OF,
  };
}

export function usageReport(ctx: Ctx) {
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
  return {
    windowHours: 24, ...usageWindow(ctx), budgetUsd: budgetUsd(ctx), requestLimit: callLimit(ctx), pricingAsOf: PRICING_AS_OF,
    note: 'Costs are estimates from published list prices and provider-reported token counts. Your provider’s billing is authoritative.',
    byPurpose: sum((r) => r.purpose), byModel: sum((r) => r.model ?? 'unknown'),
    latencyMs: { p50: pct(0.5), p95: pct(0.95) }, estimatedUsageRequests: rows.filter((r) => r.usage_source === 'estimated').length, unknownPriceRequests: rows.filter((r) => !r.price_known).length,
    recent: rows.slice(0, 15).map((r) => ({ at: r.ts, purpose: r.purpose, model: r.model, attempt: r.attempt, outcome: r.outcome, inputTokens: r.input_tokens, outputTokens: r.output_tokens, latencyMs: r.ms, usd: r.est_cost_usd })),
  };
}

export const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
