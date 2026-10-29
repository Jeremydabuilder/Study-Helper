/**
 * A BOUNDED load test with synthetic students and a MOCKED AI provider. It measures this application's own behaviour (HTTP, authentication, PostgreSQL,
 * per-student SQLite files) on one machine: client and server share the machine's CPU. It says nothing about AI latency or quality and is not a capacity promise.
 *   npm run loadtest -- --students 30 --seconds 60 --think 800 --llm-ms 150
 */
import { spawn } from 'node:child_process';

const arg = (n: string, d: number) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const STUDENTS = arg('students', 30), SECONDS = arg('seconds', 60), THINK = arg('think', 800), LLM_MS = arg('llm-ms', 150);
const APP = 'http://127.0.0.1:4290', CONTROL = 'http://127.0.0.1:4291';
const NOTES = `--- Page 1 ---\nPhotosynthesis is the process plants use to turn light, water and carbon dioxide into glucose and oxygen.\nChlorophyll is the green pigment in chloroplasts that absorbs light energy.`;

const server = spawn(process.execPath, ['--import', 'tsx', 'e2e/launcher.ts'], { env: { ...process.env, E2E_APP_PORT: '4290', E2E_CONTROL_PORT: '4291', E2E_LIMITS: JSON.stringify({ LIMIT_USER_DAILY_AI_REQUESTS: '100000', LIMIT_USER_DAILY_USD: '1000', LIMIT_GLOBAL_DAILY_USD: '100000', LIMIT_GLOBAL_CONCURRENT_AI: '1000', LIMIT_USER_CONCURRENT_AI: '10', LIMIT_USER_DAILY_CHAT: '100000', LIMIT_USER_DAILY_UPLOADS: '1000', RATE_API_PER_MIN: '600' }) }, stdio: ['ignore', 'pipe', 'inherit'] });
const ready = new Promise<void>((res, rej) => { server.stdout!.on('data', (d) => { if (String(d).includes('E2E READY')) res(); }); server.on('exit', () => rej(new Error('server exited'))); });
const control = async (p: string, body: unknown = {}) => (await fetch(`${CONTROL}/control/${p}`, { method: 'POST', body: JSON.stringify(body) })).json();

interface Sample { route: string; ms: number; status: number }
const samples: Sample[] = []; const errors: string[] = [];

class Client {
  jar = new Map<string, string>();
  async call(method: string, path: string, body?: unknown, route = path.replace(/[0-9a-f-]{20,}/g, ':id')): Promise<{ status: number; body: any }> {
    const t0 = performance.now();
    const headers: Record<string, string> = { origin: APP, 'x-workspace': 'real', 'content-type': 'application/json' };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let r: Response; try { r = await fetch(APP + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); } catch (e) { if (!errors.length) errors.push(String((e as any)?.cause?.message ?? e)); samples.push({ route: `${method} ${route}`, ms: performance.now() - t0, status: 0 }); errors.push(`${method} ${route}: network`); return { status: 0, body: null }; }
    for (const c of r.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); const i = pair.indexOf('='); this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); }
    const text = await r.text(); let j: any = null; try { j = JSON.parse(text); } catch { /* not json */ }
    samples.push({ route: `${method} ${route}`, ms: performance.now() - t0, status: r.status });
    return { status: r.status, body: j };
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * (0.6 + Math.random() * 0.8)));
let tok = 0, busyRetries = 0, bankExhausted = 0;

async function student(i: number, stopAt: number) {
  const c = new Client();
  const { codes } = await control('invites', { count: 1 });
  await c.call('POST', '/api/invite/start', { code: codes[0] });
  const up = await c.call('POST', '/api/auth/sign-up/email', { email: `load${i}@example.test`, password: 'load-test-password-1', name: 'Student' });
  if (up.status !== 200) { errors.push(`signup ${up.status}`); return; }
  const sub = (await c.call('POST', '/api/subjects', { name: 'Biology' })).body.id;
  const src = (await c.call('POST', `/api/subjects/${sub}/sources`, { title: 'Notes', text: NOTES })).body.id;
  let ex = await c.call('POST', `/api/sources/${src}/extract`, {});
  for (let k = 0; k < 12 && ex.status === 429; k++) { busyRetries++; await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500)); ex = await c.call('POST', `/api/sources/${src}/extract`, {}); } // the page tells a student to wait; so does this client
  if (src && process.env.LT_DEBUG) console.error('extract', JSON.stringify(ex.status), JSON.stringify(ex.body).slice(0,200));
  const concepts = (await c.call('GET', `/api/subjects/${sub}`)).body?.concepts ?? [];
  for (const k of concepts) await c.call('PATCH', `/api/concepts/${k.id}`, { status: 'confirmed' });
  let exhausted = false;
  while (performance.now() < stopAt) {
    if (exhausted) { await sleep(THINK * 2); await c.call('GET', '/api/today'); await c.call('GET', '/api/memory'); await c.call('GET', '/api/progress'); continue; }
    const s = await c.call('POST', '/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [concepts[0]?.id], abandonExisting: true });
    if (s.status !== 200) { await sleep(THINK); continue; }
    for (let q = 0; q < 4 && performance.now() < stopAt; q++) {
      const v = await c.call('GET', `/api/sessions/${s.body.id}`);
      if (v.status === 502) { bankExhausted++; exhausted = true; break; } // the mocked model only has 8 distinct questions; a student who has seen them all gets no new ones (a property of the mock, not the server)
      if (!v.body?.question) break;
      await sleep(THINK);
      await c.call('POST', `/api/sessions/${s.body.id}/answer`, { questionId: v.body.question.id, answer: 'glucose and oxygen', clientToken: `tok-${i}-${tok++}-abcdefgh` });
      await sleep(THINK / 2);
      await c.call('POST', `/api/sessions/${s.body.id}/next`, {});
    }
    await c.call('POST', `/api/sessions/${s.body.id}/finish`, {});
    await c.call('GET', '/api/today'); await c.call('GET', '/api/memory'); await c.call('GET', '/api/progress');
    if (i % 3 === 0) { const cv = (await c.call('POST', '/api/conversations', { mode: 'general' })).body?.id; if (cv) await c.call('POST', `/api/conversations/${cv}/messages`, { text: 'hello' }, 'POST /api/conversations/:id/messages'); }
  }
}

const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
try {
  await ready; await control('llm-delay', { ms: LLM_MS });
  const t0 = performance.now(); const stopAt = t0 + SECONDS * 1000;
  await Promise.all(Array.from({ length: STUDENTS }, (_, i) => student(i, stopAt)));
  const elapsed = (performance.now() - t0) / 1000;
  const stats = await (await fetch(`${CONTROL}/control/stats`, { method: 'POST', body: '{}' })).json();
  const by = new Map<string, Sample[]>(); for (const s of samples) by.set(s.route, [...(by.get(s.route) ?? []), s]);
  const rows = [...by.entries()].map(([route, a]) => ({ route, n: a.length, p50: pct(a.map((x) => x.ms), 0.5), p95: pct(a.map((x) => x.ms), 0.95), p99: pct(a.map((x) => x.ms), 0.99), non2xx: a.filter((x) => x.status >= 300 || x.status === 0).length })).sort((a, b) => b.n - a.n);
  const statusCounts: Record<string, number> = {}; for (const s of samples) { const k = s.status === 0 ? 'network' : `${Math.floor(s.status / 100)}xx`; statusCounts[k] = (statusCounts[k] ?? 0) + 1; }
  const out = { workload: { students: STUDENTS, seconds: Math.round(elapsed), thinkMs: THINK, mockedLlmMs: LLM_MS, note: 'client and server on one machine; AI is mocked' }, busyRetries, studentsWhoExhaustedMockQuestionBank: bankExhausted, requests: samples.length, rps: Math.round((samples.length / elapsed) * 10) / 10, statusCounts, overall: { p50: pct(samples.map((s) => s.ms), 0.5), p95: pct(samples.map((s) => s.ms), 0.95), p99: pct(samples.map((s) => s.ms), 0.99) }, server: stats, errors: [...new Set(errors)].slice(0, 10), slowestRoutes: rows.slice().sort((a, b) => b.p95 - a.p95).slice(0, 6), busiestRoutes: rows.slice(0, 6) };
  console.log(JSON.stringify(out, null, 2));
} finally { server.kill('SIGTERM'); }
