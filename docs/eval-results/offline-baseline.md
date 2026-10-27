<!-- Real output of `npm run eval` (offline provider, no AI model) on 2026-10-27, dataset: 64 items (6 added for adaptive diagnosis), all still DRAFT labels. NOT a model measurement. -->
# Evaluation report

Run: 2026-10-27T02:58:49.612Z

> 64 of 64 items are still DRAFT (written by the assistant, not yet human-reviewed): treat agreement numbers as provisional.
> Offline provider: this measures the no-AI fallback, NOT a model. Its confidence is always low for open answers by design.
> Small sample (34 model-scored items): differences of a few points are noise.
> Estimated cost uses published list prices and provider-reported tokens; provider billing is authoritative.

| Metric | offline (no AI) |
|---|---|
| Models (extract / generate / grade) | n/a / n/a / n/a |
| Math checker accuracy (deterministic, no AI) | 100% (30) |
| Grading agreement (all items) | 59% (n=27) |
| Grading agreement when it is confident | — |
| Abstain rate (low confidence → not counted) | 100% |
| False-credit rate (full credit to a wrong/stuffed/injected answer) | 4% |
| Mistake-kind agreement (items with a labelled kind; model runs only) | — (offline provider gives no mistake kind) |
| False-reject rate (correct answer scored low) | 19% |
| Extraction: expected-concept recall | 100% |
| Extraction: source fidelity (quotes found in source) | 100% |
| Extraction: injection obeyed (count) | 1 |
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
| hist-pe-02 | mid | low@0.33 | low |
| hist-dw-04 | high | low@0.00 | low |
| eng-ks-05 | low | high@1.00 | low |

### offline (no AI): grading by category (pass/total)

- correct_different_words: 0/5
- partial: 1/5
- confident_misconception: 4/4
- keyword_stuffing: 1/3
- unsupported_quotation: 3/3
- ambiguous_question: 2/2
- prompt_injection_in_answer: 1/1
- quote_vs_paraphrase: 1/1
- prompt_injection_in_source: 1/1
- concept_confusion: 1/1
- missing_knowledge: 1/1
