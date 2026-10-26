import { readFileSync, existsSync } from 'node:fs';
import type { AppConfig } from './services/common';
import type { Effort } from '../ai/llm';

/** Minimal .env loader (no dependency). Real environment variables win. */
export function loadEnvFile(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const EFFORTS = ['low', 'medium', 'high'];
/** Optional proxy/mocking override. Must be https, or http only for localhost, so a key is never sent over plain HTTP to a remote host. */
function safeBase(v: string | null): string {
  const d = 'https://api.anthropic.com';
  if (!v) return d;
  try { const u = new URL(v); if (u.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(u.hostname)) return v.replace(/\/+$/, ''); } catch { /* fall through */ }
  return d;
}
export function configFromEnv(env = process.env): AppConfig {
  const g = (k: string) => (env[k] && env[k]!.trim() ? env[k]!.trim() : null);
  const num = (k: string) => { const v = g(k); const n = v === null ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
  const port = env.PORT ?? '8787';
  const provider = g('AI_PROVIDER') === 'groq' ? 'groq' : 'anthropic'; // anthropic unless the operator explicitly opts in to groq
  const task = (t: 'EXTRACT' | 'GENERATE' | 'GRADE') => {
    const e = g(`AI_EFFORT_${t}`);
    return { model: g(`AI_MODEL_${t}`) ?? undefined, maxOutputTokens: num(`AI_MAX_OUTPUT_${t}`) ?? undefined, effort: e && EFFORTS.includes(e) ? (e as Effort) : undefined };
  };
  const strip = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
  return {
    anthropicKey: g('ANTHROPIC_API_KEY'), anthropicBaseUrl: safeBase(g('ANTHROPIC_BASE_URL')),
    model: g('AI_MODEL') ?? g('ANTHROPIC_MODEL') ?? 'claude-sonnet-5-5',
    aiProvider: provider, groqKey: g('GROQ_API_KEY'), groqModel: g('GROQ_MODEL'),
    aiTasks: { extract: strip(task('EXTRACT')) as never, generate: strip(task('GENERATE')) as never, grade: strip(task('GRADE')) as never },
    aiTimeoutMs: Number(env.AI_TIMEOUT_MS) || 45_000, aiDailyLimit: Number(env.AI_DAILY_CALL_LIMIT) || 150,
    aiDailyBudgetUsd: num('AI_DAILY_BUDGET_USD') ?? 1, aiPriceOverride: { inPerM: num('AI_PRICE_IN_PER_MTOK') ?? undefined, outPerM: num('AI_PRICE_OUT_PER_MTOK') ?? undefined },
    google: g('GOOGLE_CLIENT_ID') && g('GOOGLE_CLIENT_SECRET') && g('APP_SECRET')
      ? { clientId: g('GOOGLE_CLIENT_ID')!, clientSecret: g('GOOGLE_CLIENT_SECRET')!, redirectUri: g('GOOGLE_REDIRECT_URI') ?? `http://localhost:${port}/api/calendar/oauth/callback` } : null,
    googleRedirectUri: g('GOOGLE_REDIRECT_URI') ?? `http://localhost:${port}/api/calendar/oauth/callback`,
    googlePartial: [g('GOOGLE_CLIENT_ID'), g('GOOGLE_CLIENT_SECRET'), g('APP_SECRET')].filter(Boolean).length > 0 && !(g('GOOGLE_CLIENT_ID') && g('GOOGLE_CLIENT_SECRET') && g('APP_SECRET')),
    appSecret: g('APP_SECRET'), dataDir: g('DATA_DIR') ?? './data', production: env.NODE_ENV === 'production',
  };
}
