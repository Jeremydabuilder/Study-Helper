/** Time helpers. All core logic takes explicit `now`/`tz` so behaviour is testable and DST-safe. */
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export interface LocalParts { y: number; m: number; d: number; h: number; mi: number; dow: number }

export function localParts(date: Date, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(date)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute, dow };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD of the instant in the given zone. */
export function localDateKey(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function addDaysKey(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function dowOfKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function diffDaysKeys(a: string, b: string): number {
  const f = (k: string) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((f(b) - f(a)) / DAY);
}

function offsetMs(utcMs: number, tz: string): number {
  const p = localParts(new Date(utcMs), tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, 0);
  return asUtc - Math.floor(utcMs / MIN) * MIN;
}

/**
 * Wall-clock time in `tz` -> instant.
 * - Non-existent time (spring-forward gap, e.g. 02:30 on 2026-03-08 in New York) resolves FORWARD (03:30).
 * - Ambiguous time (fall-back repeat, e.g. 01:30 on 2026-11-01) resolves to the FIRST occurrence.
 */
export function zonedToUtc(dateKey: string, hhmm: string, tz: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi, 0);
  // offsets on either side of any transition near this wall-clock time
  const before = guess - offsetMs(guess - 12 * HOUR, tz), after = guess - offsetMs(guess + 12 * HOUR, tz);
  const matches = (utc: number) => { const p = localParts(new Date(utc), tz); return p.y === y && p.m === m && p.d === d && p.h === h && p.mi === mi; };
  const valid = [before, after].filter(matches).sort((a, b) => a - b);
  return new Date(valid.length ? valid[0] : Math.max(before, after)); // in a gap neither matches: the later instant is the "forward" one
}

/** [start, end) of a local calendar day; 23h/25h on DST days. */
export function dayBounds(key: string, tz: string): { start: Date; end: Date } {
  return { start: zonedToUtc(key, '00:00', tz), end: zonedToUtc(addDaysKey(key, 1), '00:00', tz) };
}

export function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
