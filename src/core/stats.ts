/** Wilson score interval: honest uncertainty for small samples (no "you will get 95%"). */
export function wilson(k: number, n: number, z = 1.96): { rate: number | null; low: number | null; high: number | null; n: number } {
  if (n === 0) return { rate: null, low: null, high: null, n };
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { rate: p, low: Math.max(0, c - m), high: Math.min(1, c + m), n };
}
