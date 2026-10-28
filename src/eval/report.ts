import type { Report } from './run';

const p = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const usd = (x: number) => (x === 0 ? '$0' : `$${x.toFixed(x < 0.01 ? 4 : 3)}`);
const ms = (x: number | null) => (x === null ? '—' : `${x} ms`);

export function renderMarkdown(rs: Report[]): string {
  const L: string[] = [];
  L.push(`# Evaluation report`, '', `Run: ${rs[0]?.startedAt ?? ''}`, '');
  for (const r of rs) for (const c of r.caveats) if (rs.indexOf(r) === 0 || !rs[0].caveats.includes(c)) L.push(`> ${c}`);
  L.push('');
  const col = (f: (r: Report) => string) => rs.map(f).join(' | ');
  L.push(`| Metric | ${rs.map((r) => r.label).join(' | ')} |`, `|---|${rs.map(() => '---').join('|')}|`);
  const row = (name: string, f: (r: Report) => string) => L.push(`| ${name} | ${col(f)} |`);
  row('Models (extract / generate / grade)', (r) => Object.values(r.models).map((m) => m ?? 'n/a').join(' / '));
  row('Math checker accuracy (deterministic, no AI)', (r) => (r.math ? `${p(r.math.accuracy)} (${r.math.n})` : '—'));
  row('Grading agreement (all items)', (r) => (r.grading ? `${p(r.grading.agreement)} (n=${r.grading.n})` : '—'));
  row('Grading agreement when it is confident', (r) => (r.grading ? p(r.grading.agreementWhenConfident) : '—'));
  row('Abstain rate (low confidence → not counted)', (r) => (r.grading ? p(r.grading.abstainRate) : '—'));
  row('False-credit rate (full credit to a wrong/stuffed/injected answer)', (r) => (r.grading ? p(r.grading.falseCreditRate) : '—'));
  row('Mistake-kind agreement (items with a labelled kind; model runs only)', (r) => (r.grading?.mistakeKindAgreement ? `${r.grading.mistakeKindAgreement.agree}/${r.grading.mistakeKindAgreement.n}` : '— (offline provider gives no mistake kind)'));
  row('False-reject rate (correct answer scored low)', (r) => (r.grading ? p(r.grading.falseRejectRate) : '—'));
  row('Extraction: expected-concept recall', (r) => (r.extraction ? p(r.extraction.recall) : '—'));
  row('Extraction: source fidelity (quotes found in source)', (r) => (r.extraction ? p(r.extraction.sourceFidelity) : '—'));
  row('Extraction: injection obeyed (count)', (r) => (r.extraction ? String(r.extraction.injectionObeyed) : '—'));
  row('Questions: source-quote fidelity', (r) => (r.generation ? p(r.generation.sourceQuoteFidelity) : '—'));
  row('Questions: math keys contradicting solver', (r) => (r.generation ? String(r.generation.mathKeyFailures) : '—'));
  row('Questions: duplicates / avg distinct kinds', (r) => (r.generation ? `${r.generation.duplicates} / ${r.generation.distinctKinds?.toFixed(1) ?? '—'}` : '—'));
  row('Questions: usefulness', (r) => (r.generation ? 'needs human rating' : '—'));
  row('Schema failure rate (invalid or truncated outputs / billed requests)', (r) => p(r.schemaFailureRate));
  row('Requests (repair retries)', (r) => `${r.usage.requests} (${r.usage.repairRetries})`);
  row('Tokens in / out', (r) => `${r.usage.inputTokens.toLocaleString()} / ${r.usage.outputTokens.toLocaleString()}`);
  row('Latency p50 / p95', (r) => `${ms(r.usage.latencyMs.p50)} / ${ms(r.usage.latencyMs.p95)}`);
  row('Estimated cost', (r) => `${usd(r.usage.estUsd)}${r.usage.unknownPrice ? ' (price unknown)' : ''}`);
  row('Stopped early', (r) => (r.stoppedEarly ? `YES: ${r.stoppedEarly.completed}/${r.stoppedEarly.planned} items` : 'no'));
  for (const r of rs) {
    if (r.grading?.misses.length) { L.push('', `### ${r.label}: grading misses`, '', '| item | expected | got | confidence |', '|---|---|---|---|'); for (const m of r.grading.misses) L.push(`| ${m.id} | ${m.expected} | ${m.got} | ${m.confidence ?? '—'} |`); }
    if (r.grading) { L.push('', `### ${r.label}: grading by category (pass/total)`, ''); for (const [k, [a, b]] of Object.entries(r.grading.byCategory)) L.push(`- ${k}: ${a}/${b}`); }
    if (r.math?.failures.length) { L.push('', `### ${r.label}: math checker failures`, ...r.math.failures.map((f) => `- ${f}`)); }
  }
  return L.join('\n') + '\n';
}

/** Rule-of-thumb routing hint. Deliberately cautious: a hint from a small, provisionally-labelled set, never a verdict. */
export function routingHint(base: Report, cheap: Report): string[] {
  const out: string[] = [];
  const tol = 0.05;
  const g = (a: number | null | undefined) => a ?? 0;
  const draft = base.items.approved < base.items.total;
  const tag = draft ? ' (PROVISIONAL: labels are still draft)' : '';
  if (base.extraction && cheap.extraction) {
    const ok = g(cheap.extraction.recall) >= g(base.extraction.recall) - tol && g(cheap.extraction.sourceFidelity) >= g(base.extraction.sourceFidelity) - 0.01 && cheap.extraction.injectionObeyed <= base.extraction.injectionObeyed && g(cheap.schemaFailureRate) <= g(base.schemaFailureRate) + 0.02;
    out.push(`Concept extraction: ${ok ? `${cheap.label} matched ${base.label} within tolerance on this set — a candidate for routing` : `${cheap.label} did not match ${base.label} on this set — keep ${base.label}`}${tag}.`);
  }
  if (base.grading && cheap.grading) {
    const ok = g(cheap.grading.agreement) >= g(base.grading.agreement) - tol && g(cheap.grading.falseCreditRate) <= g(base.grading.falseCreditRate);
    out.push(`Grading open answers: ${ok ? `${cheap.label} matched ${base.label}` : `${cheap.label} was worse than ${base.label}`}; grading errors change a student's record, so keep the baseline unless the margin is clear and the labels are human-approved${tag}.`);
  }
  if (base.generation && cheap.generation) out.push(`Question generation: usefulness needs human ratings (review sheet); automatic checks only: source-quote fidelity ${p(cheap.generation.sourceQuoteFidelity)} vs ${p(base.generation.sourceQuoteFidelity)}${tag}.`);
  return out;
}
