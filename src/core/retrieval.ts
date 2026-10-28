import { isOnlyMarkers } from './sources';
/** Relevant-context retrieval: each AI call gets a small, ranked slice of memory — never the whole history. */
const STOP = new Set('a an the of and or to in on for with is are was were be by as at it this that from which what how why do does your you i'.split(' '));
export const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));

export interface Scored<T> { item: T; score: number }

/** BM25-lite ranking. Deterministic, no embeddings, no provider. */
export function rank<T>(query: string, docs: T[], text: (d: T) => string, k = 4): Scored<T>[] {
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  const toks = docs.map((d) => tokens(text(d)));
  const avg = toks.reduce((s, t) => s + t.length, 0) / Math.max(1, toks.length) || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  const scored = docs.map((item, i) => {
    const tf = new Map<string, number>();
    for (const w of toks[i]) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of q) {
      const f = tf.get(w); if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
      score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (toks[i].length / avg))));
    }
    return { item, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

export interface MemoryLite { id: string; kind: 'student_stated' | 'observed' | 'ai_inferred'; text: string; subjectId: string | null; conceptId: string | null }
export interface ContextInput {
  concept: { id: string; name: string; summary: string; subjectId: string };
  chunks: { id: string; label: string; text: string }[];
  refChunkIds: string[];
  memories: MemoryLite[];
  misconceptions: { description: string; count: number }[];
  maxChars?: number;
}
export interface BuiltContext {
  sourceExcerpts: { id: string; label: string; text: string }[];
  memories: string[];
  misconceptions: string[];
  chars: number;
}

export function buildContext(inp: ContextInput): BuiltContext {
  const budget = inp.maxChars ?? 5000;
  const linked = inp.chunks.filter((c) => inp.refChunkIds.includes(c.id));
  const rest = inp.chunks.filter((c) => !inp.refChunkIds.includes(c.id));
  const extra = rank(`${inp.concept.name} ${inp.concept.summary}`, rest, (c) => c.text, 2).map((s) => s.item);
  const excerpts: BuiltContext['sourceExcerpts'] = [];
  let chars = 0;
  for (const c of [...linked.slice(0, 3), ...extra]) {
    const clean = c.text; // callers pass the model-facing view (excluded passages already masked)
    if (!clean.trim() || isOnlyMarkers(clean)) continue;
    const t = clean.length > 1200 ? clean.slice(0, 1200) : clean;
    if (chars + t.length > budget) break;
    excerpts.push({ id: c.id, label: c.label, text: t }); chars += t.length;
  }
  const mems = inp.memories
    .filter((m) => m.conceptId === inp.concept.id || (m.conceptId === null && (m.subjectId === null || m.subjectId === inp.concept.subjectId) && m.kind === 'student_stated'))
    .slice(0, 4).map((m) => `[${m.kind}] ${m.text.slice(0, 200)}`);
  const mis = inp.misconceptions.slice(0, 3).map((m) => `${m.description.slice(0, 200)} (seen ${m.count}×)`);
  chars += mems.join('').length + mis.join('').length;
  return { sourceExcerpts: excerpts, memories: mems, misconceptions: mis, chars };
}
