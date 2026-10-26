/**
 * Evaluation CLI.
 *   npm run eval                          offline provider (no network, no cost) + deterministic math checks
 *   npm run eval:live -- --confirm-spend  real provider from .env; stops when --budget-usd would be exceeded
 *   options: --models a,b  --only math,grading  --limit N  --budget-usd 0.5  --out eval-out
 * Live runs never start without credentials AND --confirm-spend, and never invent results.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProvider } from '../ai/factory';
import { OfflineProvider } from '../ai/offline';
import { configFromEnv, loadEnvFile } from '../server/config';
import { renderMarkdown, routingHint } from './report';
import { runEval, Report } from './run';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  loadEnvFile();
  const cfg = configFromEnv();
  const live = flag('live');
  const only = val('only')?.split(',') as never;
  const limit = val('limit') ? Number(val('limit')) : undefined;
  const reports: Report[] = [];
  if (!live) {
    reports.push(await runEval({ provider: new OfflineProvider(), label: 'offline (no AI)', only, limit }));
  } else {
    const probe = buildProvider(cfg);
    if (!probe) { console.error('Live evaluation NOT run: no AI provider is configured (set ANTHROPIC_API_KEY, or AI_PROVIDER=groq with GROQ_API_KEY and GROQ_MODEL). No results were produced.'); process.exit(2); }
    if (!flag('confirm-spend')) { console.error(`Live evaluation NOT run: this makes paid requests to ${cfg.aiProvider}. Re-run with --confirm-spend (and optionally --budget-usd, default 0.50).`); process.exit(2); }
    const budget = val('budget-usd') ? Number(val('budget-usd')) : 0.5;
    const models = (val('models') ?? probe.modelFor('grade')).split(',').map((m) => m.trim()).filter(Boolean);
    let remaining = budget;
    for (const m of models) {
      const provider = buildProvider({ ...cfg, model: m, aiTasks: { extract: { ...cfg.aiTasks.extract, model: m }, generate: { ...cfg.aiTasks.generate, model: m }, grade: { ...cfg.aiTasks.grade, model: m } } })!;
      console.error(`Running ${m} (budget left ≈ $${remaining.toFixed(3)})…`);
      const r = await runEval({ provider, label: m, only, limit, budgetUsd: remaining, priceOverride: cfg.aiPriceOverride });
      remaining = Math.max(0, remaining - r.usage.estUsd);
      reports.push(r);
    }
  }
  const md = renderMarkdown(reports) + (reports.length > 1 ? `\n## Routing hints\n\n${routingHint(reports[0], reports[1]).map((x) => `- ${x}`).join('\n')}\n` : '');
  const dir = join(val('out') ?? 'eval-out', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(reports, null, 2));
  writeFileSync(join(dir, 'report.md'), md);
  const sheet = reports.flatMap((r) => (r.generation?.reviewSheet ?? []).map((q) => `"${r.label}","${q.id}","${q.kind}","${q.prompt.replace(/"/g, '""')}","",""`));
  if (sheet.length) writeFileSync(join(dir, 'question-review-sheet.csv'), ['model,id,kind,prompt,usefulness_1to5,notes', ...sheet].join('\n'));
  console.log(md);
  console.error(`Wrote ${dir}/`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
