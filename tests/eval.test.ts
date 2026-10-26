import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LLMProvider, LLMRequest, LLMResponse, LLMTransport } from '../src/ai/llm';
import { OfflineProvider } from '../src/ai/offline';
import { buildContext } from '../src/core/retrieval';
import { loadDataset, reviewStatus } from '../src/eval/dataset';
import { renderMarkdown, routingHint } from '../src/eval/report';
import { runEval } from '../src/eval/run';
import { bandOf, scoreGrade } from '../src/eval/score';
import { startServer, TestServer } from './helpers';

const D = loadDataset();
let s: TestServer | undefined;
afterEach(async () => { await s?.close(); });

describe('evaluation dataset', () => {
  it('is schema-valid, covers every required category, and is honest about review status', () => {
    const cats = new Set([...D.grading.map((g) => g.category), ...D.math.map((m) => m.category)]);
    for (const c of ['correct_different_words', 'partial', 'confident_misconception', 'keyword_stuffing', 'unsupported_quotation', 'ambiguous_question', 'prompt_injection_in_answer', 'prompt_injection_in_source', 'equivalent_answer', 'endpoint', 'unparseable'])
      expect(cats, `missing category ${c}`).toContain(c);
    expect(D.extraction.some((x) => x.forbiddenPatterns.length > 0)).toBe(true); // injection inside source material
    for (const subj of ['Math', 'History', 'English']) expect([...D.grading, ...D.extraction, ...D.generation].some((x) => x.subject === subj)).toBe(true);
    const r = reviewStatus(D);
    expect(r.total).toBeGreaterThan(50);
    // Nothing is marked human-approved unless a reviewer name and date were recorded.
    for (const x of [...D.grading, ...D.extraction, ...D.generation, ...D.math]) if (x.review.status === 'approved') { expect(x.review.by).toBeTruthy(); expect(x.review.at).toBeTruthy(); }
    expect(new Set(D.grading.map((g) => g.id)).size).toBe(D.grading.length);
  });
  it('the deterministic math checker agrees with every labelled math case (endpoints, equivalents, unparseable)', async () => {
    const r = await runEval({ provider: new OfflineProvider(), label: 'offline', only: ['math'] });
    expect(r.math!.failures).toEqual([]); expect(r.math!.accuracy).toBe(1);
  });
});

describe('scoring and harness mechanics (scripted fakes: these test the harness, NOT any model)', () => {
  it('bands and pass rules', () => {
    expect([bandOf(0.9), bandOf(0.5), bandOf(0.1)]).toEqual(['high', 'mid', 'low']);
    const amb = D.grading.find((g) => g.category === 'ambiguous_question')!;
    const mk = (correctness: number, confidence: 'high' | 'low') => scoreGrade(amb, { correctness, confidence, feedback: 'x', points: [] });
    expect(mk(0.5, 'high').ok).toBe(false); // must not be confident on an ambiguous question
    expect(mk(0.5, 'low').ok).toBe(true);
    const stuffed = D.grading.find((g) => g.category === 'keyword_stuffing')!;
    expect(scoreGrade(stuffed, { correctness: 0.95, confidence: 'high', feedback: 'x', points: [] })).toMatchObject({ ok: false, falseCredit: true });
  });
  it('catches a sycophantic grader (always full marks) and a perfect one', async () => {
    const answerKey = new Map(D.grading.map((g) => [g.answer, g]));
    const mkProvider = (fn: (user: string) => number) => new LLMProvider({ provider: 'fake', defaultModel: 'fake', complete: async (r: LLMRequest) => JSON.stringify({ correctness: fn(r.user), confidence: 'high', feedback: 'fine', points: [] }) });
    const sycophant = await runEval({ provider: mkProvider(() => 1), label: 'sycophant', only: ['grading'] });
    expect(sycophant.grading!.falseCreditRate).toBeGreaterThan(0.5); expect(sycophant.grading!.agreement).toBeLessThan(0.5);
    const oracle = await runEval({ provider: mkProvider((user) => { const g = [...answerKey.values()].find((x) => user.includes(x.answer.slice(0, 40))); return g ? (g.expected.acceptable.includes('high') ? 0.95 : g.expected.acceptable.includes('mid') ? 0.5 : 0.05) : 0; }), label: 'oracle', only: ['grading'] });
    // the oracle returns confidence "high" everywhere so the two ambiguous items must fail by design
    expect(oracle.grading!.misses.map((m) => m.id).sort()).toEqual(D.grading.filter((g) => g.expected.mustNotBeConfident).map((g) => g.id).sort());
  });
  it('stops at the budget: no request is started that could exceed it, and the report says so', async () => {
    let calls = 0;
    const t: LLMTransport = { provider: 'anthropic', defaultModel: 'claude-sonnet-5-5', complete: async (): Promise<LLMResponse> => { calls++; return { text: JSON.stringify({ correctness: 0.5, confidence: 'high', feedback: 'fine', points: [] }), model: 'claude-sonnet-5-5', stopReason: 'end_turn', requestId: null, usage: { input: 2000, output: 1500, cacheRead: 0, cacheWrite: 0 } }; } }; // max_tokens for grading is 1500, the most a real provider can bill
    const r = await runEval({ provider: new LLMProvider(t), label: 'costly', only: ['grading'], budgetUsd: 0.1 });
    expect(r.stoppedEarly).toMatchObject({ planned: D.grading.length }); expect(r.stoppedEarly!.completed).toBeLessThan(D.grading.length);
    expect(calls).toBe(r.usage.requests); expect(r.usage.estUsd).toBeLessThanOrEqual(0.1);
    expect(renderMarkdown([r])).toMatch(/Stopped early \| YES/);
  });
  it('reports schema failures and retries, and warns while labels are drafts', async () => {
    const t: LLMTransport = { provider: 'fake', defaultModel: 'fake', complete: async () => 'not json' };
    const r = await runEval({ provider: new LLMProvider(t), label: 'broken', only: ['grading'], limit: 3 });
    expect(r.grading!.failed).toBe(3); expect(r.usage.repairRetries).toBe(3); expect(r.schemaFailureRate).toBe(1);
    expect(r.caveats.join(' ')).toMatch(/DRAFT/);
  });
  it('routing hints are provisional while labels are drafts and never claim a universal winner', async () => {
    const a = await runEval({ provider: new OfflineProvider(), label: 'A', only: ['grading', 'extraction'] });
    const hints = routingHint(a, { ...a, label: 'B' }).join(' ');
    expect(hints).toMatch(/PROVISIONAL/); expect(hints).not.toMatch(/always|universally|better than all/i);
  });
});

describe('the live commands never run (or fake results) without credentials and explicit consent', () => {
  const env = { ...process.env, ANTHROPIC_API_KEY: '', GROQ_API_KEY: '', AI_PROVIDER: '' };
  it('smoke:ai and eval:live exit 2 and say live verification is incomplete', () => {
    for (const script of [['src/eval/smoke.ts'], ['src/eval/cli.ts', '--live']]) {
      const r = spawnSync('npx', ['tsx', ...script], { env, encoding: 'utf8', cwd: process.cwd() });
      expect(r.status, script.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/NOT run/i);
      expect(r.stdout).not.toMatch(/RESULT: all three live paths/);
    }
  }, 30_000);
  it('with a key but without --confirm-spend it still refuses (no surprise spend)', () => {
    const r = spawnSync('npx', ['tsx', 'src/eval/smoke.ts'], { env: { ...env, ANTHROPIC_API_KEY: 'sk-test-not-real' }, encoding: 'utf8', cwd: process.cwd() });
    expect(r.status).toBe(2); expect(r.stderr).toMatch(/--confirm-spend/);
  }, 30_000);
  it('the offline eval CLI runs and writes a report', () => {
    const out = execFileSync('npx', ['tsx', 'src/eval/cli.ts', '--only', 'math', '--out', '/tmp/claude-0/eval-test-out'], { env, encoding: 'utf8' });
    expect(out).toMatch(/Math checker accuracy/);
  }, 30_000);
});
