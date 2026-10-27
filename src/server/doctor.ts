/** `npm run doctor`: checks configuration and explains what is missing. Prints presence/validity only, never secret values. */
import { accessSync, constants, mkdirSync } from 'node:fs';
import { priceFor } from '../ai/pricing';
import { configFromEnv, loadEnvFile } from './config';

export interface Finding { level: 'ok' | 'info' | 'warn' | 'error'; text: string }

export function diagnose(env: NodeJS.ProcessEnv = process.env): Finding[] {
  const f: Finding[] = [];
  const add = (level: Finding['level'], text: string) => f.push({ level, text });
  const cfg = configFromEnv(env);
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) add('ok', `Node ${process.versions.node} (needs ≥ 22.13).`); else add('error', `Node ${process.versions.node} is too old; node:sqlite needs ≥ 22.13.`);

  // AI
  if (cfg.aiProvider === 'groq') {
    if (cfg.groqKey) add('warn', `AI_PROVIDER=groq with the built-in model "${cfg.groqModel}" (fixed; there is no model choice). Opt-in and NOT verified against the live API. Student material will be sent to Groq (not Anthropic), and reading scans/screenshots is unavailable with Groq.`);
    else add('error', 'AI_PROVIDER=groq needs GROQ_API_KEY. Until then the app runs in offline mode.');
  } else if (cfg.anthropicKey) {
    add('ok', 'ANTHROPIC_API_KEY is set (value not shown).');
    if (!/^sk-ant-/.test(cfg.anthropicKey)) add('warn', 'ANTHROPIC_API_KEY does not start with "sk-ant-"; double-check you pasted the whole key.');
  } else add('info', 'No ANTHROPIC_API_KEY: the app runs in Offline mode (math fully; other subjects basic templates).');
  const models = [cfg.model, ...(['extract', 'generate', 'grade'] as const).map((t) => cfg.aiTasks[t]?.model).filter((m): m is string => !!m)];
  if (cfg.aiProvider === 'anthropic') for (const m of new Set(models)) { if (!priceFor(m, 0, cfg.aiPriceOverride).known) add('warn', `Model "${m}" has no built-in price: cost estimates will use a conservative fallback. Set AI_PRICE_IN_PER_MTOK and AI_PRICE_OUT_PER_MTOK.`); }
  if (cfg.aiProvider === 'anthropic' && cfg.anthropicKey) add('info', `Models: default ${cfg.model}${(['extract', 'generate', 'grade'] as const).map((t) => (cfg.aiTasks[t]?.model ? `, ${t}=${cfg.aiTasks[t]!.model}` : '')).join('')}. Daily budget $${cfg.aiDailyBudgetUsd.toFixed(2)} (estimate; provider billing is authoritative).`);
  if (cfg.aiDailyBudgetUsd <= 0) add('warn', 'AI_DAILY_BUDGET_USD is 0, which turns paid AI off.');

  // Google
  const has = (k: string) => !!(env[k] && env[k]!.trim());
  const g = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APP_SECRET'].filter(has);
  if (g.length === 3) {
    add('ok', 'Google Calendar variables are set (values not shown).');
    if ((env.APP_SECRET ?? '').length < 32) add('warn', 'APP_SECRET is shorter than 32 characters; generate a long random one (see .env.example).');
    if (!/\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID ?? '')) add('warn', 'GOOGLE_CLIENT_ID does not end in ".apps.googleusercontent.com" — is it the OAuth *Web application* client ID?');
  } else if (g.length === 0) add('info', 'Google Calendar not configured (optional). Manual entry works; the sample calendar works in the demo workspace.');
  else add('error', `Google Calendar is partly configured. Missing: ${['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APP_SECRET'].filter((k) => !has(k)).join(', ')}.`);
  const ru = cfg.googleRedirectUri;
  try {
    const u = new URL(ru);
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.pathname !== '/api/calendar/oauth/callback') add('error', `GOOGLE_REDIRECT_URI path must be exactly /api/calendar/oauth/callback (got ${u.pathname}).`);
    else if (u.protocol !== 'https:' && !local) add('error', 'GOOGLE_REDIRECT_URI must be https:// unless it points at localhost.');
    else add(g.length === 3 ? 'ok' : 'info', `Register this exact Authorized redirect URI in Google Cloud Console: ${ru}`);
    const port = String(env.PORT ?? '8787');
    if (local && u.port && u.port !== port) add('warn', `GOOGLE_REDIRECT_URI port ${u.port} differs from PORT ${port}; Google will redirect to the wrong place.`);
    if (u.hostname === '127.0.0.1') add('warn', 'Google treats "localhost" and "127.0.0.1" as different redirect URIs; use whichever you registered, consistently, and browse the app at the same host.');
  } catch { add('error', `GOOGLE_REDIRECT_URI is not a valid URL: ${ru}`); }

  // boundary
  const host = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) add('error', `HOST=${host} exposes this server beyond this computer. It has NO authentication or per-user data isolation; do not expose student records or calendar tokens. Add auth first.`);
  else add('ok', 'Bound to localhost only (the app has no login by design; keep it local).');
  try { mkdirSync(cfg.dataDir, { recursive: true }); accessSync(cfg.dataDir, constants.W_OK); add('ok', `Data directory ${cfg.dataDir} is writable.`); } catch { add('error', `Data directory ${cfg.dataDir} is not writable.`); }
  return f;
}

if (process.argv[1]?.endsWith('doctor.ts')) {
  loadEnvFile();
  const icon = { ok: '✓', info: '·', warn: '!', error: '✗' } as const;
  const fs = diagnose();
  for (const x of fs) console.log(`${icon[x.level]} ${x.text}`);
  process.exit(fs.some((x) => x.level === 'error') ? 1 : 0);
}
