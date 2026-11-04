/**
 * Bring your own Groq key: the visitor's own key, used for ONE request at a time and never kept.
 *
 * Why a relay at all: whether Groq answers requests made straight from a web page (CORS) could not be verified from the build environment (Groq's documentation and
 * API are not reachable from it) and third-party sources disagree, so the page sends the key to this server for the length of one request and the server forwards it.
 * Rules this file enforces (and tests/byok.test.ts checks):
 *  - the only address ever called is GROQ_CHAT_URL; the key is sent only to it, as a Bearer header, and redirects are refused (a redirect could carry the header elsewhere)
 *  - nothing from a failed response body is passed on or logged (it could echo request content); messages here are fixed text and never contain the key
 *  - the key is not stored, cached, fingerprinted or put in any object that outlives the request; a new transport is made for every request
 *  - it never touches the operator's key, ledger or shared capacity guard (so one visitor's key cannot overwrite or be mixed with another's or the operator's)
 */
import { AIError } from './provider';
import { LLMRequest, LLMResponse, LLMTransport } from './llm';

export const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const BYOK_DEFAULT_MODEL = 'openai/gpt-oss-120b';
/** Suggestions only: Groq's catalogue changes, and none of these were checked against Groq's live model list from the build environment. */
export const BYOK_MODEL_SUGGESTIONS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
export const KEY_PATTERN = /^[A-Za-z0-9_-]{20,256}$/;
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]{1,79}$/;
export type ByokKind = 'ok' | 'invalid_key' | 'forbidden' | 'model_unavailable' | 'rate_limited' | 'network' | 'timeout' | 'service' | 'rejected';
export interface ByokResult { ok: boolean; kind: ByokKind; message: string; retryAfterMs?: number }

const MSG: Record<Exclude<ByokKind, 'ok'>, string> = {
  invalid_key: 'Groq did not accept this key. Check that you copied the whole key and that it has not been deleted in your Groq account.',
  forbidden: 'Groq refused this key’s access. The key may be restricted, or your Groq account or region may not allow it.',
  model_unavailable: 'Groq says that model is not available for your account. Pick another model in Settings.',
  rate_limited: 'Your Groq account has reached its usage limit for now. Wait a little, or check your limits in your Groq account.',
  network: 'Could not reach Groq from this site’s server. Check your connection and try again.',
  timeout: 'Groq did not answer in time. Try again.',
  service: 'Groq reported a temporary problem. Try again in a minute.',
  rejected: 'Groq rejected the request.',
};
const retryMs = (h: Headers) => { const n = Number(h.get('retry-after')); return Number.isFinite(n) && n > 0 ? Math.min(3_600_000, Math.ceil(n * 1000)) : undefined; };
type Fail = Exclude<ByokKind, 'ok'>;
function classify(status: number, code: string): Fail {
  if (status === 401) return 'invalid_key';
  if (status === 403) return 'forbidden';
  if (status === 404 || /model_not_found|model_decommissioned|model_not_active|model_terms_required/i.test(code)) return 'model_unavailable';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'service';
  return 'rejected';
}
async function post(fetchImpl: typeof fetch, key: string, body: unknown, timeoutMs: number): Promise<{ res: Response; code: string } | { fail: Fail }> {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(GROQ_CHAT_URL, { method: 'POST', redirect: 'error', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    let code = ''; if (!res.ok) { const t = await res.text().catch(() => ''); try { code = String(JSON.parse(t)?.error?.code ?? ''); } catch { /* not JSON: the body is dropped */ } }
    return { res, code };
  } catch (e) { return { fail: e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network' }; }
  finally { clearTimeout(timer); }
}

/** A small real request: one token-sized chat completion on the chosen model. Used by "Test connection". */
export async function pingGroq(key: string, model: string, fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): Promise<ByokResult & { latencyMs?: number }> {
  const t0 = Date.now();
  const r = await post(fetchImpl, key, { model, max_completion_tokens: 16, temperature: 0, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }, timeoutMs);
  if ('fail' in r) return { ok: false, kind: r.fail, message: MSG[r.fail] };
  if (r.res.ok) { await r.res.body?.cancel().catch(() => {}); return { ok: true, kind: 'ok', message: 'Connected. Your key works with this model.', latencyMs: Date.now() - t0 }; }
  const kind = classify(r.res.status, r.code);
  return { ok: false, kind, message: MSG[kind], retryAfterMs: kind === 'rate_limited' ? retryMs(r.res.headers) : undefined };
}

/** One visitor's key, for one request. Not registered anywhere, no ledger, no shared capacity state. */
export class ByokTransport implements LLMTransport {
  readonly provider = 'groq';
  constructor(private key: string, readonly defaultModel: string, private fetchImpl: typeof fetch = fetch) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (req.attachments?.length) throw new AIError('rejected', 'Images and PDFs are not sent through this path.', undefined, 'not_sent');
    const model = req.model || this.defaultModel;
    const r = await post(this.fetchImpl, this.key, { model, max_completion_tokens: req.maxTokens, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }] }, req.timeoutMs);
    if ('fail' in r) throw new AIError(r.fail === 'timeout' ? 'timeout' : 'unavailable', MSG[r.fail], undefined, r.fail === 'timeout' ? 'unknown' : 'not_sent');
    if (!r.res.ok) {
      const kind = classify(r.res.status, r.code);
      if (r.res.status === 400 && r.code === 'json_validate_failed') return { text: '', model, stopReason: 'stop', requestId: null, usage: null };
      const code = kind === 'invalid_key' || kind === 'forbidden' ? 'not_configured' : kind === 'rate_limited' ? 'rate_limited' : kind === 'service' ? 'unavailable' : 'rejected';
      throw new AIError(code, MSG[kind], kind === 'rate_limited' ? retryMs(r.res.headers) ?? 30_000 : undefined, 'none_reported');
    }
    let j: { model?: string; choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try { j = await r.res.json(); } catch { throw new AIError('malformed', 'Groq sent an unreadable answer.', undefined, 'unknown'); }
    const u = j.usage;
    return { text: j.choices?.[0]?.message?.content ?? '', model: j.model ?? model, stopReason: j.choices?.[0]?.finish_reason ?? null, requestId: null, usage: u && typeof u.prompt_tokens === 'number' ? { input: u.prompt_tokens, output: u.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 } : null };
  }
}
