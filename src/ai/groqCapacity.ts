import { AIError } from './provider';

/**
 * Shared capacity guard for ONE Groq key. Groq's limits belong to the whole organisation (not to a student, not to an API key), so every student's
 * request competes for the same small allowance. This guard keeps the app from burning it on retries:
 *  - requests per minute and tokens per minute are paced locally, so a burst waits briefly instead of being refused by Groq
 *  - after a refusal (429) or a server error nothing is sent until the cooldown has passed, however many students click "retry"
 *  - a request that would have to wait too long is refused at once, with an honest "try again in about …"
 * It is process-local on purpose: the app runs exactly one instance. It is a courtesy to the provider and to the students, not an accounting system:
 * the provider's own response is always the final word, and mocked tests of it prove the rules, not any capacity.
 */
export interface CapacityOptions {
  rpm: number; tpm: number; maxConcurrent: number; maxWaitMs: number;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
}
export const DEFAULT_CAPACITY: CapacityOptions = { rpm: 24, tpm: 6000, maxConcurrent: 2, maxWaitMs: 10_000 };

/** "7m12s", "2m59.56s", "250ms", "1h2m3s" → milliseconds. null when unreadable. */
export function parseDuration(s: string | null | undefined): number | null {
  if (!s) return null;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g; let total = 0, any = false, m: RegExpExecArray | null;
  while ((m = re.exec(s.trim()))) { any = true; const n = Number(m[1]); total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000; }
  return any ? Math.ceil(total) : null;
}
/** Plain wording for a wait: "about 40 seconds", "about 12 minutes", "about 3 hours". */
export function waitWords(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 90) return `${s <= 5 ? 5 : Math.ceil(s / 5) * 5} seconds`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `${m} minutes`;
  return `${Math.ceil(m / 60)} hours`;
}
const MAX_COOLDOWN_MS = 6 * 3_600_000;

export class GroqCapacity {
  private o: CapacityOptions;
  private now: () => number; private sleep: (ms: number) => Promise<void>;
  private cooldownUntil = 0; private cooldownDaily = false; private strikes = 0;
  private starts: number[] = []; private tokens: { t: number; n: number; id: number }[] = [];
  private running = 0; private lock: Promise<void> = Promise.resolve(); private seq = 0;
  constructor(o: Partial<CapacityOptions> = {}) {
    this.o = { ...DEFAULT_CAPACITY, ...o };
    this.now = this.o.now ?? Date.now; this.sleep = this.o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  snapshot() {
    const wait = Math.max(0, this.cooldownUntil - this.now());
    return { cooling: wait > 0, waitMs: wait, daily: wait > 0 && this.cooldownDaily, running: this.running, recentRequests: this.recent(this.starts.map((t) => ({ t }))).length };
  }
  private recent<T extends { t: number }>(a: T[]): T[] { const cut = this.now() - 60_000; return a.filter((x) => x.t > cut); }

  private refuseCooling(): never {
    const wait = Math.max(1000, this.cooldownUntil - this.now());
    throw new AIError('rate_limited', this.cooldownDaily
      ? `The study assistant’s shared free allowance is used up for now. It should be back in about ${waitWords(wait)}. Your work is saved; practice, notes and reviews still work.`
      : `The study assistant is catching its breath because many requests arrived at once. Try again in about ${waitWords(wait)}. Your work is saved.`, wait, 'not_sent');
  }

  /**
   * Take a place or refuse. Callers wait in order (first come, first served) for at most `maxWaitMs`. `estTokens` is an estimate of input + output.
   * The returned `done(actualTokens)` must be called exactly once when the request ends, whatever the outcome.
   */
  async acquire(estTokens: number): Promise<{ done(actualTokens?: number | null): void }> {
    if (estTokens > this.o.tpm) throw new AIError('rejected', 'That task is too large for the study assistant’s per-minute allowance. Use a shorter excerpt. Nothing was sent.', undefined, 'not_sent');
    const entered = this.now();
    const turn = this.lock; let release!: () => void;
    this.lock = new Promise<void>((r) => (release = r));
    try {
      await turn;
      for (;;) {
        const t = this.now();
        if (t - entered > this.o.maxWaitMs) throw new AIError('rate_limited', 'The study assistant is busy with other requests. Try again in about 10 seconds. Your work is saved.', 10_000, 'not_sent');
        if (this.cooldownUntil > t) this.refuseCooling();
        this.starts = this.recent(this.starts.map((x) => ({ t: x }))).map((x) => x.t);
        this.tokens = this.recent(this.tokens);
        let wait = 0;
        if (this.running >= this.o.maxConcurrent) wait = 250;
        if (this.starts.length >= this.o.rpm) wait = Math.max(wait, this.starts[0] + 60_000 - t + 25);
        const used = this.tokens.reduce((a, x) => a + x.n, 0);
        if (used + estTokens > this.o.tpm) { let free = used; for (const x of this.tokens) { free -= x.n; if (free + estTokens <= this.o.tpm) { wait = Math.max(wait, x.t + 60_000 - t + 25); break; } } }
        if (wait <= 0) break;
        if (t - entered + wait > this.o.maxWaitMs && wait > 1000) throw new AIError('rate_limited', `The study assistant is at its per-minute limit. Try again in about ${waitWords(wait)}. Your work is saved.`, wait, 'not_sent');
        await this.sleep(Math.min(wait, 1000));
      }
      const id = ++this.seq, t = this.now();
      this.running++; this.starts.push(t); this.tokens.push({ t, n: estTokens, id });
      let finished = false;
      return { done: (actual) => { if (finished) return; finished = true; this.running--; if (typeof actual === 'number' && actual >= 0) { const e = this.tokens.find((x) => x.id === id); if (e) e.n = actual; } } };
    } finally { release(); }
  }

  /** Rate headers on every response: stop early when the provider says nothing is left, before it has to refuse us. */
  noteHeaders(h: { get(name: string): string | null }) {
    const num = (k: string) => { const v = h.get(k); const n = v === null ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
    const remReq = num('x-ratelimit-remaining-requests'), remTok = num('x-ratelimit-remaining-tokens');
    if (remReq !== null && remReq <= 0) this.cool(parseDuration(h.get('x-ratelimit-reset-requests')) ?? 5000, false, false);
    else if (remTok !== null && remTok <= 200) this.cool(Math.min(parseDuration(h.get('x-ratelimit-reset-tokens')) ?? 5000, 60_000), false, false);
  }
  /** A refusal (429): remember it for everyone. `retryAfterMs` comes from the provider when it says; otherwise back off 10 s, doubling up to 2 minutes (a long daily wait is kept as given). */
  rateLimited(retryAfterMs: number | null, daily: boolean): number {
    this.strikes++;
    const wait = Math.min(MAX_COOLDOWN_MS, Math.max(1000, retryAfterMs ?? Math.min(120_000, 10_000 * 2 ** (this.strikes - 1))));
    this.cool(wait, daily, true);
    return wait;
  }
  /** A provider outage (5xx) or an unreadable answer: pause briefly instead of sending the next student's request into the same failure. */
  serverError() { this.strikes++; const wait = Math.min(60_000, 5000 * 2 ** Math.min(this.strikes - 1, 4)); this.cool(wait, false, true); return wait; }
  success() { this.strikes = 0; }
  private cool(ms: number, daily: boolean, _force: boolean) {
    const until = this.now() + ms;
    if (until > this.cooldownUntil) { this.cooldownUntil = until; this.cooldownDaily = daily; }
    else if (daily) this.cooldownDaily = true;
  }
}

/** The one capacity guard of this process (the app runs a single provider). Hosted code reads it to tell students honestly why the assistant is waiting. */
let active: GroqCapacity | null = null;
export const setActiveCapacity = (c: GroqCapacity | null) => { active = c; };
export const activeCapacity = () => active;
