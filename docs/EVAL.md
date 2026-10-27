# Evaluating models before routing to them

Goal: decide **with measurements** whether a cheaper or faster model (Claude Haiku 5.5, or optionally Groq) may take over some tasks from the Sonnet 5.5 baseline. No model is assumed better or worse in general; the answer depends on the task and on *this* material.

## What is in the set (`eval/dataset/*.json`, 64 items)

| File | Items | Measures |
|---|---|---|
| `grading.json` | 27 | History, English and math-explanation answers against rubrics: correct in different words, partial, confident misconception, keyword stuffing, **unsupported/invented quotation**, quote-vs-paraphrase, **ambiguous question**, **prompt injection in the answer**, **injection inside the source excerpt**, plus 6 items for the adaptive loop (confusion between related concepts, partial explanation, missing knowledge, correct in different words, keyword stuffing, invented quotation) with an optional `expected.mistakeKind` |
| `extraction.json` | 3 | Concept extraction from a history packet, an English passage + rubric **containing an injected instruction**, and math notes (skill tags) |
| `generation.json` | 4 | Question generation grounded in history/English excerpts |
| `math.json` | 30 | The deterministic math checker (no model): equivalent forms, endpoints, flipped inequalities, sign errors, missing/extraneous solutions, unparseable and code-like input |

All content is invented for this repo (nothing is a real teacher's rubric).

## ⚠️ Labels are drafts until a human approves them

The expected outcomes were **written by the assistant that built the app** and have **not** been human-reviewed. Every item carries `"review": {"status": "draft", "by": null, "at": null}` and every report says so. To review: open each JSON item, read `question`, `rubric`, `excerpts`, `answer`, `expected.acceptable` (bands: `high` ≥ 0.8, `mid` 0.35–0.8, `low` < 0.35) and `note`; fix anything you disagree with; then set `"review": {"status": "approved", "by": "<your name>", "at": "<date>"}`. A test enforces that "approved" requires a reviewer and date. Until all are approved, treat agreement numbers and routing hints as **provisional**.

## Running it

```bash
npm run eval                       # offline provider only: no network, no cost. Deterministic math checker + the no-AI fallback.
npm run smoke:ai -- --confirm-spend [--budget-usd 0.10] [--model claude-haiku-5-5]
                                   # 1 extraction + 1 generation + 3 gradings (~5 requests). Exits 2 if no credentials.
npm run eval:live -- --confirm-spend --budget-usd 1.00 --models claude-sonnet-5-5,claude-haiku-5-5
                                   # full set per model; STOPS before any request that could exceed the budget.
```

Live commands refuse to run (exit code 2, clear message) without credentials and without `--confirm-spend`. Output goes to `eval-out/<timestamp>/` (`report.md`, `report.json`, `question-review-sheet.csv`) and is git-ignored.

**Rough cost (my estimate from list prices; unmeasured):** a full Sonnet 5.5 pass is on the order of $0.2–0.5 (adaptive thinking can add output tokens); Haiku 5.5 is roughly 20× cheaper per token. The report prints the actual provider-reported tokens and estimated cost per model; your provider's billing is authoritative.

## Metrics

- **Grading agreement** — result band is among the human-accepted bands (and, for ambiguous questions, confidence is not "high"). Also **agreement when confident** and **abstain rate**: low-confidence grades are *not counted* by the app, so a model that abstains on hard items is safer than one that confidently errs.
- **False-credit rate** — full credit to a wrong, stuffed, invented-quote or injected answer. This is the dangerous error; weigh it above raw agreement.
- **False-reject rate** — a correct answer scored low (frustrating, and wrongly records a failure).
- **Source fidelity** — share of quotes a model returns that really occur in the source (the app also re-verifies and discards the rest).
- **Injection obeyed** — an instruction hidden in the source ended up as a concept/quote.
- **Question usefulness** — *not automatic*. The runner exports `question-review-sheet.csv`; a person rates 1–5. Automatic proxies only: source-quote fidelity, math keys contradicting the solver, duplicates, kind diversity, and a lexical grounding proxy.
- **Schema failure rate**, **repair retries**, **latency p50/p95**, **tokens**, **estimated cost** — from provider-reported usage.

## Deciding on routing

Run the same set on Sonnet 5.5 and Haiku 5.5 (and Groq if you opted in), then:

1. Look at **per-task** results, not an overall winner. A model can be fine for extraction and not for grading.
2. Route a task to the cheaper model only if, on human-approved labels: agreement is within a few points, **false-credit rate is no worse**, source fidelity and injection results are equal, and schema failures are not higher. The report's "Routing hints" apply a cautious version of this rule and print PROVISIONAL while labels are drafts.
3. Keep **grading on the baseline** unless the margin is clear: a wrong grade changes a student's record.
4. Opt in with `.env` (`AI_MODEL_EXTRACT=claude-haiku-5-5`, …) — never silently. The Setup screen shows which model serves which task.
5. Re-run after any prompt, model or effort change. The set is small (28 model-scored items): differences of a few points are noise.

## Groq (optional)

`AI_PROVIDER=groq` and `GROQ_API_KEY` enable a transport for Groq's OpenAI-compatible API with one fixed built-in model (`openai/gpt-oss-120b`, no model choice). It is **opt-in and has not been run against the live API**: Groq's official model list could not be reached and secondary sources disagreed, so treat the ID as a best guess. Add `AI_PRICE_IN_PER_MTOK`/`AI_PRICE_OUT_PER_MTOK` so cost estimates are meaningful, and run the evaluation first. When Groq is active, **student material is sent to Groq instead of Anthropic**; there is one active provider per server process, no automatic fallback, and no switching during a session (the Setup screen and every usage row show the provider and model).

## What has actually been measured so far

See `docs/eval-results/offline-baseline.md`: the offline fallback and the deterministic math checker. **No model has been evaluated** because no API credentials were available in the build environment.

## Adaptive-loop items and what they can and cannot show

The six newest grading items carry `expected.mistakeKind`. With a live model the report adds a *mistake-kind agreement* row (how often the grader's `mistake_kind` matches the draft label). The offline provider gives no mistake kind, so that row is empty for it. These labels are drafts like every other item.

`tests/experience.test.ts` and `tests/adaptive.test.ts` check what the **app** does with a grade (count it, hold it back, follow up, ask again later) using the offline provider or scripted fake AI. They are not model evaluations and say nothing about real grading quality. No study has measured whether the loop improves learning.
