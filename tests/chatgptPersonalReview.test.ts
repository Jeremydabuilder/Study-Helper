/** Independent review of the personal ChatGPT connection: each test below failed on codex/chatgpt-personal before the matching fix. Fake accounts and mocked responses only: this proves the app's rules, not live OpenAI behaviour. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGPTConnection } from '../src/server/personal/chatgpt';
import { ChatGPTTransport } from '../src/ai/chatgpt';
import { restrictToCurrentUser, syncedFolderWarning } from '../src/server/personal/protect';
import { startServer, TestServer } from './helpers';
const dirs: string[] = []; let server: TestServer | null = null;
afterEach(async () => { await server?.close(); server = null; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scopes = 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct';
function fx() {
  const folder = mkdtempSync(join(tmpdir(), 'sh-repro-')); dirs.push(folder);
  let nonce = '', now = 100000, calls = 0, gate: Promise<void> | null = null, modelsGate: Promise<void> | null = null, refreshStatus = 200, refreshBody: unknown = null;
  const fetcher = (async (url: unknown, init: RequestInit) => {
    calls++;
    if (String(url).endsWith('/models')) { if (modelsGate) await modelsGate; return Response.json({ models: [{ slug: 'm1', display_name: 'M1', visibility: 'list' }] }); }
    const body = new URLSearchParams(String(init.body));
    if (body.get('grant_type') === 'refresh_token') { if (gate) await gate; if (refreshStatus !== 200) return Response.json(refreshBody ?? {}, { status: refreshStatus }); }
    return Response.json({ access_token: `access-${calls}`, refresh_token: `refresh-${calls}`, token_type: 'Bearer', expires_in: 3600, scope: scopes, id_token: JSON.stringify({ sub: 's1', email: 'a@example.test', nonce }) });
  }) as typeof fetch;
  const c = new ChatGPTConnection(folder, { fetch: fetcher, now: () => now, verify: async (t: string) => JSON.parse(t) });
  const connect = async () => { const u = new URL(c.begin('http://127.0.0.1:8787', 'b')); nonce = u.searchParams.get('nonce')!; await c.callback(new URLSearchParams({ state: u.searchParams.get('state')!, code: 'x', client_id: 'oaiapp_c' }), 'b'); };
  return { c, folder, connect, advance: (ms = 3600001) => { now += ms; }, setGate: (g: Promise<void> | null) => { gate = g; }, setModelsGate: (g: Promise<void> | null) => { modelsGate = g; }, fail: (status: number, body: unknown) => { refreshStatus = status; refreshBody = body; }, calls: () => calls, setNow: (n: number) => { now = n; }, now: () => now };
}
it('model selection finishing while a renewal is in flight must not discard the rotated tokens', async () => {
  const f = fx(); await f.connect();
  let openModels!: () => void, openRefresh!: () => void;
  f.setModelsGate(new Promise<void>((r) => (openModels = r))); f.setGate(new Promise<void>((r) => (openRefresh = r)));
  const select = f.c.selectModel('m1');                // token still valid: waits on the model list
  await new Promise((r) => setTimeout(r, 5)); f.advance(); // the token expires meanwhile
  const renewal = f.c.accessToken();                    // renewal starts and waits on the provider
  openModels(); await select;                           // selection replaces the credential object
  openRefresh();                                        // provider has already rotated the refresh token
  await expect(renewal).resolves.toMatch(/^access-/);
  expect(f.c.status().connected).toBe(true);
});
it('renews a token that has under a minute left before using it', async () => {
  const f = fx(); await f.connect();
  f.advance(3600_000 - 5_000); // 5 s left
  const before = f.calls(); await f.c.accessToken();
  expect(f.calls()).toBe(before + 1);
});
it('a request answered 401 renews once and is sent again; a second 401 stops with a reconnect message and no other provider', async () => {
  const f = fx(); await f.connect(); await f.c.selectModel('m1');
  const seen: string[] = []; let mode: 'once' | 'always' = 'once';
  const ok = `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'fine' }] }], id: 'r' } })}\n\n`;
  const t = new ChatGPTTransport(f.c, (async (_u: string, init: RequestInit) => { const auth = String((init.headers as Record<string, string>).authorization); seen.push(auth); return mode === 'always' || seen.length === 1 ? new Response('no', { status: 401 }) : new Response(ok); }) as typeof fetch);
  const req = { system: 's', user: 'u', model: 'm1', maxTokens: 1, timeoutMs: 1000 };
  expect((await t.complete(req)).text).toBe('fine');
  expect(seen).toHaveLength(2); expect(seen[0]).not.toBe(seen[1]);
  seen.length = 0; mode = 'always';
  await expect(t.complete(req)).rejects.toThrow('Reconnect your ChatGPT account');
  expect(seen).toHaveLength(2); // one retry, never more
});
it.each([[400, { error: 'refresh_token_reused' }], [401, { error: { code: 'refresh_token_invalidated' } }], [400, { error: 'invalid_grant' }]])('a refresh token the provider has ended for good (%s %j) clears the tokens, keeps the account binding, and tells the page', async (status, body) => {
  const f = fx(); await f.connect(); f.advance(); f.fail(status, body); let told = 0; f.c.onChange(() => told++);
  await expect(f.c.accessToken()).rejects.toMatchObject({ code: 'not_configured' });
  expect(told).toBe(1);
  expect(f.c.status().connected).toBe(false);
  expect(existsSync(join(f.folder, 'credentials.json'))).toBe(false);
  expect(f.c.status().email).toBe('a@example.test');
});
it('a forged callback cannot clear the real sign-in cookie, and the genuine return trip is not refused for another site\'s Origin', async () => {
  server = await startServer({ cfg: { aiProvider: 'chatgpt' } });
  const forged = await fetch(`http://127.0.0.1:${server.port}/auth/chatgpt/callback?state=forged`, { redirect: 'manual', headers: { cookie: 'sh_chatgpt_oauth=abc' } });
  expect(forged.headers.get('set-cookie') ?? '').not.toMatch(/sh_chatgpt_oauth=;/);
  const viaForm = await fetch(`http://127.0.0.1:${server.port}/auth/chatgpt/callback?state=x`, { redirect: 'manual', headers: { origin: 'https://auth.openai.com' } });
  expect(viaForm.status).toBe(302); expect(viaForm.headers.get('location')).toContain('chatgpt=failed');
  const other = await fetch(`http://127.0.0.1:${server.port}/api/chatgpt/disconnect`, { method: 'POST', headers: { origin: 'https://auth.openai.com', 'content-type': 'application/json' }, body: '{}' });
  expect(other.status).toBe(403); // every other route still refuses a foreign Origin
});
it('the answer text is taken from output items when the completed event has none', async () => {
  const f = fx(); await f.connect(); await f.c.selectModel('m1');
  const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const t = new ChatGPTTransport(f.c, (async () => new Response(sse({ type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: '{"reply":"hi"}' }] } }) + sse({ type: 'response.completed', response: { status: 'completed', output: [], id: 'r' } }))) as typeof fetch);
  expect((await t.complete({ system: 's', user: 'u', model: 'm1', maxTokens: 1, timeoutMs: 1000 })).text).toBe('{"reply":"hi"}');
});

it('a temporary provider failure while renewing keeps the saved sign-in', async () => {
  const f = fx(); await f.connect(); f.advance(); f.fail(503, {});
  await expect(f.c.accessToken()).rejects.toMatchObject({ code: 'not_configured' });
  expect(f.c.status().connected).toBe(true); expect(existsSync(join(f.folder, 'credentials.json'))).toBe(true);
});
it('a sign-in that completes while a renewal is in flight is not overwritten by the older renewal', async () => {
  const f = fx(); await f.connect(); f.advance(); let open!: () => void; f.setGate(new Promise<void>((r) => (open = r)));
  const renewal = f.c.accessToken(); f.setGate(null);
  await f.connect(); const fresh = JSON.parse(readFileSync(join(f.folder, 'credentials.json'), 'utf8'));
  open(); await expect(renewal).rejects.toMatchObject({ code: 'not_configured' });
  expect(JSON.parse(readFileSync(join(f.folder, 'credentials.json'), 'utf8')).refresh).toBe(fresh.refresh);
});
it('failures report only a safe reason to the page', async () => {
  const f = fx(); await f.connect();
  const u = new URL(f.c.begin('http://127.0.0.1:8787', 'b'));
  await expect(f.c.callback(new URLSearchParams({ state: u.searchParams.get('state')!, error: 'access_denied' }), 'b')).rejects.toMatchObject({ reason: 'cancelled' });
  f.c.begin('http://127.0.0.1:8787', 'b');
  await expect(f.c.callback(new URLSearchParams({ state: 'forged' }), 'b')).rejects.toMatchObject({ reason: 'generic' });
  f.advance(700_000);
  await expect(f.c.callback(new URLSearchParams({ state: 'x' }), 'b')).rejects.toMatchObject({ reason: 'expired' });
});
describe('where the saved sign-in lives', () => {
  it('refuses to start a sign-in whose folder is inside a cloud-synced folder, and says how to move it', () => {
    expect(syncedFolderWarning('C:\\Users\\Me\\OneDrive\\Documents\\Study-Helper\\data\\chatgpt-auth')).toMatch(/CHATGPT_AUTH_DIR/);
    expect(syncedFolderWarning('/Users/me/Library/Mobile Documents/com~apple~CloudDocs/x')).toBeTruthy();
    expect(syncedFolderWarning('/home/me/Dropbox/study/data/chatgpt-auth')).toBeTruthy();
    expect(syncedFolderWarning('C:\\Users\\Me\\AppData\\Local\\StudyHelper\\chatgpt-auth')).toBeNull();
    expect(syncedFolderWarning('/home/me/study/data/chatgpt-auth')).toBeNull();
    const base = mkdtempSync(join(tmpdir(), 'sh-sync-')); dirs.push(base);
    const synced = join(base, 'OneDrive', 'auth');
    const c = new ChatGPTConnection(synced, { warn: () => {} });
    expect(() => c.begin('http://127.0.0.1:8787', 'b')).toThrow(/cloud-synced/);
    expect(c.status().storageWarning).toBeTruthy();
    expect(() => new ChatGPTConnection(join(base, 'private'), { warn: () => {} }).begin('http://127.0.0.1:8787', 'b')).not.toThrow();
  });
  it('on Windows the folder is restricted to the current user (and the system account) with icacls; elsewhere nothing runs', () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { status: 0 }; };
    expect(restrictToCurrentUser('C:\\data\\auth', { platform: 'win32', env: { USERNAME: 'Jeremy', USERDOMAIN: 'PC' }, run })).toEqual({ ok: true, note: null });
    expect(calls[0].cmd).toBe('icacls'); expect(calls[0].args).toEqual(expect.arrayContaining(['/inheritance:r', 'PC\\Jeremy:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F']));
    expect(restrictToCurrentUser('/x', { platform: 'linux', run })).toEqual({ ok: true, note: null }); expect(calls).toHaveLength(1);
    expect(restrictToCurrentUser('C:\\x', { platform: 'win32', env: { USERNAME: 'a' }, run: () => ({ status: 5 }) }).ok).toBe(false);
    expect(restrictToCurrentUser('C:\\x', { platform: 'win32', env: {}, run }).ok).toBe(false);
    const warned: string[] = [];
    new ChatGPTConnection(mkdtempSync(join(tmpdir(), 'sh-win-')), { warn: (m) => warned.push(m), restrict: () => ({ ok: false, note: 'Windows would not let Study Helper restrict' }) });
    expect(warned.join()).toContain('restrict');
  });
});
