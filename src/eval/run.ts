import { AIError, AIProvider, AITask, CallOpts } from '../ai/provider';
import { MemoryLedger } from '../ai/ledger';
import { chunkText } from '../core/sources';
import { Dataset, loadDataset, reviewStatus } from './dataset';
import { GenerationScore, GradeScore, ExtractionScore, MathScore, percentile, pct, scoreExtraction, scoreGeneration, scoreGrade, scoreMath } from './score';

export interface RunOptions {
  provider: AIProvider; label: string; dataset?: Dataset;
  only?: ('math' | 'extraction' | 'grading' | 'generation')[]; ids?: string[]; limit?: number;
  budgetUsd?: number; priceOverride?: { inPerM?: number; outPerM?: number };
  now?: () => number;
}

export interface UsageSummary {
  requests: number; billableRequests: number; repairRetries: number; invalidOutputs: number; truncated: number; errors: number;
  inputTokens: number; outputTokens: number; estUsd: number; unknownPrice: boolean; usageEstimated: boolean;
  latencyMs: { p50: number | null; p95: number | null }; byTask: Record<string, { requests: number; estUsd: number; p50: number | null }>;
}
export interface Report {
  label: string; startedAt: string; models: Record<string, string | null>; live: boolean;
  items: { total: number; approved: number; note: string };
  stoppedEarly: { reason: string; completed: number; planned: number } | null;
  math: { n: number; accuracy: number | null; failures: string[]; byCategory: Record<string, [number, number]> } | null;
  grading: { n: number; agreement: number | null; agreementWhenConfident: number | null; abstainRate: number | null; falseCreditRate: number | null; falseRejectRate: number | null; mistakeKindAgreement: { n: number; agree: number } | null; failed: number; byCategory: Record<string, [number, number]>; misses: { id: string; expected: string; got: string; confidence: string | null }[] } | null;
  extraction: { n: number; recall: number | null; sourceFidelity: number | null; injectionObeyed: number; skillTagAccuracy: number | null; failed: number; perItem: ExtractionScore[] } | null;
  generation: { n: number; questions: number; distinctKinds: number | null; duplicates: number; sourceQuoteFidelity: number | null; mathKeyFailures: number; groundingProxy: number | null; failed: number; usefulness: string; reviewSheet: { id: string; kind: string; prompt: string }[] } | null;
  schemaFailureRate: number | null;
  usage: UsageSummary;
  caveats: string[];
}

/** Collects every request through the same reservation ledger the app uses, so the budget guard holds here too. */
export function makeCollector(o: { budgetUsd?: number; priceOverride?: { inPerM?: number; outPerM?: number } }) {
  const ledger = new MemoryLedger({ budgetUsd: o.budgetUsd, priceOverride: o.priceOverride });
  const opts = (): CallOpts => ({ ledger });
  return { ledger, get recs() { return ledger.rows; }, opts, get spent() { return ledger.spentUsd; } };
}

const cat = <T extends { category: string; ok: boolean }>(xs: T[]) => { const m: Record<string, [number, number]> = {}; for (const x of xs) { const e = (m[x.category] ??= [0, 0]); e[1]++; if (x.ok) e[0]++; } return m; };

export async function runEval(o: RunOptions): Promise<Report> {
  const d = o.dataset ?? loadDataset();
  const only = new Set(o.only ?? ['math', 'extraction', 'grading', 'generation']);
  const keep = <T extends { id: string }>(xs: T[]) => { let r = o.ids ? xs.filter((x) => o.ids!.includes(x.id)) : xs; if (o.limit) r = r.slice(0, o.limit); return r; };
  const col = makeCollector({ budgetUsd: o.budgetUsd, priceOverride: o.priceOverride });
  const planned = (only.has('extraction') ? keep(d.extraction).length : 0) + (only.has('grading') ? keep(d.grading).length : 0) + (only.has('generation') ? keep(d.generation).length : 0);
  let completed = 0, stopped: Report['stoppedEarly'] = null;
  const guard = async <T>(fn: () => Promise<T>): Promise<{ v: T | null; err: string | null; stop: boolean }> => {
    try { return { v: await fn(), err: null, stop: false }; }
    catch (e) {
      if (e instanceof AIError && (e.code === 'budget_reached' || e.code === 'limit_reached')) { stopped ??= { reason: e.message, completed, planned }; return { v: null, err: e.code, stop: true }; }
      return { v: null, err: e instanceof AIError ? e.code : e instanceof Error ? e.message : 'error', stop: false };
    }
  };
  const report: Report = {
    label: o.label, startedAt: new Date((o.now ?? Date.now)()).toISOString(), live: o.provider.live,
    models: { extract: o.provider.modelFor?.('extract') ?? null, generate: o.provider.modelFor?.('generate') ?? null, grade: o.provider.modelFor?.('grade') ?? null },
    items: { ...reviewStatus(d), note: '' }, stoppedEarly: null, math: null, grading: null, extraction: null, generation: null, schemaFailureRate: null,
    usage: undefined as never, caveats: [],
  };

  if (only.has('math')) {
    const sc: MathScore[] = keep(d.math).map(scoreMath);
    report.math = { n: sc.length, accuracy: pct(sc.filter((s) => s.ok).length, sc.length), failures: sc.filter((s) => !s.ok).map((s) => `${s.id}: got ${s.got}`), byCategory: cat(sc) };
  }
  if (only.has('extraction')) {
    const sc: ExtractionScore[] = [];
    for (const it of keep(d.extraction)) {
      if (stopped) break;
      const r = await guard(() => o.provider.extractConcepts({ subjectName: it.subject, chunks: chunkText(it.text).map((c) => ({ id: String(c.idx), label: c.label, text: c.text })), maxConcepts: 12 }, col.opts()));
      if (!r.stop) { sc.push(scoreExtraction(it, r.v, r.err)); completed++; }
    }
    const ok = sc.filter((s) => !s.failed);
    const q = ok.reduce((a, s) => a + s.quotes, 0), v = ok.reduce((a, s) => a + s.verifiedQuotes, 0);
    const tags = ok.filter((s) => s.skillTagAccuracy !== null);
    report.extraction = { n: sc.length, recall: ok.length ? ok.reduce((a, s) => a + s.recall, 0) / ok.length : null, sourceFidelity: q ? v / q : null, injectionObeyed: ok.filter((s) => s.forbiddenHit).length,
      skillTagAccuracy: tags.length ? tags.reduce((a, s) => a + (s.skillTagAccuracy ?? 0), 0) / tags.length : null, failed: sc.filter((s) => s.failed).length, perItem: sc };
  }
  if (only.has('grading')) {
    const sc: GradeScore[] = [];
    for (const it of keep(d.grading)) {
      if (stopped) break;
      const r = await guard(() => o.provider.gradeAnswer({ question: { prompt: it.question, kind: 'explain', rubric: it.rubric, sampleAnswer: it.sampleAnswer ?? undefined }, answer: it.answer, reasoning: it.reasoning, excerpts: it.excerpts }, col.opts()));
      if (!r.stop) { sc.push(scoreGrade(it, r.v, r.err)); completed++; }
    }
    const ok = sc.filter((s) => !s.failed), conf = ok.filter((s) => !s.abstained);
    report.grading = {
      n: sc.length, agreement: pct(ok.filter((s) => s.ok).length, sc.length), agreementWhenConfident: pct(conf.filter((s) => s.ok).length, conf.length), abstainRate: pct(ok.filter((s) => s.abstained).length, ok.length),
      mistakeKindAgreement: (() => { const m = ok.filter((s) => s.mistakeExpected && s.mistakeGot !== undefined && s.mistakeGot !== null); return m.length ? { n: m.length, agree: m.filter((s) => s.mistakeExpected === s.mistakeGot).length } : null; })(),
      falseCreditRate: pct(ok.filter((s) => s.falseCredit).length, ok.length), falseRejectRate: pct(ok.filter((s) => s.falseReject).length, ok.length), failed: sc.filter((s) => s.failed).length, byCategory: cat(sc),
      misses: sc.filter((s) => !s.ok).map((s) => ({ id: s.id, expected: d.grading.find((g) => g.id === s.id)!.expected.acceptable.join('/'), got: s.failed ? `FAILED(${s.failed})` : `${s.band}@${s.correctness?.toFixed(2)}`, confidence: s.confidence })),
    };
  }
  if (only.has('generation')) {
    const sc: GenerationScore[] = [];
    for (const it of keep(d.generation)) {
      if (stopped) break;
      const r = await guard(() => o.provider.generateQuestions({ subjectName: it.subject, concept: it.concept, excerpts: it.excerpts, otherConcepts: it.otherConcepts, misconceptions: [], studentNotes: [], practice: it.practice, heldout: it.heldout, avoidPrompts: [], seed: 1 }, col.opts()));
      if (!r.stop) { sc.push(scoreGeneration(it, r.v?.questions ?? null, r.err)); completed++; }
    }
    const ok = sc.filter((s) => !s.failed);
    const sq = ok.reduce((a, s) => a + s.sourceQuotes, 0), sv = ok.reduce((a, s) => a + s.verifiedSourceQuotes, 0);
    const gp = ok.filter((s) => s.groundingProxy !== null);
    report.generation = { n: sc.length, questions: ok.reduce((a, s) => a + s.questions, 0), distinctKinds: ok.length ? ok.reduce((a, s) => a + s.kinds, 0) / ok.length : null, duplicates: ok.reduce((a, s) => a + s.duplicates, 0),
      sourceQuoteFidelity: sq ? sv / sq : null, mathKeyFailures: ok.reduce((a, s) => a + s.mathKeyFailures, 0), groundingProxy: gp.length ? gp.reduce((a, s) => a + (s.groundingProxy ?? 0), 0) / gp.length : null, failed: sc.filter((s) => s.failed).length,
      usefulness: 'NOT MEASURED automatically: rate each question in the review sheet (1–5). The grounding proxy is only lexical overlap with the source.', reviewSheet: ok.flatMap((s) => s.sheet) };
  }

  report.stoppedEarly = stopped;
  const recs = col.recs, billed = recs.filter((r) => r.billing === 'reported' || r.billing === 'estimated' || r.billing === 'unknown'), lat = recs.filter((r) => r.outcome === 'ok').map((r) => r.latencyMs);
  const byTask: UsageSummary['byTask'] = {};
  for (const t of ['extract', 'generate', 'grade'] as AITask[]) { const rs = recs.filter((r) => r.purpose === t); if (rs.length) byTask[t] = { requests: rs.length, estUsd: rs.reduce((a, r) => a + r.usd, 0), p50: percentile(rs.filter((r) => r.outcome === 'ok').map((r) => r.latencyMs), 0.5) }; }
  report.usage = {
    requests: recs.length, billableRequests: billed.length, repairRetries: recs.filter((r) => r.attempt > 1).length, invalidOutputs: recs.filter((r) => r.outcome === 'invalid_output').length, truncated: recs.filter((r) => r.outcome === 'truncated').length,
    errors: recs.filter((r) => !['ok', 'invalid_output', 'truncated', 'empty', 'refused'].includes(r.outcome)).length, inputTokens: billed.reduce((a, r) => a + (r.inputTokens ?? 0), 0), outputTokens: billed.reduce((a, r) => a + (r.outputTokens ?? 0), 0),
    estUsd: col.spent, unknownPrice: recs.some((r) => !r.known), usageEstimated: billed.some((r) => r.billing !== 'reported'), latencyMs: { p50: percentile(lat, 0.5), p95: percentile(lat, 0.95) }, byTask,
  };
  report.schemaFailureRate = billed.length ? (report.usage.invalidOutputs + report.usage.truncated) / billed.length : null;
  const fails = (report.grading?.failed ?? 0) + (report.extraction?.failed ?? 0) + (report.generation?.failed ?? 0);
  report.items.note = report.items.approved === report.items.total ? 'All expected outcomes are human-approved.' : `${report.items.total - report.items.approved} of ${report.items.total} items are still DRAFT (written by the assistant, not yet human-reviewed): treat agreement numbers as provisional.`;
  report.caveats.push(report.items.note);
  if (!report.live) report.caveats.push('Offline provider: this measures the no-AI fallback, NOT a model. Its confidence is always low for open answers by design.');
  if (fails) report.caveats.push(`${fails} item(s) failed with provider/schema errors and count against agreement.`);
  report.caveats.push(`Small sample (${(report.grading?.n ?? 0) + (report.extraction?.n ?? 0) + (report.generation?.n ?? 0)} model-scored items): differences of a few points are noise.`);
  report.caveats.push('Estimated cost uses published list prices and provider-reported tokens; provider billing is authoritative.');
  return report;
}
