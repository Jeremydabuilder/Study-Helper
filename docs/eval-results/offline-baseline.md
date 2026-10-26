<!-- Real output of `npm run eval` (offline provider, no AI model) on 2026-10-26, dataset: 58 items, all still DRAFT labels. NOT a model measurement. -->
# Evaluation report

Run: 2026-10-26T02:07:14.694Z

> 58 of 58 items are still DRAFT (written by the assistant, not yet human-reviewed): treat agreement numbers as provisional.
> Offline provider: this measures the no-AI fallback, NOT a model. Its confidence is always low for open answers by design.
> Small sample (28 model-scored items): differences of a few points are noise.
> Estimated cost uses published list prices and provider-reported tokens; provider billing is authoritative.

| Metric | offline (no AI) |
|---|---|
| Models (extract / generate / grade) | n/a / n/a / n/a |
| Math checker accuracy (deterministic, no AI) | 100% (30) |
| Grading agreement (all items) | 62% (n=21) |
| Grading agreement when it is confident | — |
| Abstain rate (low confidence → not counted) | 100% |
| False-credit rate (full credit to a wrong/stuffed/injected answer) | 0% |
| False-reject rate (correct answer scored low) | 19% |
| Extraction: expected-concept recall | 100% |
| Extraction: source fidelity (quotes found in source) | 100% |
| Extraction: injection obeyed (count) | 0 |
| Questions: source-quote fidelity | — |
| Questions: math keys contradicting solver | 0 |
| Questions: duplicates / avg distinct kinds | 0 / 1.8 |
| Questions: usefulness | needs human rating |
| Schema failure rate (invalid or truncated outputs / billed requests) | — |
| Requests (repair retries) | 0 (0) |
| Tokens in / out | 0 / 0 |
| Latency p50 / p95 | — / — |
| Estimated cost | $0 |
| Stopped early | no |

### offline (no AI): grading misses

| item | expected | got | confidence |
|---|---|---|---|
| hist-01 | high | low@0.33 | low |
| hist-02 | mid | low@0.00 | low |
| hist-08 | high | low@0.00 | low |
| hist-09 | mid | low@0.00 | low |
| eng-01 | high | low@0.00 | low |
| eng-03 | mid | low@0.00 | low |
| eng-05 | low | mid@0.67 | low |
| math-e1 | high | low@0.00 | low |

### offline (no AI): grading by category (pass/total)

- correct_different_words: 0/4
- partial: 1/4
- confident_misconception: 4/4
- keyword_stuffing: 1/2
- unsupported_quotation: 2/2
- ambiguous_question: 2/2
- prompt_injection_in_answer: 1/1
- quote_vs_paraphrase: 1/1
- prompt_injection_in_source: 1/1

