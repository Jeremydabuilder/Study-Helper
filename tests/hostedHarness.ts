/**
 * A complete hosted server for tests: real PostgreSQL, real Better Auth, per-student databases in a temp folder, a fake OpenID Connect provider
 * (stands in for Google sign-in) and scripted AI replies. Several synthetic students can be signed in at once, each with their own cookie jar.
 * Everything here is mocked EXCEPT the application's own code, database and authentication library.
 */
import { createServer, Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { LLMProvider, LLMRequest, LLMTransport } from '../src/ai/llm';
import { AIProvider } from '../src/ai/provider';
import { createHostedApp, HostedApp } from '../src/server/hosted/hosted';
import { hostedConfigFromEnv } from '../src/server/hosted/config';
import { createInvites } from '../src/server/hosted/invites';
import { setSettingPg } from '../src/server/hosted/pg';
import { baseCfg } from './helpers';
import { TestDb, createTestDb } from './pgHarness';

export const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });

/** Stand-in for Google's OpenID Connect endpoints. `nextEmail` decides who "signs in" at the next authorization. */
export class FakeIdp {
  server!: Server; port = 0; nextEmail = 'student@example.test'; verified = true; calls = 0;
  async start() {
    this.server = createServer((req, res) => {
      const u = new URL(req.url!, 'http://x'); this.calls++;
      if (u.pathname === '/authorize') { const back = new URL(u.searchParams.get('redirect_uri')!); back.searchParams.set('code', Buffer.from(this.nextEmail).toString('base64url')); back.searchParams.set('state', u.searchParams.get('state')!); res.writeHead(302, { Location: back.toString() }); return res.end(); }
      if (u.pathname === '/token') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const code = new URLSearchParams(b).get('code') ?? ''; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: `at.${code}`, token_type: 'Bearer', expires_in: 3600 })); }); return; }
      if (u.pathname === '/userinfo') { const t = (req.headers.authorization ?? '').replace('Bearer at.', ''); const email = Buffer.from(t, 'base64url').toString(); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ sub: `sub-${email}`, email, email_verified: this.verified, name: 'Should Not Be Stored', picture: 'https://example.test/p.png' })); }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r)); this.port = (this.server.address() as AddressInfo).port; return this;
  }
  get base() { return `http://127.0.0.1:${this.port}`; }
  stop() { return new Promise<void>((r) => this.server.close(() => r())); }
}

/** Scripted model: answers by recognising which task the prompt is for. Tests can read `calls` and override `replies`. */
export class ScriptedLlm implements LLMTransport {
  provider = 'fake'; defaultModel = 'claude-sonnet-5-5'; calls: LLMRequest[] = []; failNext: Error | null = null; delayMs = 0;
  replies: Record<string, unknown> = {};
  async complete(r: LLMRequest) {
    this.calls.push(r);
    if (this.delayMs) await new Promise((x) => setTimeout(x, this.delayMs));
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    const u = r.user, j = (o: unknown) => JSON.stringify(o);
    const usage = { input: 400, output: 120, cacheRead: 0, cacheWrite: 0 };
    const wrap = (text: string) => ({ text, model: r.model, stopReason: 'end_turn', requestId: 'req_test', usage });
    if (u.includes('JSON shape: {"reply":""}')) return wrap(j(this.replies.chat ?? { reply: 'Here is a hint.' }));
    if (u.includes('JSON shape: {"answer":""}')) return wrap(j({ answer: 'It is explained in your notes.' }));
    if (u.includes('"concepts":[{')) return wrap(j(this.replies.extract ?? { concepts: [{ name: 'Photosynthesis', summary: 'Plants turn light, water and carbon dioxide into glucose and oxygen.', quotes: ['turn light, water and carbon dioxide into glucose and oxygen'] }] }));
    if (u.includes('"questions":[{')) return wrap(j(this.replies.generate ?? { questions: [{ kind: 'short_answer', prompt: 'What do plants make from light, water and carbon dioxide?', rubric: { key_points: [{ point: 'Glucose and oxygen', keywords: ['glucose', 'oxygen'] }] }, hints: ['Think about what plants produce.'], worked_example: 'w', explanation: 'Plants make glucose and oxygen.', difficulty: 1, source_quote: 'turn light, water and carbon dioxide into glucose and oxygen' }] }));
    if (u.includes('"items":[{"index"')) return wrap(j({ items: [{ index: 0, verdict: 'supported', note: 'ok' }] }));
    if (u.includes('"correctness":0.0-1.0')) return wrap(j(this.replies.grade ?? { correctness: 1, confidence: 'high', feedback: 'Correct: glucose and oxygen.', points: [{ point: 'Glucose and oxygen', met: true }], mistake_kind: 'none' }));
    return wrap(j({}));
  }
}

export interface Resp { status: number; body: any; headers: Headers }
export class Student {
  jar = new Map<string, string>();
  constructor(public h: HostedHarness, public email: string) {}
  private cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  private absorb(r: Response) { for (const c of r.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim(); if (/;\s*Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c) || v === '') this.jar.delete(k); else this.jar.set(k, v); } }
  async req(method: string, path: string, body?: unknown, o: { ws?: 'real' | 'demo'; raw?: Buffer; contentType?: string; origin?: string | null; redirect?: RequestRedirect; headers?: Record<string, string> } = {}): Promise<Resp> {
    const headers: Record<string, string> = { 'x-workspace': o.ws ?? 'real', ...(o.headers ?? {}) };
    if (this.jar.size) headers.cookie = this.cookieHeader();
    if (o.origin !== null) headers.origin = o.origin ?? this.h.url;
    let payload: BodyInit | undefined;
    if (o.raw) { headers['content-type'] = o.contentType ?? 'application/octet-stream'; payload = o.raw as unknown as BodyInit; }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(`${this.h.url}${path}`, { method, headers, body: payload, redirect: o.redirect ?? 'manual' });
    this.absorb(r);
    const text = await r.text(); let parsed: any = null; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, headers: r.headers };
  }
  get = (p: string, o = {}) => this.req('GET', p, undefined, o);
  post = (p: string, b: unknown = {}, o = {}) => this.req('POST', p, b, o);
  put = (p: string, b: unknown, o = {}) => this.req('PUT', p, b, o);
  patch = (p: string, b: unknown, o = {}) => this.req('PATCH', p, b, o);
  del = (p: string, o = {}) => this.req('DELETE', p, undefined, o);

  /** Full sign-up/sign-in through the fake identity provider, exactly as a browser would do it. */
  async signInWithIdp(code?: string): Promise<{ ok: boolean; location: string | null }> {
    if (code) { const s = await this.post('/api/invite/start', { code }); if (s.status !== 200) return { ok: false, location: `invite:${s.body?.error?.code}` }; }
    this.h.idp.nextEmail = this.email;
    const start = await this.post('/api/auth/sign-in/social', { provider: 'google', callbackURL: '/', errorCallbackURL: '/?signin=failed', newUserCallbackURL: '/' });
    const authUrl = start.body?.url as string | undefined; if (!authUrl) return { ok: false, location: `start:${start.status}` };
    const a = await fetch(authUrl, { redirect: 'manual' }); const cb = a.headers.get('location')!;
    const c = await fetch(cb, { redirect: 'manual', headers: { cookie: this.cookieHeader() } }); this.absorb(c);
    const loc = c.headers.get('location');
    const me = await this.get('/api/session');
    return { ok: me.body?.signedIn === true, location: loc };
  }
  async signUpWithPassword(code: string, password = 'a-long-test-password') {
    const s = await this.post('/api/invite/start', { code }); if (s.status !== 200) return { ok: false, status: s.status, body: s.body };
    const r = await this.post('/api/auth/sign-up/email', { email: this.email, password, name: 'Student' });
    return { ok: r.status === 200, status: r.status, body: r.body };
  }
  async signInWithPassword(password = 'a-long-test-password') { const r = await this.post('/api/auth/sign-in/email', { email: this.email, password }); return { ok: r.status === 200, status: r.status, body: r.body }; }
  async signOut() { return this.post('/api/auth/sign-out', {}); }
}

export class HostedHarness {
  hosted!: HostedApp; db!: TestDb; idp!: FakeIdp; server!: Server; port = 0; url = ''; dir = ''; llm = new ScriptedLlm(); clock = { now: Date.UTC(2026, 9, 29, 15, 0, 0) };
  now = () => this.clock.now;
  students: Student[] = [];
  static async start(o: { passwordSignIn?: boolean; oidc?: boolean; llm?: boolean; limits?: Record<string, string>; pilot?: boolean; maxUsers?: number; dir?: string; db?: TestDb } = {}) {
    const h = new HostedHarness();
    h.db = o.db ?? await createTestDb(); h.idp = await new FakeIdp().start();
    h.port = await freePort(); h.url = `http://127.0.0.1:${h.port}`; h.dir = o.dir ?? mkdtempSync(join(tmpdir(), 'sh-hosted-'));
    const env: Record<string, string> = {
      APP_ENV: 'test', DATABASE_URL: h.db.url, PUBLIC_URL: h.url, BETTER_AUTH_SECRET: 'a'.repeat(20) + 'B'.repeat(20), APP_SECRET: 'c'.repeat(20) + 'D'.repeat(20),
      ...(o.oidc === false ? {} : { AUTH_OIDC_CLIENT_ID: 'test-client', AUTH_OIDC_CLIENT_SECRET: 'test-secret', AUTH_OIDC_AUTHORIZATION_URL: `${h.idp.base}/authorize`, AUTH_OIDC_TOKEN_URL: `${h.idp.base}/token`, AUTH_OIDC_USERINFO_URL: `${h.idp.base}/userinfo` }),
      ...(o.passwordSignIn ? { AUTH_PASSWORD: '1' } : {}), RATE_AUTH_PER_MIN: '100000', RATE_INVITE_PER_MIN: '100000', RATE_API_PER_MIN: '100000', ...(o.limits ?? {}),
    };
    const { cfg: hcfg, problems } = hostedConfigFromEnv(env as never);
    if (problems.length) throw new Error(problems.join('; '));
    h.hosted = await createHostedApp({ cfg: baseCfg({ dataDir: h.dir, appSecret: env.APP_SECRET, anthropicKey: o.llm === false ? null : 'test-key-not-real' }), hcfg, dataDir: h.dir, pool: h.db.pool, now: h.now, logger: { info() {}, warn() {}, error() {} }, llm: o.llm === false ? null : new LLMProvider(h.llm) as AIProvider });
    h.server = await new Promise<Server>((res) => { const s = h.hosted.app.listen(h.port, '127.0.0.1', () => res(s)); });
    if (o.pilot !== false) { await setSettingPg(h.db.pool, 'pilot_enabled', true); await setSettingPg(h.db.pool, 'pilot_max_users', o.maxUsers ?? 50); }
    return h;
  }
  student(email: string) { const s = new Student(this, email); this.students.push(s); return s; }
  async codes(n = 1, ttlDays = 7) { return createInvites(this.db.pool, { count: n, label: 'test', ttlDays, now: this.clock.now }); }
  /** Create, invite and sign in a synthetic student. */
  async join(email: string, via: 'idp' | 'password' = 'idp'): Promise<Student> {
    const s = this.student(email); const [code] = await this.codes(1);
    const r = via === 'idp' ? await s.signInWithIdp(code) : await s.signUpWithPassword(code);
    if (!(r as any).ok) throw new Error(`could not join ${email}: ${JSON.stringify(r)}`);
    return s;
  }
  async stop(o: { keepDb?: boolean } = {}) {
    await new Promise<void>((r) => this.server.close(() => r()));
    await this.hosted.close(); await this.idp.stop();
    if (!o.keepDb) await this.db.drop();
  }
}
