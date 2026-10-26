import { AIError, AIProvider, ExtractInput, GenerateInput, GradeInput } from '../../ai/provider';
import { OfflineProvider } from '../../ai/offline';
import { Db, WorkspaceName } from '../db';
import { DEFAULT_WEIGHTS, PriorityWeights } from '../../core/priority';
import { AvailabilitySettings, DEFAULT_AVAILABILITY } from '../../core/schedule';
import { DEFAULT_PARAMS, SchedulerParams } from '../../core/learning';
import type { CalendarGateway } from './calendarGoogle';

export interface AppConfig {
  anthropicKey: string | null; model: string; aiTimeoutMs: number; aiDailyLimit: number;
  google: { clientId: string; clientSecret: string; redirectUri: string } | null;
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

/** Wraps a live provider with a daily call cap and usage log. Offline providers pass through (free). */
export function metered(ctx: { db: Db; now: () => number; cfg: AppConfig }, inner: AIProvider): AIProvider {
  if (!inner.live) return inner;
  const limit = () => getSetting<number>(ctx.db, 'ai_daily_limit', ctx.cfg.aiDailyLimit);
  const used = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM ai_usage WHERE ts > ? AND error IS NOT \'limit\'', ctx.now() - 86_400_000)!.n;
  async function run<T>(purpose: string, fn: () => Promise<T>): Promise<T> {
    if (used() >= limit()) throw new AIError('limit_reached', `Daily AI limit reached (${limit()} calls). Offline mode still works, or raise the limit in Settings.`);
    const t0 = ctx.now();
    try {
      const r = await fn();
      ctx.db.run('INSERT INTO ai_usage (ts,purpose,ok,ms) VALUES (?,?,1,?)', t0, purpose, ctx.now() - t0);
      return r;
    } catch (e) {
      ctx.db.run('INSERT INTO ai_usage (ts,purpose,ok,error,ms) VALUES (?,?,0,?,?)', t0, purpose, e instanceof AIError ? e.code : 'error', ctx.now() - t0);
      throw e;
    }
  }
  return {
    name: inner.name, live: true, label: inner.label,
    extractConcepts: (i: ExtractInput) => run('extract', () => inner.extractConcepts(i)),
    generateQuestions: (i: GenerateInput) => run('generate', () => inner.generateQuestions(i)),
    gradeAnswer: (i: GradeInput) => run('grade', () => inner.gradeAnswer(i)),
  };
}

export function aiInfo(ctx: Ctx) {
  const limit = getSetting<number>(ctx.db, 'ai_daily_limit', ctx.cfg.aiDailyLimit);
  const used = ctx.ai.live ? ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM ai_usage WHERE ts > ?', ctx.now() - 86_400_000)!.n : 0;
  return { provider: ctx.ai.name, live: ctx.ai.live, label: ctx.ai.label, callsToday: used, dailyLimit: limit };
}

export const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
