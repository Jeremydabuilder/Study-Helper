/**
 * Optional, opt-in Groq transport (OpenAI-compatible chat completions). Only constructed when the operator sets AI_PROVIDER=groq with GROQ_API_KEY.
 * The model is chosen by the OPERATOR (GROQ_MODEL, default below); students never choose one. The default ID comes from a secondary source because
 * Groq's own model page was not reachable from the build environment, so it is NOT verified against the live API. If Groq retires it, set GROQ_MODEL.
 *
 * Capacity: Groq's Free tier is small and shared by everyone who uses the key. Every call passes through one GroqCapacity guard (see groqCapacity.ts):
 * paced locally, remembered refusals, honest wait times. Nothing here switches to another provider or to a paid plan.
 */
export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
import { AIError } from './provider';
import { LLMRequest, LLMResponse, LLMTransport, classifyFetchFailure, credentialFingerprint } from './llm';
import { CapacityOptions, GroqCapacity, parseDuration, setActiveCapacity, waitWords } from './groqCapacity';

/** A rough token estimate for pacing only (the provider's reported usage replaces it afterwards). */
const estimateTokens = (req: LLMRequest) => Math.ceil((Buffer.byteLength(req.system) + Buffer.byteLength(req.user)) / 3) + Math.min(req.maxTokens, 1500);

export class GroqTransport implements LLMTransport {
  readonly provider = 'groq';
  readonly credentialFingerprint: string;
  readonly capacity: GroqCapacity;
  constructor(private apiKey: string, public readonly defaultModel: string, private fetchImpl: typeof fetch = fetch, capacity: Partial<CapacityOptions> | GroqCapacity = {}) {
    this.credentialFingerprint = credentialFingerprint('groq', apiKey, 'https://api.groq.com');
    this.capacity = capacity instanceof GroqCapacity ? capacity : new GroqCapacity(capacity);
    setActiveCapacity(this.capacity);
  }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (req.attachments?.length) throw new AIError('rejected', 'Groq is not configured to read images or PDFs here. Nothing was sent.', undefined, 'not_sent');
    const slot = await this.capacity.acquire(estimateTokens(req)); // waits briefly in turn, or refuses with an honest wait; nothing is sent in that case
    let actual: number | null = null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
    const model = req.model || this.defaultModel;
    try {
      const res = await this.fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model, max_completion_tokens: req.maxTokens, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }] }),
      });
      this.capacity.noteHeaders(res.headers);
      if (!res.ok) {
        const body = await res.text().catch(() => ''); // read it to free the connection; only used to find the wait time and a code, never shown or logged
        let msg = '', code = ''; try { const j = JSON.parse(body); msg = String(j?.error?.message ?? ''); code = String(j?.error?.code ?? ''); } catch { /* not JSON */ }
        if (res.status === 429) {
          const header = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(header) && header > 0 ? header * 1000 : parseDuration(msg.match(/try again in ([0-9hms.]+)/i)?.[1]);
          const daily = /per day|\(TPD\)|\(RPD\)/i.test(msg);
          const ms = this.capacity.rateLimited(wait, daily);
          throw new AIError('rate_limited', daily
            ? `The study assistant’s shared free allowance is used up for now. It should be back in about ${waitWords(ms)}. Your work is saved; practice, notes and reviews still work.`
            : `The study assistant is busy. Try again in about ${waitWords(ms)}. Your work is saved.`, ms, 'none_reported');
        }
        if (res.status === 413) throw new AIError('rejected', 'That task is too large for the study assistant’s free allowance. Use a shorter excerpt.', undefined, 'none_reported');
        if (res.status === 400 && code === 'json_validate_failed') return { text: '', model, stopReason: 'stop', requestId: res.headers.get('x-request-id'), usage: null }; // an unusable answer: the caller asks once more, politely
        if (res.status === 401 || res.status === 403) throw new AIError('not_configured', 'The AI provider rejected the API key.', undefined, 'none_reported');
        if (res.status >= 500) { this.capacity.serverError(); throw new AIError('unavailable', 'The AI service is temporarily unavailable. Your work is saved; try again in a minute.', 60_000, 'none_reported'); }
        throw new AIError('rejected', `The AI service rejected the request (${res.status}).`, undefined, 'none_reported');
      }
      let j: { id?: string; model?: string; choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      try { j = await res.json(); } catch { this.capacity.serverError(); throw new AIError('malformed', 'The AI service sent an unreadable response.', undefined, 'unknown'); }
      this.capacity.success();
      const c = j.choices?.[0];
      const u = j.usage;
      if (u && typeof u.prompt_tokens === 'number') actual = u.prompt_tokens + (u.completion_tokens ?? 0);
      // Returned (not thrown) even when empty/truncated so reported usage is preserved.
      return { text: c?.message?.content ?? '', model: j.model ?? model, stopReason: c?.finish_reason ?? null, requestId: res.headers.get('x-request-id') ?? j.id ?? null,
        usage: u && typeof u.prompt_tokens === 'number' ? { input: u.prompt_tokens, output: u.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 } : null };
    } catch (e) {
      if (e instanceof AIError) throw e;
      const f = classifyFetchFailure(e);
      if (f.code === 'unavailable') this.capacity.serverError(); // a slow answer (timeout) is not an outage: no cooldown for everyone
      throw new AIError(f.code, f.message, undefined, f.billing);
    } finally { clearTimeout(timer); slot.done(actual); }
  }
}
