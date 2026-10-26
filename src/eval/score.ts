/** Pure scoring functions. Nothing here calls a model. */
import { checkMath } from '../core/mathCheck';
import { verifyMathSpec } from '../core/mathCheck';
import { tokens } from '../core/retrieval';
import { chunkText, verifyQuotes } from '../core/sources';
import type { ConceptExtraction, GeneratedQuestion, GradeResult } from '../ai/schemas';
import type { Band, ExtractionItem, GenerationItem, GradingItem, MathItem } from './dataset';

export const bandOf = (c: number): Band => (c >= 0.8 ? 'high' : c >= 0.35 ? 'mid' : 'low');

export interface GradeScore { id: string; category: string; ok: boolean; band: Band | null; correctness: number | null; confidence: string | null; abstained: boolean; falseCredit: boolean; falseReject: boolean; failed: string | null }
export function scoreGrade(item: GradingItem, r: GradeResult | null, failed: string | null = null): GradeScore {
  if (!r) return { id: item.id, category: item.category, ok: false, band: null, correctness: null, confidence: null, abstained: false, falseCredit: false, falseReject: false, failed };
  const band = bandOf(r.correctness);
  const accept = item.expected.acceptable;
  const okBand = accept.includes(band);
  const okConf = !item.expected.mustNotBeConfident || r.confidence !== 'high';
  return {
    id: item.id, category: item.category, ok: okBand && okConf, band, correctness: r.correctness, confidence: r.confidence, abstained: r.confidence === 'low',
    falseCredit: !accept.includes('high') && band === 'high', falseReject: accept.length === 1 && accept[0] === 'high' && band === 'low', failed: null,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export interface ExtractionScore { id: string; concepts: number; recall: number; quotes: number; verifiedQuotes: number; fidelity: number | null; forbiddenHit: boolean; skillTagAccuracy: number | null; failed: string | null }
export function scoreExtraction(item: ExtractionItem, out: ConceptExtraction | null, failed: string | null = null): ExtractionScore {
  if (!out) return { id: item.id, concepts: 0, recall: 0, quotes: 0, verifiedQuotes: 0, fidelity: null, forbiddenHit: false, skillTagAccuracy: null, failed };
  const chunks = chunkText(item.text);
  let q = 0, v = 0;
  for (const c of out.concepts) { const r = verifyQuotes(item.text, chunks, c.quotes); q += c.quotes.length; v += r.verified.length; }
  const names = out.concepts.map((c) => norm(c.name));
  const found = item.expectedConcepts.filter((e) => names.some((n) => n === norm(e) || n.includes(norm(e)) || norm(e).includes(n)));
  const hay = out.concepts.map((c) => norm(`${c.name} ${c.summary} ${c.quotes.join(' ')}`)).join(' | ');
  const tags = Object.entries(item.expectedSkillTags);
  const tagOk = tags.filter(([name, tag]) => out.concepts.some((c) => norm(c.name).includes(norm(name)) && c.skill_tag === tag)).length;
  return {
    id: item.id, concepts: out.concepts.length, recall: item.expectedConcepts.length ? found.length / item.expectedConcepts.length : 1, quotes: q, verifiedQuotes: v, fidelity: q ? v / q : null,
    forbiddenHit: item.forbiddenPatterns.some((p) => hay.includes(norm(p))), skillTagAccuracy: tags.length ? tagOk / tags.length : null, failed: null,
  };
}

export interface GenerationScore { id: string; questions: number; kinds: number; duplicates: number; sourceQuotes: number; verifiedSourceQuotes: number; mathKeyFailures: number; groundingProxy: number | null; failed: string | null; sheet: { id: string; kind: string; prompt: string }[] }
export function scoreGeneration(item: GenerationItem, qs: GeneratedQuestion[] | null, failed: string | null = null): GenerationScore {
  if (!qs) return { id: item.id, questions: 0, kinds: 0, duplicates: 0, sourceQuotes: 0, verifiedSourceQuotes: 0, mathKeyFailures: 0, groundingProxy: null, failed, sheet: [] };
  const src = item.excerpts.map((e) => e.text).join('\n');
  let sq = 0, sv = 0, mk = 0;
  for (const q of qs) {
    if (q.source_quote) { sq++; if (verifyQuotes(src, [], [q.source_quote]).verified.length) sv++; }
    if (q.kind === 'math' && q.answer && q.relation && verifyMathSpec({ type: 'math_set', answer: q.answer, relation: q.relation, variable: 'x' }).verified === false) mk++;
  }
  const bag = new Set(tokens(`${src} ${item.concept.name} ${item.concept.summary}`));
  const open = qs.filter((q) => q.kind !== 'math');
  const proxy = open.length ? open.reduce((a, q) => { const t = tokens(q.prompt).filter((w) => w.length > 3); return a + (t.length ? t.filter((w) => bag.has(w)).length / t.length : 0); }, 0) / open.length : null;
  return {
    id: item.id, questions: qs.length, kinds: new Set(qs.map((q) => q.kind)).size, duplicates: qs.length - new Set(qs.map((q) => norm(q.prompt))).size, sourceQuotes: sq, verifiedSourceQuotes: sv,
    mathKeyFailures: mk, groundingProxy: proxy, failed: null, sheet: qs.map((q, i) => ({ id: `${item.id}#${i + 1}`, kind: q.kind, prompt: q.prompt })),
  };
}

export interface MathScore { id: string; category: string; ok: boolean; got: string; tagOk: boolean }
export function scoreMath(item: MathItem): MathScore {
  const r = checkMath(item.spec, item.student);
  const tagOk = !item.tags || item.tags.every((t) => (r.tags as string[]).includes(t));
  return { id: item.id, category: item.category, ok: r.verdict === item.expected && tagOk, got: r.verdict, tagOk };
}

export const pct = (a: number, b: number) => (b === 0 ? null : a / b);
export function percentile(xs: number[], p: number): number | null { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
