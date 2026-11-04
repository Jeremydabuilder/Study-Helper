/** The visitor-key transport itself, with a stand-in for the network: nothing here contacts Groq. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AIError } from '../src/ai/provider';
import { BYOK_DEFAULT_MODEL, ByokTransport, GROQ_CHAT_URL, KEY_PATTERN, MODEL_PATTERN, pingGroq } from '../src/ai/byok';
import { LLMProvider } from '../src/ai/llm';
import { FakeGroq, VISITOR_KEY } from './hostedHarness';

describe('Groq key test ("Test connection")', () => {
  it('makes one small real request to the fixed address, with the key only as a Bearer header, and refuses redirects', async () => {
    const g = new FakeGroq(); const r = await pingGroq(VISITOR_KEY, BYOK_DEFAULT_MODEL, g.fetch);
    expect(r).toMatchObject({ ok: true, kind: 'ok' });
    expect(g.calls).toHaveLength(1);
    const c = g.calls[0]; expect(c.url).toBe(GROQ_CHAT_URL); expect(c.url).toBe('https://api.groq.com/openai/v1/chat/completions'); expect(c.redirect).toBe('error');
    expect(c.key).toBe(VISITOR_KEY); expect(JSON.stringify(c.body)).not.toContain(VISITOR_KEY); expect(c.body.max_completion_tokens).toBeLessThanOrEqual(16); expect(c.body.model).toBe(BYOK_DEFAULT_MODEL);
    expect(Object.keys(c.headers).sort()).toEqual(['authorization', 'content-type']);
  });
  it.each([
    ['invalid_key', 'invalid_key'], ['forbidden', 'forbidden'], ['model', 'model_unavailable'], ['rate', 'rate_limited'], ['server', 'service'], ['network', 'network'],
  ] as const)('reports %s clearly, without echoing anything from Groq’s reply or the key', async (mode, kind) => {
    const g = new FakeGroq(); g.mode = mode; const r = await pingGroq(VISITOR_KEY, 'some/model', g.fetch);
    expect(r).toMatchObject({ ok: false, kind }); expect(r.message.length).toBeGreaterThan(20);
    expect(JSON.stringify(r)).not.toContain(VISITOR_KEY); expect(JSON.stringify(r)).not.toContain('sk-should-never-be-echoed'); expect(r.message).not.toContain('does not exist');
    if (mode === 'rate') expect(r.retryAfterMs).toBe(7000);
  });
  it('times out instead of waiting forever, and a wrong key is an invalid key (not a network problem)', async () => {
    const g = new FakeGroq(); g.mode = 'hang'; const t0 = Date.now(); const r = await pingGroq(VISITOR_KEY, 'm/m', g.fetch, 80);
    expect(r).toMatchObject({ ok: false, kind: 'timeout' }); expect(Date.now() - t0).toBeLessThan(2000);
    const wrong = await pingGroq('gsk_' + 'x'.repeat(40), 'm/m', new FakeGroq().fetch); expect(wrong.kind).toBe('invalid_key');
  });
  it('a redirect is never followed with the key', async () => {
    const g = new FakeGroq(); g.mode = 'redirect'; const r = await pingGroq(VISITOR_KEY, 'm/m', g.fetch); expect(r).toMatchObject({ ok: false, kind: 'network' });
  });
});

describe('request transport', () => {
  const Out = z.object({ hint: z.string() });
  const run = (g: FakeGroq, key = VISITOR_KEY) => new LLMProvider(new ByokTransport(key, BYOK_DEFAULT_MODEL, g.fetch), { timeoutMs: 500 }).json('generate', 'p', Out, 'PUBLIC_TASK: hint\nx', {}, 'sys');
  it('returns the answer, uses the fixed address and the chosen model, and holds no state between visitors', async () => {
    const g = new FakeGroq(); const a = await run(g); expect(a.hint).toMatch(/own key/);
    expect(g.calls.every((c) => c.url === GROQ_CHAT_URL && c.key === VISITOR_KEY)).toBe(true);
    const other = 'gsk_' + 'Other1234567890'.repeat(3); g.valid.add(other); await run(g, other);
    expect(g.calls.at(-1)!.key).toBe(other); expect(g.calls.filter((c) => c.key === VISITOR_KEY)).toHaveLength(1);       // a second visitor's key never rides on the first's
  });
  it('maps failures to errors that never contain the key', async () => {
    for (const [mode, code] of [['invalid_key', 'not_configured'], ['forbidden', 'not_configured'], ['model', 'rejected'], ['rate', 'rate_limited'], ['server', 'unavailable'], ['network', 'unavailable']] as const) {
      const g = new FakeGroq(); g.mode = mode; const e = await run(g).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(AIError); expect(e.code).toBe(code); expect(e.message).not.toContain(VISITOR_KEY); expect(e.message).not.toContain('sk-should-never-be-echoed'); expect(String(e.stack)).not.toContain(VISITOR_KEY);
    }
  });
  it('key and model shapes are validated', () => {
    expect(KEY_PATTERN.test(VISITOR_KEY)).toBe(true);
    for (const bad of ['', 'short', 'gsk_ has space ' + 'x'.repeat(30), 'gsk_' + 'x'.repeat(30) + '\r\nX-Evil: 1', 'a'.repeat(300)]) expect(KEY_PATTERN.test(bad)).toBe(false);
    expect(MODEL_PATTERN.test('openai/gpt-oss-120b')).toBe(true); expect(MODEL_PATTERN.test('llama-3.3-70b-versatile')).toBe(true);
    for (const bad of ['', '../x', 'a b', 'x'.repeat(100), 'm\nx']) expect(MODEL_PATTERN.test(bad)).toBe(false);
  });
});
