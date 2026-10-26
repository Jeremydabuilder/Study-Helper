/**
 * Estimated provider cost. These are ESTIMATES from published list prices (USD per million tokens); the
 * provider's own billing is authoritative. Anthropic prices checked against
 * https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-26. Update here (or override with
 * AI_PRICE_IN_PER_MTOK / AI_PRICE_OUT_PER_MTOK) when prices change.
 */
export interface Price { inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number }
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export const PRICING_AS_OF = '2026-10-26';

interface Rule { match: RegExp; at: (promptTokens: number) => Price }
const flat = (inP: number, outP: number, readMult: number): Rule['at'] => () => ({ inPerM: inP, outPerM: outP, cacheReadPerM: inP * readMult, cacheWritePerM: inP * 1.25 });
const RULES: Rule[] = [
  { match: /^claude-fable-5/, at: flat(10, 50, 0.025) },
  { match: /^claude-opus-5-5/, at: flat(4, 20, 0.05) },
  { match: /^claude-sonnet-5-5/, at: flat(2, 10, 0.05) },
  // Haiku 5.5 is priced by prompt length: prompts over 100k tokens pay the higher rates.
  { match: /^claude-haiku-5-5/, at: (p) => (p > 100_000 ? { inPerM: 0.5, outPerM: 2.5, cacheReadPerM: 0.05, cacheWritePerM: 0.625 } : { inPerM: 0.1, outPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 }) },
];
/** Used when a model is not in the table (e.g. a Groq model): deliberately conservative, and flagged. */
const FALLBACK: Price = { inPerM: 2, outPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 2.5 };

export interface Override { inPerM?: number; outPerM?: number }

export function priceFor(model: string, promptTokens: number, ov: Override = {}): { price: Price; known: boolean } {
  if (ov.inPerM !== undefined && ov.outPerM !== undefined) return { price: { inPerM: ov.inPerM, outPerM: ov.outPerM, cacheReadPerM: ov.inPerM * 0.1, cacheWritePerM: ov.inPerM * 1.25 }, known: true };
  const r = RULES.find((x) => x.match.test(model));
  return r ? { price: r.at(promptTokens), known: true } : { price: FALLBACK, known: false };
}

export function estimateCost(model: string, u: Usage, ov: Override = {}): { usd: number; known: boolean } {
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const { price, known } = priceFor(model, prompt, ov);
  const usd = (u.inputTokens * price.inPerM + u.cacheReadTokens * price.cacheReadPerM + u.cacheWriteTokens * price.cacheWritePerM + u.outputTokens * price.outPerM) / 1e6;
  return { usd, known };
}

/** Worst case for one request before sending it: all output tokens used. ~3.5 chars/token is deliberately pessimistic for English. */
export function projectCost(model: string, inputChars: number, maxOutputTokens: number, ov: Override = {}): number {
  return estimateCost(model, { inputTokens: Math.ceil(inputChars / 3.5), outputTokens: maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, ov).usd;
}
