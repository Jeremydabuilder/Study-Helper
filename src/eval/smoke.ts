/**
 * Opt-in live smoke test: one concept extraction, one question generation, and three gradings, with a hard budget.
 *   npm run smoke:ai -- --confirm-spend [--budget-usd 0.10] [--model claude-haiku-5-5]
 * Exits 2 without credentials (and says so); never fabricates a pass.
 */
import { buildProvider } from '../ai/factory';
import { configFromEnv, loadEnvFile } from '../server/config';
import { runEval } from './run';

const args = process.argv.slice(2);
const val = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  loadEnvFile();
  const cfg = configFromEnv();
  const model = val('model');
  const c = model ? { ...cfg, model } : cfg;
  const provider = buildProvider(c);
  if (!provider) { console.error('SMOKE TEST NOT RUN: no AI provider configured (set ANTHROPIC_API_KEY in .env). Live verification is incomplete.'); process.exit(2); }
  if (!args.includes('--confirm-spend')) { console.error('SMOKE TEST NOT RUN: it makes ~5 small paid requests. Re-run with --confirm-spend.'); process.exit(2); }
  const budget = Number(val('budget-usd') ?? 0.1);
  const r = await runEval({ provider, label: provider.name, ids: ['x-hist', 'gen-hist-alliances', 'hist-01', 'hist-03', 'eng-02'], only: ['extraction', 'generation', 'grading'], budgetUsd: budget, priceOverride: cfg.aiPriceOverride });
  const u = r.usage;
  console.log(`Models: ${Object.values(r.models).join(' / ')}`);
  console.log(`Extraction : ${r.extraction ? `${r.extraction.perItem[0]?.concepts ?? 0} concepts, source fidelity ${r.extraction.sourceFidelity === null ? 'n/a' : Math.round(r.extraction.sourceFidelity * 100) + '%'}, failed=${r.extraction.failed}` : 'not run'}`);
  console.log(`Generation : ${r.generation ? `${r.generation.questions} questions, quote fidelity ${r.generation.sourceQuoteFidelity === null ? 'n/a' : Math.round(r.generation.sourceQuoteFidelity * 100) + '%'}, failed=${r.generation.failed}` : 'not run'}`);
  console.log(`Grading    : ${r.grading ? `${r.grading.n} graded, agreed with expected on ${Math.round((r.grading.agreement ?? 0) * 100)}%, failed=${r.grading.failed}` : 'not run'}`);
  console.log(`Requests ${u.requests} (retries ${u.repairRetries}), tokens ${u.inputTokens}/${u.outputTokens}, p50 ${u.latencyMs.p50 ?? '—'} ms, est. cost $${u.estUsd.toFixed(4)} (budget $${budget.toFixed(2)}; provider billing is authoritative)`);
  if (r.stoppedEarly) console.log(`STOPPED EARLY: ${r.stoppedEarly.reason}`);
  const failed = (r.extraction?.failed ?? 1) + (r.generation?.failed ?? 1) + (r.grading?.failed ?? 1) > 0 || !!r.stoppedEarly;
  console.log(failed ? 'RESULT: FAILED or incomplete — see above.' : 'RESULT: all three live paths returned schema-valid results.');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
