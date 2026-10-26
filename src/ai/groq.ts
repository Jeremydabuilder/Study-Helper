/**
 * Optional, opt-in Groq transport (OpenAI-compatible chat completions). Only constructed when the operator sets
 * AI_PROVIDER=groq with GROQ_API_KEY and GROQ_MODEL. There is no default model: the official Groq model list was
 * not reachable when this was written, so no model ID is asserted here. NOT verified against the live API.
 */
import { AIError } from './provider';
import { LLMRequest, LLMResponse, LLMTransport } from './llm';

export class GroqTransport implements LLMTransport {
  readonly provider = 'groq';
  constructor(private apiKey: string, public readonly defaultModel: string, private fetchImpl: typeof fetch = fetch) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
    const model = req.model || this.defaultModel;
    try {
      const res = await this.fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model, max_completion_tokens: req.maxTokens, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }] }),
      });
      if (res.status === 429) { const ra = Number(res.headers.get('retry-after')); throw new AIError('rate_limited', 'The AI service is busy (rate limited). Try again in a moment.', Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15_000); }
      if (res.status === 401 || res.status === 403) throw new AIError('not_configured', 'The AI provider rejected the API key.');
      if (res.status >= 500) throw new AIError('unavailable', 'The AI service is temporarily unavailable.');
      if (!res.ok) throw new AIError('rejected', `The AI service rejected the request (${res.status}).`);
      const j = (await res.json()) as { id?: string; model?: string; choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const c = j.choices?.[0];
      const text = c?.message?.content ?? '';
      if (!text && !req.allowEmpty && c?.finish_reason !== 'length') throw new AIError('malformed', 'The AI service returned an empty response.');
      const u = j.usage;
      return { text, model: j.model ?? model, stopReason: c?.finish_reason ?? null, requestId: res.headers.get('x-request-id') ?? j.id ?? null,
        usage: u && typeof u.prompt_tokens === 'number' ? { input: u.prompt_tokens, output: u.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 } : null };
    } catch (e) {
      if (e instanceof AIError) throw e;
      if (e instanceof Error && e.name === 'AbortError') throw new AIError('timeout', 'The AI request timed out.');
      throw new AIError('unavailable', 'Could not reach the AI service.');
    } finally { clearTimeout(timer); }
  }
}
