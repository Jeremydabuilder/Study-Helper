import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { AIError } from '../../ai/provider';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const keys = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
export async function verifyChatGPTIdentity(token: string, clientId: string, keySet = keys) {
  return (await jwtVerify(token, keySet, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'] })).payload;
}
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const fail = (message = 'ChatGPT sign-in could not be verified. Try signing in again.') => new AIError('not_configured', message, undefined, 'not_sent');
interface Identity { clientId: string; subject: string; email: string | null }
interface Credentials extends Identity { access: string; refresh: string; idToken: string; expiresAt: number; scopes: string[]; model: string | null; welcomed: boolean }
interface Pending { state: string; browser: string; nonce: string; verifier: string; redirect: string; expires: number; clientId: string | null; generation: number }
interface Model { slug: string; display_name: string }
interface Options { fetch?: typeof fetch; now?: () => number; verify?: (token: string, clientId: string) => Promise<JWTPayload> }

/** Personal loopback-only connection. No access to ChatGPT/Codex credential files.
 * Identity stays bound after disconnect, so reconnecting cannot silently select
 * another account/workspace. Tokens are never returned by status/routes. */
export class ChatGPTConnection {
  private credential: Credentials | null = null;
  private identity: Identity | null = null;
  private pending: Pending | null = null;
  private catalog: Model[] = [];
  private refreshing: Promise<string> | null = null;
  private generation = 0;
  private hostId: string;
  private fetch: typeof fetch;
  private now: () => number;
  private verify: (token: string, clientId: string) => Promise<JWTPayload>;
  constructor(private dir: string, o: Options = {}) {
    this.fetch = o.fetch ?? fetch; this.now = o.now ?? Date.now;
    this.verify = o.verify ?? verifyChatGPTIdentity;
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    const host = this.read<{ id: string }>('host.json');
    this.hostId = host?.id ?? `urn:uuid:${randomUUID()}`;
    if (!host) this.save('host.json', { id: this.hostId });
    this.identity = this.read<Identity>('identity.json');
    this.credential = this.read<Credentials>('credentials.json');
    if (this.credential && (!this.identity || this.credential.subject !== this.identity.subject || this.credential.clientId !== this.identity.clientId)) throw fail('The saved ChatGPT connection is inconsistent. Disconnect it before reconnecting.');
  }
  private read<T>(name: string): T | null { const f = join(this.dir, name); if (!existsSync(f)) return null; chmodSync(f, 0o600); try { return JSON.parse(readFileSync(f, 'utf8')); } catch { throw fail('The saved ChatGPT connection is unreadable. Reconnect using a fresh private data folder.'); } }
  private save(name: string, value: unknown) { const f = join(this.dir, name), temp = `${f}.${randomUUID()}.tmp`; try { writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temp, f); chmodSync(f, 0o600); } finally { rmSync(temp, { force: true }); } }
  get model() { return this.credential?.model ?? null; }
  get fingerprint() { return createHash('sha256').update(`${this.identity?.clientId ?? ''}:${this.identity?.subject ?? ''}`).digest('hex').slice(0, 12); }
  status() { return { connected: !!this.credential, email: this.identity?.email ?? null, model: this.model, needsWelcome: !!this.credential && !this.credential.welcomed, usingPlan: !!this.credential && !!this.model, manageUsageUrl: 'https://chatgpt.com/settings/usage' }; }
  begin(origin: string, browser: string) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') throw fail('Open Study Helper at http://127.0.0.1:8787 to connect ChatGPT.');
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const redirect = `${url.origin}/auth/chatgpt/callback`;
    this.pending = { state, browser, nonce, verifier, redirect, expires: this.now() + 600_000, clientId: this.identity?.clientId ?? null, generation: this.generation };
    const params = new URLSearchParams({ client_id: this.identity?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: this.hostId, response_type: 'code', redirect_uri: redirect, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    if (!this.identity) params.set('agent_name_hint', 'Study Helper');
    if (this.credential?.idToken) params.set('id_token_hint', this.credential.idToken);
    if (this.identity?.email) params.set('login_hint', this.identity.email);
    return `${ISSUER}/api/accounts/authorize?${params}`;
  }
  private async token(body: URLSearchParams) {
    const res = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!res.ok) throw fail('ChatGPT authorization expired or was declined. Sign in again; no other provider will be used.');
    const j = await res.json() as Record<string, unknown>;
    if (typeof j.access_token !== 'string' || typeof j.refresh_token !== 'string' || typeof j.expires_in !== 'number' || j.expires_in <= 0 || String(j.token_type).toLowerCase() !== 'bearer') throw fail();
    return j as { access_token: string; refresh_token: string; id_token?: string; expires_in: number; scope?: string };
  }
  async callback(query: URLSearchParams, browser: string | null) {
    const p = this.pending;
    // A stranger's invalid callback must not consume the real browser's attempt.
    if (!p || !browser || browser !== p.browser || query.get('state') !== p.state || p.expires <= this.now()) throw fail();
    this.pending = null;
    if (query.has('error') || !query.get('code')) throw fail('ChatGPT sign-in was cancelled. You can try again.');
    const clientId = query.get('client_id') ?? p.clientId;
    if (!clientId || clientId === 'dynamic_agent_client' || (p.clientId && clientId !== p.clientId)) throw fail();
    const tokens = await this.token(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: query.get('code')!, code_verifier: p.verifier, redirect_uri: p.redirect, resource: RESOURCE }));
    if (!tokens.id_token) throw fail();
    let claims: JWTPayload;
    try { claims = await this.verify(tokens.id_token, clientId); } catch { throw fail(); }
    if (!claims.sub || claims.nonce !== p.nonce || (this.identity && (claims.sub !== this.identity.subject || clientId !== this.identity.clientId))) throw fail('This is a different ChatGPT account or workspace. The saved account was not changed. Choose your original account.');
    const scopes = tokens.scope?.split(/\s+/) ?? [];
    if (!scopes.includes(PLAN_SCOPE) || !scopes.includes('resource.invoke')) throw fail('ChatGPT plan permission was not granted. Sign in again and approve plan use.');
    if (p.generation !== this.generation) throw fail();
    const identity = { clientId, subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : null };
    const c: Credentials = { ...identity, access: tokens.access_token, refresh: tokens.refresh_token, idToken: tokens.id_token, expiresAt: this.now() + tokens.expires_in * 1000, scopes, model: this.credential?.model ?? null, welcomed: this.credential?.welcomed ?? false };
    this.save('identity.json', identity); this.save('credentials.json', c);
    this.identity = identity; this.credential = c; this.catalog = [];
  }
  async accessToken(): Promise<string> {
    const c = this.credential;
    if (!c) throw fail('Connect your ChatGPT account in Settings first.');
    // Refresh only on expiry, avoiding undocumented early-refresh assumptions.
    if (c.expiresAt > this.now()) return c.access;
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    this.refreshing = (async () => {
      const t = await this.token(new URLSearchParams({ grant_type: 'refresh_token', client_id: c.clientId, refresh_token: c.refresh, resource: RESOURCE }));
      const scopes = t.scope?.split(/\s+/) ?? c.scopes;
      if (!scopes.includes(PLAN_SCOPE) || !scopes.includes('resource.invoke')) throw fail('ChatGPT plan permission ended. Reconnect in Settings.');
      if (t.id_token) {
        let claims: JWTPayload; try { claims = await this.verify(t.id_token, c.clientId); } catch { throw fail(); }
        if (claims.sub !== c.subject) throw fail();
      }
      if (generation !== this.generation || this.credential !== c) throw fail();
      const next = { ...c, access: t.access_token, refresh: t.refresh_token, idToken: t.id_token ?? c.idToken, expiresAt: this.now() + t.expires_in * 1000, scopes };
      this.save('credentials.json', next); this.credential = next;
      return next.access;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async models(): Promise<Model[]> {
    const token = await this.accessToken();
    const res = await this.fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!res.ok) throw fail('Could not load the models allowed by your ChatGPT account. Reconnect or try again later.');
    const j = await res.json() as { models?: { slug?: string; display_name?: string; visibility?: string }[] };
    this.catalog = (j.models ?? []).filter(m => m.visibility === 'list' && typeof m.slug === 'string' && typeof m.display_name === 'string').map(m => ({ slug: m.slug!, display_name: m.display_name! }));
    return this.catalog;
  }
  async selectModel(slug: string) {
    if (!(await this.models()).some(m => m.slug === slug) || !this.credential) throw fail('Choose a model available to your connected ChatGPT account.');
    this.credential = { ...this.credential, model: slug }; this.save('credentials.json', this.credential);
  }
  welcome() { if (this.credential) { this.credential.welcomed = true; this.save('credentials.json', this.credential); } }
  disconnect() { this.generation++; this.pending = null; this.catalog = []; this.credential = null; rmSync(join(this.dir, 'credentials.json'), { force: true }); }
}
