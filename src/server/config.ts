import { readFileSync, existsSync } from 'node:fs';
import type { AppConfig } from './services/common';

/** Minimal .env loader (no dependency). Real environment variables win. */
export function loadEnvFile(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function configFromEnv(env = process.env): AppConfig {
  const g = (k: string) => (env[k] && env[k]!.trim() ? env[k]!.trim() : null);
  const port = env.PORT ?? '8787';
  return {
    anthropicKey: g('ANTHROPIC_API_KEY'), model: g('ANTHROPIC_MODEL') ?? 'claude-sonnet-5-5',
    aiTimeoutMs: Number(env.AI_TIMEOUT_MS) || 45_000, aiDailyLimit: Number(env.AI_DAILY_CALL_LIMIT) || 150,
    google: g('GOOGLE_CLIENT_ID') && g('GOOGLE_CLIENT_SECRET') && g('APP_SECRET')
      ? { clientId: g('GOOGLE_CLIENT_ID')!, clientSecret: g('GOOGLE_CLIENT_SECRET')!, redirectUri: g('GOOGLE_REDIRECT_URI') ?? `http://localhost:${port}/api/calendar/oauth/callback` } : null,
    appSecret: g('APP_SECRET'), dataDir: g('DATA_DIR') ?? './data', production: env.NODE_ENV === 'production',
  };
}
