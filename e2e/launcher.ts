/**
 * Starts a complete hosted Study Helper for browser tests: real server, real PostgreSQL (TEST_DATABASE_URL), real sign-in library, per-student SQLite files,
 * a fake OpenID Connect provider and scripted AI replies. A small control API (127.0.0.1 only, test environment only) lets tests create invitations,
 * move the app's clock forward, make the AI fail, pause the pilot and choose who "signs in" at the fake identity provider.
 * NOTHING here is a live service. It checks plumbing, not AI quality.
 */
import { createServer } from 'node:http';
import { HostedHarness } from '../tests/hostedHarness';
import { setSettingPg } from '../src/server/hosted/pg';
import { AIError } from '../src/ai/provider';

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 4180), CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 4181);
const limits = process.env.E2E_LIMITS ? JSON.parse(process.env.E2E_LIMITS) : {};
const h = await HostedHarness.start({ port: APP_PORT, passwordSignIn: true, limits });

const json = (res: import('node:http').ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const b = raw ? JSON.parse(raw) : {}; const path = new URL(req.url!, 'http://x').pathname;
    try {
      if (path === '/control/invites') return json(res, { codes: await h.codes(b.count ?? 1, b.days ?? 7) });
      if (path === '/control/idp') { h.idp.nextEmail = b.email; return json(res, { ok: true }); }
      if (path === '/control/advance') { h.clock.now += b.ms; return json(res, { now: h.clock.now }); }
      if (path === '/control/llm-fail') { h.llm.failNext = new AIError(b.code ?? 'timeout', 'scripted provider failure'); return json(res, { ok: true }); }
      if (path === '/control/llm-delay') { h.llm.delayMs = b.ms ?? 0; return json(res, { ok: true }); }
      if (path === '/control/llm-reply') { h.llm.replies[b.kind] = b.reply; return json(res, { ok: true }); }
      if (path === '/control/setting') { await setSettingPg(h.db.pool, b.key, b.value); return json(res, { ok: true }); }
      if (path === '/control/expire-sessions') { await h.db.pool.query('UPDATE session SET "expiresAt" = now() - interval \'1 minute\''); return json(res, { ok: true }); }
      if (path === '/control/state') {
        const q = async (sql: string) => (await h.db.pool.query(sql)).rows[0];
        return json(res, { users: (await q('SELECT COUNT(*)::int n FROM "user"')).n, aiRequests: (await q('SELECT COUNT(*)::int n FROM ai_requests')).n, llmCalls: h.llm.calls.length, now: h.clock.now });
      }
      json(res, { error: 'unknown' }, 404);
    } catch (e) { json(res, { error: e instanceof Error ? e.message : 'failed' }, 500); }
  });
}).listen(CONTROL_PORT, '127.0.0.1', () => console.log(`E2E READY app=http://127.0.0.1:${APP_PORT} control=http://127.0.0.1:${CONTROL_PORT}`));
const stop = async () => { await h.stop(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
