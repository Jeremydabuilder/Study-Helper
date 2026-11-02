import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ChatGPTConnection, verifyChatGPTIdentity } from '../src/server/personal/chatgpt';
import { ChatGPTTransport } from '../src/ai/chatgpt';
import { buildProvider } from '../src/ai/factory';
import { configFromEnv } from '../src/server/config';
import { baseCfg, startServer, TestServer } from './helpers';
import { createHostedApp } from '../src/server/hosted/hosted';
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'sh-chatgpt-test-')); dirs.push(d); return d; };
let server: TestServer | null = null;
afterEach(async () => { await server?.close(); server = null; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scopes = 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct';
function fixture() {
  let nonce = '', subject = 'my-verified-account', calls = 0, now = 100000, badScope = false;
  let lastBody: URLSearchParams | null = null;
  const folder = dir();
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    calls++; lastBody = new URLSearchParams(String(init.body));
    if (String(_url).endsWith('/models')) return Response.json({ models: [{ slug: 'allowed-model', display_name: 'My study model', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }] });
    return Response.json({ access_token: `access-${calls}`, refresh_token: `refresh-${calls}`, token_type: 'Bearer', expires_in: 3600, scope: badScope ? 'openid email' : scopes, id_token: JSON.stringify({ sub: subject, email: 'my-account@example.test', nonce }) });
  }) as typeof fetch;
  const options = { fetch: fetcher, now: () => now, verify: async (t: string) => JSON.parse(t) };
  const connection = new ChatGPTConnection(folder, options);
  const begin = () => { const u = new URL(connection.begin('http://127.0.0.1:8787', 'browser-cookie')); nonce = u.searchParams.get('nonce')!; return u; };
  const finish = async (u = begin(), extra: Record<string, string> = {}) => connection.callback(new URLSearchParams({ state: u.searchParams.get('state')!, code: 'one-use-code', client_id: 'oaiapp_my-client', ...extra }), 'browser-cookie');
  return { connection, folder, begin, finish, options, calls: () => calls, body: () => lastBody!, advance: () => { now += 3600001; }, subject: (s: string) => { subject = s; }, badScope: () => { badScope = true; }, nonce: (n: string) => { nonce = n; } };
}
describe('personal account authorization', () => {
  it('uses official dynamic registration, stable host ID, PKCE and browser-bound one-use callbacks', async () => {
    const f = fixture(), u = f.begin();
    expect(u.origin + u.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(u.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(u.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toHaveLength(43);
    const bad = new URLSearchParams({ code: 'wrong', state: u.searchParams.get('state')!, client_id: 'oaiapp_my-client' });
    await expect(f.connection.callback(bad, 'different-browser')).rejects.toMatchObject({ code: 'not_configured' });
    expect(f.calls()).toBe(0);
    await f.finish(u);
    expect(f.body().get('client_id')).toBe('oaiapp_my-client');
    expect(f.body().get('redirect_uri')).toBe('http://127.0.0.1:8787/auth/chatgpt/callback');
    await expect(f.finish(u)).rejects.toMatchObject({ code: 'not_configured' });
    expect(f.calls()).toBe(1);
    const again = f.begin();
    expect(again.searchParams.get('client_id')).toBe('oaiapp_my-client');
    expect(again.searchParams.get('ext_agent_host_id')).toBe(u.searchParams.get('ext_agent_host_id'));
    expect(JSON.stringify(f.connection.status())).not.toContain('access-');
    expect(statSync(join(f.folder, 'credentials.json')).mode & 0o777).toBe(0o600);
  });
  it('rejects expired callbacks, cancelled consent, and missing plan permission', async () => {
    const f = fixture(), u = f.begin(); f.advance();
    await expect(f.finish(u)).rejects.toMatchObject({ code: 'not_configured' }); expect(f.calls()).toBe(0);
    const cancelled = f.begin();
    await expect(f.finish(cancelled, { error: 'access_denied' })).rejects.toMatchObject({ code: 'not_configured' }); expect(f.calls()).toBe(0);
    f.badScope(); await expect(f.finish()).rejects.toMatchObject({ code: 'not_configured' });
    expect(f.connection.status().connected).toBe(false);
  });
  it('retains the selected account across restart/disconnect and refuses another account or client', async () => {
    const f = fixture(); await f.finish();
    const original = readFileSync(join(f.folder, 'credentials.json'), 'utf8');
    f.subject('another-account'); await expect(f.finish()).rejects.toMatchObject({ code: 'not_configured' });
    expect(readFileSync(join(f.folder, 'credentials.json'), 'utf8')).toBe(original);
    const u = f.begin(); const before = f.calls();
    await expect(f.finish(u, { client_id: 'oaiapp_other-workspace' })).rejects.toMatchObject({ code: 'not_configured' }); expect(f.calls()).toBe(before);
    f.connection.disconnect(); expect(existsSync(join(f.folder, 'credentials.json'))).toBe(false);
    const again = new ChatGPTConnection(f.folder, f.options);
    expect(again.status()).toMatchObject({ connected: false, email: 'my-account@example.test' });
    expect(new URL(again.begin('http://127.0.0.1:8787', 'b')).searchParams.get('client_id')).toBe('oaiapp_my-client');
  });
  it('refreshes once for simultaneous requests and atomically saves rotating tokens', async () => {
    const f = fixture(); await f.finish(); f.advance();
    const access = await Promise.all(Array.from({ length: 20 }, () => f.connection.accessToken()));
    expect(new Set(access).size).toBe(1); expect(f.calls()).toBe(2);
    expect(f.body().get('grant_type')).toBe('refresh_token');
    const saved = JSON.parse(readFileSync(join(f.folder, 'credentials.json'), 'utf8'));
    expect(saved.refresh).toBe('refresh-2');
    expect(saved.access).toBe('access-2');
  });
  it('uses only account-advertised models, and no paid-provider fallback', async () => {
    const f = fixture(); await f.finish();
    expect(await f.connection.models()).toEqual([{ slug: 'allowed-model', display_name: 'My study model' }]);
    await expect(f.connection.selectModel('hidden')).rejects.toMatchObject({ code: 'not_configured' });
    await f.connection.selectModel('allowed-model');
    expect(buildProvider(baseCfg({ aiProvider: 'chatgpt', anthropicKey: 'other-key', groqKey: 'other-key' }), f.connection)?.providerId).toBe('chatgpt');
    f.connection.disconnect();
    expect(buildProvider(baseCfg({ aiProvider: 'chatgpt', anthropicKey: 'other-key' }), f.connection)).toBeNull();
    expect(configFromEnv({ AI_PROVIDER: 'chatgpt' }).aiPriceOverride).toEqual({ inPerM: 0, outPerM: 0 });
  });
  it('rejects an ID-token nonce that differs from the pending request', async () => {
    const f = fixture(), u = f.begin(); f.nonce('wrong-nonce');
    await expect(f.finish(u)).rejects.toMatchObject({ code: 'not_configured' });
    expect(f.connection.status().connected).toBe(false);
  });
  it('a disconnect during renewal cannot restore tokens or reconnect the account', async () => {
    const f = fixture(); await f.finish(); f.advance();
    const renewal = f.connection.accessToken(); f.connection.disconnect();
    await expect(renewal).rejects.toMatchObject({ code: 'not_configured' });
    expect(f.connection.status().connected).toBe(false);
    expect(existsSync(join(f.folder, 'credentials.json'))).toBe(false);
  });
  it('never includes damaged credential contents in errors', () => {
    const d = dir(); writeFileSync(join(d, 'credentials.json'), '{"access":"PRIVATE-TOKEN-SENTINEL');
    try { new ChatGPTConnection(d); throw new Error('should reject damaged credentials'); }
    catch (e) { expect((e as Error).message).toContain('unreadable'); expect((e as Error).message).not.toContain('PRIVATE-TOKEN'); }
  });
  it('verifies real ID-token signatures, issuer, audience and expiry', async () => {
    const pair = await generateKeyPair('RS256'), jwk = await exportJWK(pair.publicKey);
    const keySet = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256' }] });
    const sign = (issuer = 'https://auth.openai.com', aud = 'oaiapp_my-client', expiry = '1h') => new SignJWT({ nonce: 'nonce' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer).setAudience(aud).setSubject('my-account').setIssuedAt().setExpirationTime(expiry).sign(pair.privateKey);
    expect((await verifyChatGPTIdentity(await sign(), 'oaiapp_my-client', keySet as never)).sub).toBe('my-account');
    await expect(verifyChatGPTIdentity(await sign('https://impostor.test'), 'oaiapp_my-client', keySet as never)).rejects.toThrow();
    await expect(verifyChatGPTIdentity(await sign(undefined, 'wrong-client'), 'oaiapp_my-client', keySet as never)).rejects.toThrow();
    await expect(verifyChatGPTIdentity(await sign(undefined, undefined, '-1h'), 'oaiapp_my-client', keySet as never)).rejects.toThrow();
    const jwt = await sign(); await expect(verifyChatGPTIdentity(jwt.slice(0, -10) + 'tamperedxx', 'oaiapp_my-client', keySet as never)).rejects.toThrow();
  });
  it('is never shared through hosted mode and rejects DNS-rebinding hosts locally', async () => {
    await expect(createHostedApp({ cfg: baseCfg({ aiProvider: 'chatgpt' }), hcfg: {} as never, dataDir: dir() })).rejects.toThrow('personal and local');
    server = await startServer({ cfg: { aiProvider: 'chatgpt' } });
    expect((await server.call('GET', '/api/chatgpt/status')).body).toMatchObject({ connected: false, email: null });
    const bad = await fetch(`http://127.0.0.1:${server.port}/api/chatgpt/status`, { headers: { host: 'attacker.test', origin: 'http://attacker.test' } });
    expect(bad.status).toBe(403);
    expect((await server.call('POST', '/api/chatgpt/model', { model: 'not-authorized' })).status).toBe(503);
  });
});
const request = { system: 'Return one JSON object.', user: 'My question', model: 'allowed-model', maxTokens: 500, timeoutMs: 1000 };
const event = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
describe('personal Responses transport', () => {
  it('omits forbidden parameters, uses the selected account token and waits for a completed response', async () => {
    const f = fixture(); await f.finish(); await f.connection.selectModel('allowed-model');
    let seen: any;
    const transport = new ChatGPTTransport(f.connection, (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)), headers: init.headers };
      return new Response(event({ type: 'response.completed', response: { status: 'completed', model: 'allowed-model', id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"reply":"Study hint"}' }] }], usage: { input_tokens: 10, output_tokens: 8 } } }));
    }) as typeof fetch);
    expect(await transport.complete(request)).toMatchObject({ text: '{"reply":"Study hint"}', model: 'allowed-model', usage: { input: 10, output: 8 } });
    expect(seen.url).toBe('https://api.openai.com/v1/responses');
    expect(seen.body).toEqual({ model: 'allowed-model', instructions: request.system, input: [{ role: 'user', content: request.user }], store: false, stream: true });
    expect(seen.headers.authorization).toBe('Bearer access-1');
  });
  it.each(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'])('does not return partial text as success after %s', async code => {
    const f = fixture(); await f.finish(); await f.connection.selectModel('allowed-model');
    const transport = new ChatGPTTransport(f.connection, (async () => new Response(event({ type: 'response.output_text.delta', delta: 'partial' }) + event({ type: 'response.failed', response: { error: { code } } }))) as typeof fetch);
    await expect(transport.complete(request)).rejects.toThrow('Manage usage');
  });
  it('refuses incomplete or interrupted answers and never sends a different model', async () => {
    const f = fixture(); await f.finish(); await f.connection.selectModel('allowed-model');
    let calls = 0;
    const transport = new ChatGPTTransport(f.connection, (async () => { calls++; return new Response(event({ type: 'response.output_text.delta', delta: 'partial' })); }) as typeof fetch);
    await expect(transport.complete({ ...request, model: 'other' })).rejects.toMatchObject({ code: 'not_configured' }); expect(calls).toBe(0);
    await expect(transport.complete(request)).rejects.toMatchObject({ code: 'malformed' });
    await expect(transport.complete({ ...request, attachments: [{ kind: 'image', mediaType: 'image/png', data: 'fake' }] })).rejects.toMatchObject({ billing: 'not_sent' }); expect(calls).toBe(1);
  });
});
