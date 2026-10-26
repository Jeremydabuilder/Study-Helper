# Study Helper

An evidence-driven study coach. It aims to help you learn more **per minute** than ordinary AI chat — and to *measure* whether it does, rather than claim it.

Open the app and the Today screen answers: **what should I study next, why, and for how long?**

```
Add material → find concepts → confirm → short diagnostic → practice (hint → feedback → new question)
            → remember mistakes → spaced review      ·      calendar/tests → a realistic, fitted schedule
```

AI generates and explains. **Application code** owns scheduling, persistence, math checking, evidence counting, budgets and progress.

> **Security boundary — read this.** This is a **local, single-user app with no login**. It binds to `127.0.0.1` and rejects cross-origin writes. Student records and Google tokens are protected only by that boundary (plus token encryption at rest). **Do not expose it to a network.** Before any public hosting you must add authentication and per-user data isolation; neither exists yet. `npm run doctor` flags a non-local `HOST`.

## Start it

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`; no native modules).

```bash
npm install
cp .env.example .env     # optional — the app runs without it (Offline mode)
npm run doctor           # checks your .env and explains what is missing (never prints secrets)
npm run build
npm start                # http://localhost:8787
npm run dev              # hot reload (API :8787, Vite :5173)
npm run check            # typecheck + all tests
```

Settings → **Setup & usage** shows the live state of everything:

| State | Meaning |
|---|---|
| **Offline mode** | No AI key. Math is fully supported (deterministic checker + generators). Other subjects: basic templates; open answers are keyword-checked and *never counted without your confirmation*. |
| **AI configured — not yet verified** | A key is set but no request has succeeded yet. Press **Verify connection** (one tiny request per model). |
| **AI connection verified** | A real request to every configured model has succeeded. |
| **AI credentials rejected** | The provider returned an auth error. Fix `.env`, restart. |
| **Calendar not set up / disconnected / connected / needs reconnecting** | See `docs/GOOGLE_SETUP.md`. The page shows the exact redirect URI to register. |

## AI configuration

Anthropic is the default and only provider unless you opt in to another. Models were checked against [Anthropic's models page](https://platform.claude.com/docs/en/about-claude/models/overview) and [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-26: `claude-sonnet-5-5` ($2 / $10 per million input/output tokens) and `claude-haiku-5-5` ($0.10 / $0.50 for prompts ≤100k tokens, more above). Everything is configurable in `.env` (see `.env.example`): default model, per-task model, per-task output ceiling and effort, daily budget, request cap, timeout.

**Recommendation (and why):** run **Sonnet 5.5 for every task** (the default). It is the quality baseline, and grading errors change a student's record. Haiku 5.5 is the natural candidate for *concept extraction* and *straightforward question generation* — it's roughly 20× cheaper per token — but **it has not been evaluated yet**, so it is not routed by default. To decide, human-approve the labels in `eval/dataset/`, run `npm run eval:live -- --confirm-spend --models claude-sonnet-5-5,claude-haiku-5-5`, and opt in per task (`AI_MODEL_EXTRACT=claude-haiku-5-5`) only if the report supports it. Keep grading on Sonnet unless the margin is clear. Details: `docs/EVAL.md`. Defaults for output ceilings (4000/5000/1500 tokens) and effort (low/medium/medium) are **untuned**.

**Cost control (server-side, enforced before every request):**
- Every HTTP request is logged with provider-reported input/output/cache tokens, model, latency, attempt number and an *estimated* cost. A schema-repair retry is its own billable request, counted and budget-checked like any other.
- A rolling-24h **estimated-dollar budget** (`AI_DAILY_BUDGET_USD`, default $1.00; editable in Settings; 0 = off) and a request cap. A request is refused if spent + its worst-case cost (all `max_tokens` used) would exceed the budget.
- Output is capped per task; a response cut off at the cap is reported clearly and **not retried** (a retry would bill again).
- Fewer calls: math practice makes none; only relevant source passages and a few memory notes are sent; existing unseen questions are reused before generating more; an already-extracted source isn't re-extracted unless forced.
- Costs are **estimates** from list prices and provider token counts. **Your provider's billing is authoritative.**

**Optional Groq** (`AI_PROVIDER=groq` + `GROQ_API_KEY` + `GROQ_MODEL`): off unless explicitly selected, no default model, **not verified against the live API**. One provider is active per server process; there is no automatic fallback and no switching mid-attempt. When on, student material goes to Groq instead of Anthropic. See `docs/EVAL.md`.

**Prompt-injection hygiene:** uploaded text and answers are quoted data; lines that read like instructions to an AI are stripped before any model sees them, concepts/quotes supported only by such lines are dropped, quotes are re-verified against the source, and the model can't change app behaviour (output is schema-validated).

## What works

Core loop (subject → pasted source → verified concept proposals → confirm → diagnostic → practice with hints/feedback/new questions → saved attempts → resume → due reviews), evidence-based scheduling (hinted ≠ independent, delayed unaided counts most, uncertain grades change nothing until confirmed), deterministic math checking with independently verified generators, inspectable/editable memory with provenance, previewable import/export, progress with uncertainty (no grade predictions), exam mode, a sample workspace in a separate database, and read-only Google Calendar planning (calendar choice, confirmation screen showing the original event beside each proposal with unknowns marked, updates/cancellations/recurring exceptions/duplicates/all-day/time zones/DST, expired authorization, disconnect + deletion, a schedule fitted around busy time, buffers, bedtime, protected time and daily limits, with school class time *not* counted as a "heavy day").

## What was actually tested

**Run in this build** (`npm run check`: typecheck clean, **168 tests in 13 files pass**; `npm run build` OK):

- *Learning rules & core flow* (HTTP-level, in-memory/temp SQLite): scheduling and inclusive time boundaries, hint-assisted vs unaided evidence, uncertain/failed grades not changing mastery, no mastery from repetition, persistence/reopen/resume, duplicate submissions, misconception evidence and repair follow-ups, workspace separation, cross-origin rejection, import preview/commit.
- *AI failure handling* with **fake transports**: malformed/invalid/truncated output, repair retry, 429/5xx/timeout mapping, request-cap and budget enforcement (including blocking the retry), usage accounting from provider-reported tokens, no key/secret in any API response or log, injection stripping.
- *Math*: 1,080 generated problems cross-checked by the independent solver; 30 labelled checker cases (endpoints, equivalent forms, flipped signs, unparseable/code-like input).
- *Google Calendar end to end* against a **fake Google** (real `GoogleGateway` + real HTTP routes): PKCE, state/CSRF and replay, read-only scope, token encryption at rest, access-token refresh and re-encryption, 401-retry, revoked refresh → reconnect-needed, school-policy 403, revocation on disconnect, deletion, moved/cancelled/vanished events, paging, and an assertion that **every Calendar API request is a GET**. Plus America/New_York DST (Mar 8: 23h day, Nov 1: 25h day, both transitions, repeated and skipped hours, all-day and midnight-edge events, 15:30 study start stable across the change) and recurring-event exceptions.
- *Evaluation harness mechanics* with scripted fakes (a sycophantic grader is caught, budget cut-off, schema-failure reporting) and `npm run eval` on the **offline provider** (`docs/eval-results/offline-baseline.md`).
- *Manual browser walkthroughs* (Chromium via Playwright; screenshots **viewed**): empty state → subject → paste → concept review → diagnostic (wrong, unreadable input preserved, correct, "I don't know") → reload on feedback → pause with draft → resume → summary → re-planned Today → Progress/Memory; sample workspace Today/Plan/Calendar-confirmation/Memory; Settings → Setup in its unverified and verified states; AI-graded practice through the real `AnthropicTransport` over HTTP **against a local mock of the Anthropic API**; mobile (bottom nav) and dark layouts. Testing and the walkthroughs found, and I fixed: mobile nav placement, body-less DELETE rejected, extraction quality, an extractor treating an injected line as a concept, disconnect not actually revoking at Google, a DST gap resolving backwards, and **every school day being capped as a "heavy day"**.

**Not done — requires credentials or a human:**
- ❌ **No live Anthropic call has been made** (no key was available). The live smoke test and live evaluation are implemented and *opt-in*: `npm run smoke:ai -- --confirm-spend`, `npm run eval:live -- --confirm-spend`. They exit with code 2 and say so when credentials or consent are missing; they never fabricate results. Model quality, Haiku-vs-Sonnet, real latency/cost, and thinking-token behaviour are therefore **unmeasured**.
- ❌ **No live Google OAuth** (no Google credentials). Behaviour is verified only against the fake. `docs/GOOGLE_SETUP.md` was written from Google's documented flow without access to Google's current docs; follow its "verify it yourself" checklist.
- ❌ **Evaluation labels are drafts** written by the assistant, not human-reviewed (58 items). Agreement numbers are provisional until you approve them (`docs/EVAL.md`). Question *usefulness* needs human ratings (a review sheet is exported).
- ❌ Groq transport untested live; Haiku routing unevaluated.
- Not looked at in the browser this round: Subjects detail on mobile, Settings → Availability/Priorities/Data tabs (covered by API tests only).

## Limitations

- Calendar can't see **Google Classroom** or school-portal assignments; the app says so and supports manual entry. "Add study sessions to Calendar" (write permission + preview) is **not built** (button labelled unavailable). Original events are never modified.
- PDF/image upload and OCR are **not built** (labelled unavailable).
- No accounts or authentication (see the security boundary above).
- Offline mode: non-math questions are templates (a few per concept); open answers are keyword-checked and always need your confirmation.
- Google apps left in *Testing* status get refresh tokens that expire after ~7 days → periodic "needs reconnecting" (handled; see `docs/GOOGLE_SETUP.md`).
- The numeric math verifier covers one-variable relations on [-100, 100] and is sampling-based, not a proof. Calendar sync re-reads a [-2 d, +60 d] window.

## Architecture (short)

```
src/core/      pure, provider-independent: learning.ts (evidence + scheduler), priority.ts (Today plan), math*, sources.ts,
               retrieval.ts, calendar.ts (normalise/classify/diff), schedule.ts (availability + study blocks), time.ts, stats.ts
src/ai/        provider.ts (interface + per-request records) · llm.ts (prompts, zod validation, repair retry, Anthropic transport)
               groq.ts (opt-in) · factory.ts (one provider per process) · pricing.ts · offline.ts
src/eval/      dataset, scoring, runner, report, CLI, smoke test      eval/dataset/*.json   (58 draft-labelled items)
src/server/    db.ts (node:sqlite, numbered SQL migrations 001–003, real/demo files) · services/* · app.ts · doctor.ts · demoSeed.ts
src/web/       React + Vite client
```

Key decisions: concept state is a **replay of the attempt log** (correcting a grade just recomputes); models sit behind `AIProvider`/`LLMTransport` and every response is schema-validated, with quotes/math keys re-verified by the app; budget and call caps are enforced in one wrapper (`metered`) before each request; Google tokens are AES-256-GCM encrypted with `APP_SECRET` and never leave the server; the OAuth flow uses PKCE and the read-only scope only. More in `docs/ARCHITECTURE.md`.

## Next steps

1. **You:** add `ANTHROPIC_API_KEY`, run `npm run smoke:ai -- --confirm-spend`, then `npm run eval:live` on Sonnet; review/approve the eval labels; decide on Haiku for extraction.
2. **You:** follow `docs/GOOGLE_SETUP.md` and the "verify it yourself" checklist with a real calendar.
3. Tune effort/output ceilings from measured token use; add prompt caching for repeated source excerpts.
4. PDF/image upload with OCR confidence; Classroom import with its own explicit read scopes.
5. "Add study sessions to Calendar" with separate write consent and an exact-event preview.
6. Authentication + per-user isolation before any hosting.
