import { ChatGPTConnection } from '../server/personal/chatgpt';
import { AIError } from './provider';
import { LLMRequest, LLMResponse, LLMTransport, classifyFetchFailure } from './llm';

/** Uses only the explicitly authorized personal plan. Never falls back to an
 * API key, Groq, browser cookies, or ChatGPT's private backend endpoints. */
export class ChatGPTTransport implements LLMTransport {
  readonly provider = 'chatgpt';
  constructor(private connection: ChatGPTConnection, private fetchImpl: typeof fetch = fetch) {}
  get defaultModel() { return this.connection.model ?? ''; }
  get credentialFingerprint() { return this.connection.fingerprint; }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    try { return await this.send(req); } catch (e) {
      if (e instanceof AIError) throw e;
      const failure = classifyFetchFailure(e);
      throw new AIError(failure.code, failure.message, undefined, failure.billing);
    }
  }
  private async send(req: LLMRequest): Promise<LLMResponse> {
    if (req.attachments?.length) throw new AIError('rejected', 'Personal ChatGPT photo reading is not enabled here. Paste text instead.', undefined, 'not_sent');
    const model = this.connection.model;
    if (!model || req.model !== model) throw new AIError('not_configured', 'Choose your ChatGPT model in Settings first.', undefined, 'not_sent');
    const token = await this.connection.accessToken();
    const res = await this.fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // Plan usage explicitly forbids max_output_tokens, temperature, previous_response_id and system input items.
      body: JSON.stringify({ model, instructions: req.system, input: [{ role: 'user', content: req.user }], store: false, stream: true }),
      signal: AbortSignal.timeout(req.timeoutMs), redirect: 'error',
    });
    if (!res.ok) throw responseError(res.status);
    if (!res.body) throw new AIError('malformed', 'ChatGPT returned no response stream.', undefined, 'unknown');
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let pending = '', bytes = 0, completed: any = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw new AIError('malformed', 'The ChatGPT answer was too large. Try a shorter task.', undefined, 'unknown');
        pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let end: number;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, end); pending = pending.slice(end + 2);
          const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          let event: any; try { event = JSON.parse(data); } catch { throw new AIError('malformed', 'ChatGPT returned an unreadable stream.', undefined, 'unknown'); }
          if (event.type === 'response.failed' || event.type === 'error') throw streamError(event.response?.error?.code ?? event.code);
          if (event.type === 'response.incomplete') throw new AIError('malformed', 'ChatGPT did not finish the answer. Your work is saved; try again.', undefined, 'unknown');
          if (event.type === 'response.completed') completed = event.response;
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!completed || completed.status !== 'completed') throw new AIError('malformed', 'The ChatGPT connection ended before the answer completed. Your work is saved.', undefined, 'unknown');
    const text = (completed.output ?? []).filter((o: any) => o.type === 'message').flatMap((o: any) => o.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
    const usage = completed.usage;
    return { text, model: completed.model ?? model, stopReason: 'end_turn', requestId: completed.id ?? null, usage: usage ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: 0, cacheWrite: 0 } : null };
  }
}
function responseError(status: number) {
  return status === 429 ? streamError('subscription_sharing_usage_limit_exceeded') : status === 401 || status === 403 ? new AIError('not_configured', 'Reconnect your ChatGPT account in Settings. No other account or provider was used.', undefined, 'none_reported') : new AIError('unavailable', 'ChatGPT is unavailable right now. Your work is saved; try later.', undefined, 'none_reported');
}
function streamError(code: string) {
  return new AIError(code === 'subscription_sharing_usage_limit_exceeded' ? 'limit_reached' : 'unavailable', code === 'subscription_sharing_usage_limit_exceeded' || code === 'subscription_sharing_usage_unavailable' ? 'ChatGPT plan usage is unavailable or has reached its limit. Use Manage usage in Settings. Your saved work is still available.' : 'ChatGPT could not complete the answer. Your saved work is still available.', undefined, 'unknown');
}
