# Study Helper

An evidence-driven study coach. Its aim is to help you learn more **per minute** than ordinary AI chat — and to *measure* whether it does, rather than claim it.

Open the app and the Today screen answers: **what should I study next, why, and for how long?**

```
Add material → find concepts → confirm → short diagnostic → practice (hint → feedback → new question)
            → remember mistakes → spaced review      ·      calendar/tests → a realistic, fitted schedule
```

AI generates and explains. **Application code** owns scheduling, persistence, grading rules for math, evidence counting, permissions and progress.

## Setup

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`; no native modules).

```bash
npm install
cp .env.example .env        # optional: add keys (see below)
npm run build               # builds the web client into dist/
npm start                   # http://localhost:8787
# development with hot reload:  npm run dev   (API :8787, Vite :5173)
npm run check               # typecheck + all tests
```

With no `.env` it runs in **Offline mode** (works fully for math; basic template questions elsewhere). Use **Explore with sample data** on the first screen, or **Settings → Data**, for the clearly-labelled demo workspace.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Enables model-generated questions, concept extraction and rubric grading. Server-side only. |
| `AI_DAILY_CALL_LIMIT`, `AI_TIMEOUT_MS` | Cost cap and per-call timeout. |
| `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`, `APP_SECRET` | Optional read-only Google Calendar. `APP_SECRET` encrypts stored tokens. |
| `DATA_DIR`, `PORT`, `HOST` | Storage location (default `./data`), port, bind address (default `127.0.0.1`). |

**Google Calendar setup:** in Google Cloud Console enable the Calendar API, create an OAuth *Web application* client, add `GOOGLE_REDIRECT_URI` as an authorized redirect URI, then fill the four variables. Only `calendar.readonly` is requested. School-managed accounts may block third-party apps; the app explains this and manual entry works identically.

## What works

**Core loop** — subjects (any, editable) → paste text or upload `.txt/.md` → concept *proposals* linked to verbatim, verified source quotes with page/paragraph labels → you confirm/edit → short varied diagnostic → practice → saved attempts → resume anywhere → due reviews.

- **Grounding.** Every concept is tagged *From your material* / *Added by AI — verify* / *Needs verification*. Quotes a model returns are verified against the source text and discarded if not found. Source text is passed to models as quoted data, with delimiter tags neutralised; nothing in it can change app behaviour.
- **Diagnose first.** *Not assessed* is distinct from *weak*. Attempts record correctness (incl. partial), reasoning, hints, shown answers, "I don't know", optional confidence and response time (context only, never a penalty). A confident wrong answer is flagged.
- **Practice loop.** Attempt without the answer visible → two hint levels → specific feedback → explanation → a *new* question. "I don't know" shows a worked example and then an easier, lower-support item. Held-out questions stay unseen until reviews/transfer checks.
- **Evidence rules** (`src/core/learning.ts`). Delayed unaided success counts most; hinted, just-explained, or answer-seen attempts never count as independent; repeating one question doesn't count twice; "holding up" needs ≥3 independent successes on ≥2 questions over ≥2 days incl. one delayed. Uncertain/failed grades change nothing until you confirm them.
- **Spaced review.** Transparent, replaceable interval algorithm; due is inclusive at the boundary; solid topics aren't drilled; at most 5 tasks/6 reviews a day, "spread them out" instead of a backlog.
- **Math** — deterministic checker (no `eval`; custom parser): equivalent expressions, interval/inequality/set notation, endpoints, extraneous solutions, unions; tags *sign slip* vs *flipped inequality* vs *missed case*; repeated slips become patterns. Generators produce unlimited problems whose answer keys are cross-verified by an independent numeric solver (also applied to model-written math).
- **Mistake repair.** Misconception + linked attempt evidence → targeted repair task → fresh check ≥1 day later → marked repaired only after delayed independent success.
- **Memory** — separate *you told me* / *observed* / *AI guess*, with provenance, timestamps, edit & delete. Only relevant snippets reach a model. Previewable import/export, selectable per item.
- **Measurement** — delayed unaided recall, held-out vs practice accuracy, repeated mistake patterns, per-test coverage, minutes — all with sample sizes and Wilson ranges, no grade predictions.
- **Today** — time chips (10/20/30/custom), prioritised tasks with reasons and inspectable inputs, configurable weights, skip/pin overrides, welcome-back handling, resume.
- **Exam mode** — mixed questions on topics you linked to a test, feedback held to the end; report shows coverage and uncertainty.

**Google Calendar (read-only)** — choose calendars (school, homework, tests, tennis…); detects *possible* tests/quizzes/homework/projects/presentations; **confirmation screen shows the original event beside the proposal** with unknowns marked (due date, topics, subject, time needed are never invented; a timed event's start is not assumed to be a homework deadline); handles all-day events (dates, not instants), time zones/DST, recurring series (grouped), updates (your own edits are never overwritten), cancellations, vanished events, duplicates (unique keys + possible-duplicate warning); shows last successful sync and manual refresh; expired authorization is reported clearly while imported data and manual entry keep working; disconnect and delete-imported-data controls. **Schedule** (in-app only) is fitted around busy time with buffers, preferred hours, bedtime, protected time, daily limits and lighter busy-day caps, and re-fitted whenever deadlines or availability change. Homework completion is your own statement and never affects concept state.

## Limitations (honest list)

- **Calendar cannot see Google Classroom or school-portal assignments.** The app says so and offers manual entry.
- "Add study sessions to Calendar" (write permission + preview) is **not built**; the button is labelled unavailable. Original events are never modified.
- PDF/image upload and OCR are **not built** (labelled unavailable). Page/uncertain-OCR plumbing exists in the chunker.
- Single local user, no accounts/login: data separation is real-vs-sample workspaces (separate files). Do not expose the port publicly; it binds to localhost and rejects cross-origin writes.
- Offline mode: non-math questions are templates (a few per concept), open answers are keyword-checked and always need your confirmation. History/English quality needs a model key.
- AI features were validated with injected fake transports; they have **not** been exercised against the live Anthropic API in this build.
- Numeric verifier covers one-variable relations on [-100,100]; sampling-based, not a proof. Calendar sync re-reads a [-2d,+60d] window (no incremental sync tokens).
- No sync of the study schedule to other devices; no notifications.

## Architecture (short)

```
src/core/      pure, provider-independent: learning.ts (evidence+scheduler), priority.ts (Today plan),
               math* (parser, sets, relations, checker, generators), sources.ts, retrieval.ts,
               calendar.ts (normalise/classify/diff), schedule.ts (availability + study blocks), time.ts, stats.ts
src/ai/        provider interface · llm.ts (prompts, zod validation, repair-retry, Anthropic transport with timeout/429/5xx mapping) · offline.ts
src/server/    db.ts (node:sqlite, explicit SQL migrations, two workspace files) · services/* · app.ts (Express) · demoSeed.ts · crypto.ts
src/web/       React + Vite client (hash routes, no UI framework)
tests/         110+ tests (vitest)
```

Key decisions: **SQLite via `node:sqlite`** (durable, zero native deps, explicit numbered migrations in `src/server/migrations`); **concept state is a replay of the attempt log**, so correcting a grade just recomputes; **UUID ids** so exports merge; **models only behind `AIProvider`** and every response is schema-validated, with quotes/evidence re-verified by the app; **daily AI call cap** and bulk generation (+ zero model calls for math) to avoid unnecessary calls; **tokens encrypted** (AES-256-GCM, key from `APP_SECRET`) and never sent to the browser; OAuth uses PKCE and the read-only scope only.

## Validation

`npm run check` → typecheck clean; **111 tests across 9 files** pass, covering: review scheduling & inclusive time boundaries; hint-assisted vs unaided evidence; uncertain-grade isolation; no mastery from repetition; persistence, reopen-the-app and resume; duplicate submission; invalid/malformed AI output, retry, timeout, 429, daily cap; grading failure keeps the answer and changes nothing; invented quotes dropped; source page references; prompt-injection containment; real vs sample workspace separation; cross-origin rejection; import preview writes nothing; calendar: updates, cancellations, missing events, all-day deadlines, time zones/DST, duplicates, expired authorization, OAuth refresh/`invalid_grant`/school-policy 403, encryption at rest, disconnect/deletion. 1,080 generated math problems are cross-checked by the independent solver.

Manually walked through in a browser (Chromium): empty state → subject → pasted source → concept review → diagnostic (wrong, unreadable input preserved, correct, "I don't know") → reload on the feedback screen → pause with a draft → resume → summary → Today re-plan → Progress/Memory; plus the sample workspace's Plan, Calendar confirmation, Settings, and mobile and dark layouts. Defects found this way (bottom-nav on mobile, body-less DELETE rejected, extraction quality, wording) were fixed and, where possible, covered by tests.

## Roadmap

1. Run against the live Anthropic API; tune prompts; add a real math-expression editor.
2. PDF/image upload with OCR confidence and page references; Classroom import via its own explicit read scopes.
3. "Add study sessions to Calendar" with separate write consent, exact-event preview, idempotent event ids.
4. Fit the review model to real data (compare interval policies on held-out recall) and add an A/B-able scheduler.
5. Writing/rubric workflow for English that preserves the student's voice; chronology/comparison tasks for History.
6. Accounts + per-user encryption if it is ever hosted; PWA/offline; notifications.
