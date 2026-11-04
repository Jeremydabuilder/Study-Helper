/** "Bring your own Groq key" on the public site: the relay, visitor isolation, no fallback to the site's key, and that the key is never kept or shown anywhere. */
import { afterEach, describe, expect, it } from 'vitest';
import { GROQ_CHAT_URL } from '../src/ai/byok';
import { HostedHarness, VISITOR_KEY } from './hostedHarness';
import { PG_AVAILABLE } from './pgHarness';

const OWNER = { email: 'owner@example.test', password: 'correct horse battery staple' };
const open: HostedHarness[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.stop(); });
const start = async (env: Record<string, string> = {}, extra: Record<string, unknown> = {}) => { const h = await HostedHarness.start({ owner: OWNER, limits: { PUBLIC_GUEST: '1', ...env }, ...extra }); open.push(h); return h; };
const visitor = (h: HostedHarness, ip: string, key?: string, model?: string) => { const s = h.student('v-' + ip); const headers = (): Record<string, string> => ({ 'x-forwarded-for': ip, ...(key ? { 'x-groq-key': key } : {}), ...(model ? { 'x-groq-model': model } : {}) }); return { post: (p: string, b: unknown) => s.post(p, b, { headers: headers() }), get: (p: string) => s.get(p, { headers: headers() }) }; };
const HINT = { question: 'Solve 2x + 3 = 11', attempt: 'x = 7', excerpts: [{ label: 'Notes', text: 'Undo addition by subtracting from both sides.' }] };
const OTHER = 'gsk_' + 'Second7654321098'.repeat(3);
/** every table in the control database, as text */
const dump = async (h: HostedHarness) => { const t = (await h.db.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => r.tablename as string); let all = ''; for (const n of t) all += JSON.stringify((await h.db.pool.query(`SELECT row_to_json(x)::text AS j FROM "${n}" x`)).rows); return all; };

describe.skipIf(!PG_AVAILABLE)('bring your own Groq key', () => {
  it('by default the site’s own key is never used for strangers: no key means "set up in Settings", and nothing is sent anywhere', async () => {
    const h = await start(); const v = visitor(h, '10.5.0.1');
    const st = (await v.get('/api/public/status')).body; expect(st).toMatchObject({ operatorAi: false, ai: { available: false }, byok: { defaultModel: 'openai/gpt-oss-120b' } }); expect(st.byok.models.length).toBeGreaterThan(1);
    for (const [p, b] of [['/api/public/hint', HINT], ['/api/public/extract', { text: 'Math worksheet 4 due Friday please' }], ['/api/public/quiz', { excerpts: HINT.excerpts }], ['/api/public/check', { question: 'What is q?', answer: 'a' }], ['/api/public/chat', { message: 'hello' }]] as const) {
      const r = await v.post(p, b); expect(r.status, p).toBe(503); expect(r.body.error).toMatchObject({ code: 'ai_setup_needed', setup: true, offlineFallback: true }); expect(r.body.error.message).toMatch(/Settings/);
    }
    expect(h.llm.calls).toHaveLength(0); expect(h.byok.calls).toHaveLength(0);
    expect((await h.db.pool.query('SELECT count(*)::int n FROM ai_requests')).rows[0].n).toBe(0);
  });

  it('a visitor’s key is used for that visitor’s request only, sent to the one fixed address, and bypasses the site’s key, ledger and quotas', async () => {
    const h = await start({ PUBLIC_OPERATOR_AI: '1' }); const v = visitor(h, '10.5.0.2', VISITOR_KEY, 'openai/gpt-oss-20b');
    const hint = await v.post('/api/public/hint', HINT); expect(hint.status).toBe(200); expect(hint.body.hint).toMatch(/own key/);
    for (const [p, b, f] of [['/api/public/extract', { text: 'Math worksheet 4 due Friday please' }, (x: any) => x.result.classes], ['/api/public/quiz', { excerpts: HINT.excerpts }, (x: any) => x.questions], ['/api/public/check', { question: 'What is q?', answer: 'a' }, (x: any) => x.verdict], ['/api/public/chat', { message: 'hello' }, (x: any) => x.reply]] as const) { const r = await v.post(p, b); expect(r.status, p).toBe(200); expect(f(r.body)).toBeTruthy(); }
    expect(h.byok.calls).toHaveLength(5);
    for (const c of h.byok.calls) { expect(c.url).toBe(GROQ_CHAT_URL); expect(c.key).toBe(VISITOR_KEY); expect(c.redirect).toBe('error'); expect(c.body.model).toBe('openai/gpt-oss-20b'); expect(JSON.stringify(c.body)).not.toContain(VISITOR_KEY); }
    expect(h.llm.calls).toHaveLength(0);                                                                                // the site's provider was not touched
    expect((await h.db.pool.query('SELECT count(*)::int n FROM ai_requests')).rows[0].n).toBe(0);                       // nothing on the site's ledger
    expect((await h.db.pool.query("SELECT count(*)::int n FROM usage_counters WHERE kind = 'public_ai'")).rows[0].n).toBe(0); // and none of the site's shared allowance
  });

  it('never falls back to the site’s key when the visitor’s key fails, for any failure', async () => {
    const h = await start({ PUBLIC_OPERATOR_AI: '1' }); const v = visitor(h, '10.5.0.3', VISITOR_KEY);
    for (const [mode, status, code] of [['invalid_key', 503, 'ai_not_configured'], ['forbidden', 503, 'ai_not_configured'], ['model', 400, 'ai_rejected'], ['rate', 429, 'ai_rate_limited'], ['server', 503, 'ai_unavailable'], ['network', 503, 'ai_unavailable']] as const) {
      h.byok.mode = mode; const r = await v.post('/api/public/hint', HINT);
      expect(r.body.error.code, mode).toBe(code); expect(r.status, mode).toBeGreaterThanOrEqual(400); expect(JSON.stringify(r.body)).not.toContain(VISITOR_KEY); expect(JSON.stringify(r.body)).not.toContain('sk-should-never-be-echoed');
      void status;
    }
    expect(h.llm.calls).toHaveLength(0);                                                                                // six failures, zero site requests
    h.byok.mode = 'ok';                                                                                                  // the site's own assistant for a visitor WITHOUT a key still works, and was not cooled by the visitor's 429
    const own = await visitor(h, '10.5.0.4').post('/api/public/hint', HINT); expect(own.status).toBe(200); expect(h.llm.calls).toHaveLength(1);
  });

  it('keeps visitors apart: each key reaches Groq only on its own requests, concurrently too', async () => {
    const h = await start(); h.byok.valid.add(OTHER);
    const a = visitor(h, '10.5.1.1', VISITOR_KEY), b = visitor(h, '10.5.1.2', OTHER);
    const rs = await Promise.all([a.post('/api/public/hint', HINT), b.post('/api/public/hint', HINT), a.post('/api/public/hint', HINT), b.post('/api/public/hint', HINT)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(h.byok.calls.filter((c) => c.key === VISITOR_KEY)).toHaveLength(2); expect(h.byok.calls.filter((c) => c.key === OTHER)).toHaveLength(2);
    h.byok.valid.delete(OTHER); expect((await b.post('/api/public/hint', HINT)).status).toBe(503);                      // one visitor's revoked key does not affect the other
    expect((await a.post('/api/public/hint', HINT)).status).toBe(200);
  });

  it('keeps the key out of logs, the database, responses, headers and the URL', async () => {
    const h = await start({ PUBLIC_OPERATOR_AI: '1' }); const v = visitor(h, '10.5.2.1', VISITOR_KEY); const seen: string[] = [];
    const take = (r: { body: unknown; headers: Headers }) => { seen.push(JSON.stringify(r.body), JSON.stringify([...r.headers])); };
    take(await v.get('/api/public/status'));
    for (const mode of ['ok', 'invalid_key', 'rate', 'model', 'network', 'server'] as const) { h.byok.mode = mode; take(await v.post('/api/public/hint', HINT)); take(await v.post('/api/public/byok/test', {})); }
    take(await v.post('/api/public/extract', { text: 'x' })); take(await v.post('/api/public/hint', { question: '' }));       // validation failures
    expect(seen.join('\n')).not.toContain(VISITOR_KEY); expect(seen.join('\n')).not.toContain('sk-should-never-be-echoed');
    expect(h.logs.join('\n')).not.toContain(VISITOR_KEY); expect(await dump(h)).not.toContain(VISITOR_KEY.slice(4, 30));
    // a key put in the address is not a key: it is ignored, and the request is treated as having none
    const before = h.byok.calls.length; h.byok.mode = 'ok';
    const q = await h.student('q').post(`/api/public/hint?x-groq-key=${VISITOR_KEY}&key=${VISITOR_KEY}`, HINT, { headers: { 'x-forwarded-for': '10.5.2.2' } });
    expect(q.status).toBe(200); expect(h.byok.calls.length).toBe(before); expect(h.llm.calls).toHaveLength(1);   // the address key was ignored: this request had no key, so the site's assistant (opted in here) answered
  });

  it('"Test connection" reports every outcome, with limits and a clear message', async () => {
    const h = await start({}); const v = visitor(h, '10.5.3.1', VISITOR_KEY);
    const out = await v.post('/api/public/byok/test', {}); expect(out.body).toMatchObject({ ok: true, kind: 'ok', model: 'openai/gpt-oss-120b' }); expect(h.byok.calls[0].body.max_completion_tokens).toBeLessThanOrEqual(16);
    for (const [mode, kind] of [['invalid_key', 'invalid_key'], ['forbidden', 'forbidden'], ['model', 'model_unavailable'], ['rate', 'rate_limited'], ['network', 'network'], ['server', 'service']] as const) {
      h.byok.mode = mode; const r = await visitor(h, '10.5.3.' + (2 + ['invalid_key', 'forbidden', 'model', 'rate', 'network', 'server'].indexOf(mode)), VISITOR_KEY).post('/api/public/byok/test', {});
      expect(r.status).toBe(200); expect(r.body).toMatchObject({ ok: false, kind }); expect(r.body.message.length).toBeGreaterThan(20);
    }
    expect((await visitor(h, '10.5.3.20').post('/api/public/byok/test', {})).status).toBe(400);                           // no key
    const spam = visitor(h, '10.5.3.30', VISITOR_KEY); h.byok.mode = 'ok'; const codes: number[] = []; for (let i = 0; i < 8; i++) codes.push((await spam.post('/api/public/byok/test', {})).status);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true); expect(codes.slice(6)).toEqual([429, 429]);               // a visitor cannot hammer Groq through the site
  });

  it('bad keys and models are refused before anything is sent; the per-minute limit holds; BYOK can be switched off; owner data stays closed', async () => {
    const h = await start({ PUBLIC_BYOK_PER_MIN: '3' }); const calls0 = h.byok.calls.length;
    for (const bad of ['short', 'gsk_ has space ' + 'x'.repeat(30), 'a'.repeat(300)]) { const r = await visitor(h, '10.5.4.1', bad).post('/api/public/hint', HINT); expect(r.status).toBe(400); expect(r.body.error.code).toBe('byok_bad_key'); expect(JSON.stringify(r.body)).not.toContain(bad); }
    const m = await visitor(h, '10.5.4.1', VISITOR_KEY, '../../etc/passwd').post('/api/public/hint', HINT); expect(m.body.error.code).toBe('byok_bad_model');
    expect(h.byok.calls.length).toBe(calls0);
    const v = visitor(h, '10.5.4.2', VISITOR_KEY); const codes: number[] = []; for (let i = 0; i < 5; i++) codes.push((await v.post('/api/public/hint', HINT)).status); expect(codes).toEqual([200, 200, 200, 429, 429]);
    for (const p of ['/api/items', '/api/memory', '/api/myhelper/state', '/api/conversations', '/api/account/export']) expect((await v.get(p)).status, p).toBe(401);                      // a key header opens nothing else
    expect((await v.post('/api/conversations/x/messages', { text: 'hi' })).status).toBe(401);
    const off = await start({ PUBLIC_BYOK: '0' }); expect((await visitor(off, '10.5.4.3', VISITOR_KEY).post('/api/public/hint', HINT)).body.error.code).toBe('byok_disabled'); expect((await visitor(off, '10.5.4.3').get('/api/public/status')).body.byok).toBeNull();
  });
});
