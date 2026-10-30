# Study Helper

An evidence-driven study coach. It aims to help you learn more **per minute** than ordinary AI chat — and to *measure* whether it does, rather than claim it.

Open the app and the Today screen answers: **what should I study next, why, and for how long?**

```
Upload or pick material → choose goal + time → check only what needs a look → study ~20 min
   ask → attempt → diagnose → explain or hint → fresh follow-up → later review with a question you haven't seen
   ends with: what you showed on your own · what still needs work · what is uncertain · one next action · what is checked later
```

AI generates and explains. **Application code** owns scheduling, persistence, math checking, evidence counting, budgets and progress.

> **Two modes — read this.** **Local mode** (default, `npm start`) is a single-user app with **no login**: it binds to `127.0.0.1`, refuses any other `HOST`, and rejects cross-origin writes; do not expose it to a network. **Hosted mode** (`APP_MODE=hosted`, built by `npm run build:hosted`) is the invite-only multi-student pilot: sign-in (Google, or email+password on staging only), single-use invitations, PostgreSQL for accounts and limits, one private database file per student, spend limits, account export/delete. Hosted mode has **never been deployed or tested against live Google, AI or OCR services**; see `docs/LAUNCH_CHECKLIST.md` for what has and has not been verified, and `docs/DEPLOYMENT.md`.

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
| **AI configured — not yet verified** | A key is set but no authenticated request has succeeded for the current provider + model + key. |
| **Connection works — study output not verified** | An HTTP round trip succeeded (**Verify connection**). That proves the key and network only. |
| **Study output verified** | Each task (find concepts, write questions, grade) has returned *schema-valid* output from its configured model (**Verify study output** runs one tiny real task per role). Invalid, empty, truncated or refused replies never count. |
| **Connected, but recent study output was unusable** | The connection works but the latest reply for a task was invalid/empty/truncated/refused. |
| **AI credentials rejected** | The provider rejected the key more recently than any success. Fix `.env`, restart. |

Verification is keyed to provider, model and a fingerprint of the credential: change the model or the key and the state goes back to "not verified".
| **Calendar not set up / disconnected / connected / needs reconnecting** | See `docs/GOOGLE_SETUP.md`. The page shows the exact redirect URI to register. |

## AI configuration

Anthropic is the default and only provider unless you opt in to another. Models were checked against [Anthropic's models page](https://platform.claude.com/docs/en/about-claude/models/overview) and [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-26: `claude-sonnet-5-5` ($2 / $10 per million input/output tokens) and `claude-haiku-5-5` ($0.10 / $0.50 for prompts ≤100k tokens, more above). Everything is configurable in `.env` (see `.env.example`): default model, per-task model, per-task output ceiling and effort, daily budget, request cap, timeout.

**Recommendation (and why):** run **Sonnet 5.5 for every task** (the default). It is the quality baseline, and grading errors change a student's record. Haiku 5.5 is the natural candidate for *concept extraction* and *straightforward question generation* — it's roughly 20× cheaper per token — but **it has not been evaluated yet**, so it is not routed by default. To decide, human-approve the labels in `eval/dataset/`, run `npm run eval:live -- --confirm-spend --models claude-sonnet-5-5,claude-haiku-5-5`, and opt in per task (`AI_MODEL_EXTRACT=claude-haiku-5-5`) only if the report supports it. Keep grading on Sonnet unless the margin is clear. Details: `docs/EVAL.md`. Defaults for output ceilings (4000/5000/1500 tokens) and effort (low/medium/medium) are **untuned**.

**Cost control (server-side, enforced before every request):**
- Every HTTP request gets its own unique ledger row (no shared state between parallel calls) with provider-reported tokens, model, latency, attempt, billing certainty and an *estimated* cost. A schema-repair retry is its own billable request.
- **Atomic reservations.** Before each request the server, inside one database transaction, reserves a conservative worst case (input ≤ bytes sent + 300 tokens, output ≤ `max_tokens`, +10%) against `budget − spent − held`; parallel requests cannot spend the same budget. The reservation is replaced by provider-reported usage when the response arrives (also for empty, truncated, refused or invalid replies, which are still billed). Tokens are *not* counted with a provider endpoint; the bytes-based bound is documented in `src/ai/pricing.ts`.
- **Certainty is explicit.** Provider error statuses and connection-refused are confirmed zero cost; a **timeout or dropped connection is unknown billing** and stays held at its worst case for 24 h; a response without usage is *estimated* and held at the reservation. A process that dies mid-request leaves a reservation that is recovered on the next start as unknown billing. A late response reconciles to its real cost.
- A rolling-24h **estimated-dollar budget** (`AI_DAILY_BUDGET_USD`, default $1.00; editable in Settings; 0 = off) and a request cap. This is a **guardrail built on list-price estimates, not a guaranteed dollar ceiling**; your provider's billing is authoritative.
- Output is capped per task; a response cut off at the cap is reported clearly and **not retried** (a retry would bill again).
- Fewer calls: math practice makes none; only relevant source passages and a few memory notes are sent; existing unseen questions are reused before generating more; an already-extracted source isn't re-extracted unless forced.
- Costs are **estimates** from list prices and provider token counts. **Your provider's billing is authoritative.**

**Optional Groq** (`AI_PROVIDER=groq` + `GROQ_API_KEY`): off unless explicitly selected. Just the key: one built-in model (`openai/gpt-oss-120b`), no model choice. The ID came from a secondary source (Groq's own page was unreachable) and is **not verified against the live API**; costs show as unknown-price (conservatively estimated) unless you set `AI_PRICE_IN_PER_MTOK`/`AI_PRICE_OUT_PER_MTOK`. One provider is active per server process; there is no automatic fallback and no switching mid-attempt. When on, student material goes to Groq instead of Anthropic. See `docs/EVAL.md`.

**Prompt-injection hygiene:** uploaded text and answers are quoted data; the original text is kept immutable and never edited by a filter. Wording that looks like an order to an AI/grader is *detected* (a heuristic, not proof — no regex makes prompt injection impossible): **strong** matches are left out of the model-facing view by default, **weak** ones ("you are now", "system message", quoted dialogue, assignments about AI prompts) are only flagged. Every flag is listed in the material's **AI view** with its page/location, and the student can include or exclude it. Concepts supported only by excluded passages, or whose own text reads like an injected command, are dropped and counted. The real boundaries are that the model has no tools, its output is schema-validated, quotes are re-verified against the original, and the student confirms every concept.

## What works

Core loop (subject → pasted source → verified concept proposals → confirm → diagnostic → practice with hints/feedback/new questions → saved attempts → resume → due reviews), evidence-based scheduling (hinted ≠ independent, delayed unaided counts most, uncertain grades change nothing until confirmed), deterministic math checking with independently verified generators, inspectable/editable memory with provenance, previewable import/export, progress with uncertainty (no grade predictions), exam mode, a sample workspace in a separate database, and read-only Google Calendar planning (calendar choice, confirmation screen showing the original event beside each proposal with unknowns marked, updates/cancellations/recurring exceptions/duplicates/all-day/time zones/DST, expired authorization, disconnect + deletion, a schedule fitted around busy time, buffers, bedtime, protected time and daily limits, with school class time *not* counted as a "heavy day").

## Your first 20-minute session

0. **Setup → First real session** shows this list with a state for each step (done / to do / waiting / problem / skipped), derived only from what is recorded in your database. It never tests an outside service. Put keys in `.env` yourself; never paste them into the app or a chat. Then, in Setup, press **Verify connection** and **Verify study output**: only a schema-valid result from your exact model and key is shown as verified. (If you use a custom `ANTHROPIC_BASE_URL`, a pass proves that endpoint, not Anthropic.)
1. `npm install && npm run build && npm start`, open http://localhost:8787. (AI is optional: add `ANTHROPIC_API_KEY` to `.env` for better concept proposals, grading and questions; without it the app runs in Offline mode.)
2. On **Today** press **Upload or paste material** (or **Start studying**). Pick a goal — **Prepare for a test**, **Understand this material**, or **Review what I keep getting wrong** — and a time (20 min), choose or name a subject, and add your packet: a PDF, a screenshot, pasted text, or `samples/*.pdf` (fictional) to try it.
3. **Check what was read.** The original is beside the extracted text. Only pages that need a look are shown first (no text, odd characters, math the reader had to guess). Fix anything wrong, then continue. Nothing is built until you do.
4. **Check the concepts** found in this material (all ticked; untick junk) and press **Confirm and start**.
5. **Study.** Each question says *why* it was chosen. After each answer you see what was noticed, what happens next and why. You can **ask about the feedback** (about that question only), mark a question **unclear**, pause (Today → Resume) and reload without losing a typed answer.
6. **Finish** (or let the plan finish): the time budget never interrupts an answer; when it is reached you choose to wrap up or keep going. The summary lists what you showed on your own, what needs work, what is uncertain, one next action and what is checked again later.
7. Tomorrow, Today recommends one action with its reason and duration: a test that is coming up, recent mistakes, reviews that are due, or unchecked concepts. **Change** lets you pick another goal, time or subject.

## How the teaching loop works

- **Diagnosis, one answer at a time.** Each wrong answer is classified from evidence the app can see: missing basics, confusion between related concepts, a reasoning error, a careless slip, a partly right explanation, or *unreliable* (uncertain grade / question reported unclear → not counted). When the cause can't be told (e.g. a wrong math answer with no steps) the app says so rather than guessing.
- **Observed vs pattern.** One answer is one *observed mistake*. A *pattern* is saved only when the same specific mistake shows up on at least two different questions within 30 days. Generic labels ("wrong answer") never become patterns, and "I don't know" is a gap in the concept's level, never a "misconception".
- **Next question follows the evidence** (`src/core/nextAction.ts`): missing basics → short explanation + worked example, then a fresh question on your own; confusion → a question that makes you tell the two ideas apart; slip → a fresh problem of the same kind; partly right → a question on the missing idea; right but unsure or with a hint → another application unaided; two independent successes → move on and schedule a later check. A second miss shows the explanation a different way (source wording + summary) or checks a prerequisite; three misses stop drilling that idea for the day.
- **Memory changes teaching.** A content-specific mistake becomes a note with what happened, the answers behind it, dates, *observed once* vs *inferred from several answers*, and whether a later independent check suggests improvement. Notes choose the next question (a remembered confusion gets a discrimination question), reach the grader and generator prompts, and schedule a later check. You can dismiss or correct any note; dismissed notes stop affecting anything. The app never saves traits or learning styles.
- **Improvement is earned, per confusion.** Each note records which question *tests* it (a discrimination question written for that confusion, or a distractor carrying its label). An unrelated correct answer on the same concept touches nothing. Three stages: *corrected for now* (a targeted question answered right soon after, encouraging, the later review stays open); *improved* (a different targeted question, unaided, counted, at least the scheduler delay later, “suggests it improved, not proof”); *came back* (it recurred). Hinted or answer-seen successes never count. Every change is appended to the note's history. If you change a grade (“I was right”, “I missed it”) or report a question unclear, the conclusions that depended on that attempt are withdrawn or recomputed, with the trail kept; dismissed notes stay inactive.
- **A wrong answer alone doesn't say why.** Without evidence (steps, a labelled distractor, an explanation) the cause is *unknown*; you can add a one-tap “why” (didn't know / slip / mixed up / misread / not sure), recorded as what *you said*. One self-report never creates a pattern. Spelling slips and different valid explanations are not penalised.
- **Grounding states.** A quote being *located* in your material is different from the material *supporting* the answer key. Rule-based checks only flag possible problems (negation flipped, years differ, reversed order, First/Second swapped, a person or institution the source doesn't mention); they can't certify support. “Plausibly supported” comes only from one batched model assessment per generation (or the offline template's own provenance), and it is fallible. Questions judged contradicted/insufficient are **held**: never served, never counted, until you accept or discard them (Subjects → held questions). You can also report a wrong source link on any question, which uncounts its attempts. Interpretive questions (“what does X suggest…”) aren't held for lacking a single key.
- **Ending.** A correct answer right after an explanation is a good sign, not independent evidence. Nothing says "mastered" or predicts a grade; the later check on an unseen question is what shows whether it stuck.

## Readings, annotations and chat (milestone 7)

**Readings** (nav → Readings). Paste a reading, or add a PDF/screenshot through *Study new material* (you confirm the extracted text page by page first). Open it, select text, pick a category (theme, characterization, imagery, argument, evidence, question, vocabulary, other) and write what you notice.

- **The quote is made by the server** from the stored text at the selected offsets; the browser cannot supply or alter it. If the reading text later changes, a highlight is found again by its quote or reported as “no longer found” — never silently moved.
- **Locations.** A page number is shown only where the text has page markers (`--- Page 2 ---` or form feeds from a text PDF) and the passage was not read from a scan or flagged as possibly misread; otherwise the section (¶n) is named, with “page not confirmed” when a page exists but cannot be trusted.
- **Optional help** (needs an AI provider; the app's existing provider is used, no new service): explain a passage, define a word *in context*, or ask you open questions. Every quotation in a reply that cannot be found in the text is removed. Passages that look like instructions to an AI are left out of anything sent to a model, as everywhere else. Without an AI, “Ask me a question” gives standard per-category prompts, labelled as not about the passage.
- **Feedback on your note** is available only after you have written your own interpretation (a sentence). With an AI it says whether the note *restates*, *interprets* or *develops* the passage and suggests optional next steps and questions without writing the interpretation for you. Without an AI it is a word-overlap rule that can say “mostly copied”, and says it cannot judge reasoning. Feedback is marked out of date when you edit the note. A *tentative*, dismissible Memory note (“inferred”) is created only if at least three different passages in one reading were judged to restate and that is at least half of those that got feedback; it is withdrawn when its evidence disappears.
- **Teacher's prompt or rubric.** Paste it per reading. It is passed to help, feedback and Study chat as tagged data; the app does not guess what a teacher wants beyond the text you give it.
- **Study items** from selected highlights go into the *existing* system as the reading's own topic (“Reading: <title>”): **flashcards** (the passage is shown, you recall what it shows; the key is *your* note, so they need one), **short-answer evidence exercises** (kept for later checks), and **practice questions** (written by your AI provider from the selected passages and held to the usual grounding checks, or, offline, fill-in-the-blank cut from the highlighted sentence). Sessions grade your answer before showing explanations, diagnose mistakes, and schedule later reviews as for any topic. Editing a note or deleting a highlight retires the items made from it (your past answers stay).
- **Essay outlines** group the selected highlights by category with their verbatim quotes and locations. The thesis and each section's claim are blank for you to write; they save and survive reloads. Nothing in an outline is written for you.
- Highlights, prompts and outlines are included in an export only with the source text, and an import keeps a highlight only if its quote still matches the imported text at the saved position.

**Chat** (nav → Chat) has a mode switch, fixed per conversation:

- **Study mode** retrieves only what is relevant to each message (BM25-style ranking, no embeddings): assignments you entered or confirmed, a focused reading's prompt and highlights, matching passages, matching topics, matching Memory notes, and your profile. It guides step by step unless you tick *Just answer directly*, and every reply lists what it used. *What would be used?* shows the context before sending.
- **General mode** (everyday questions, writing, brainstorming, code) sends none of your study data and answers directly.
- Neither mode writes to Memory. Chat has no tools: it cannot browse, open links, or read or change your calendar, and says so; Study mode sees only assignments already in Plan.
- Chat needs an AI provider and refuses plainly without one. Calls count against the same request cap and budget as every other AI call.

**What next.** Today may recommend *Annotate “<reading>”*: a reading in the same subject as an assignment you entered or confirmed that is due within two weeks and has fewer than three highlights. This is an inference and the reason says so. *Not today* skips it for the day; three highlights complete it. Mistakes, due reviews and tests keep their existing priority.

**Setup.** Migration `009_readings.sql` is applied automatically on start; existing data is untouched. No new dependencies or services. Ownership: this is a local single-user app, so “ownership” means workspace separation (the sample workspace is a separate database) and every annotation/outline/conversation id being resolved inside its own reading or workspace.

**Milestone 7 checks.** `tests/readings.test.ts` and `tests/chat.test.ts` cover persistence across restarts, server-made quotes, page vs section citation, edit/delete, relocation, ownership and workspace separation, feedback gating, offline vs AI feedback, invented-quote stripping, injection handling, tentative memory, study items and scheduling through a real session, outlines, export/import, What-next, and chat mode behaviour (what is and is not sent, no memory writes, direct answers, persistence). AI replies come from a scripted transport. A Chromium walkthrough ran offline and against a local **mock** of the Anthropic API (the real transport over HTTP; the mock is not Anthropic and says nothing about model quality). **Follow-up pass:** practice questions now use every selected passage (up to 8) plus your notes; on small screens a “selected text” bar with *Add a note* appears (the note form is in the other pane), verified in Chromium with Pixel 7 touch emulation (tap highlight opens its note); a question held because it conflicts with the passage now says it was held instead of a generic failure, and the held-question card, Subjects on mobile and Settings tabs were walked in the browser. **Still not verified:** any real model's explanations, feedback quality, stance judgements or chat (no API key or authorised budget; `npm run smoke:ai` stays blocked); native long-press selection handles on a physical phone (emulation drives the selection programmatically).

## Reading scans and screenshots (optional, off by default)

Text PDFs are read locally. For scanned PDFs and PNG/JPEG/WebP screenshots you can **type** each page beside the original (always available) or turn on automatic reading with Anthropic's vision input:

1. Put `ANTHROPIC_API_KEY` in `.env` and add `AI_OCR=anthropic` (an explicit opt-in), restart.
2. In the review screen press **Read page N automatically…**. A dialog shows the provider and model, exactly which file/pages are sent (a PDF extract or the image), what is *not* sent, and a worst-case cost; nothing is sent until you approve that exact content (a consent token binds the approval to provider + model + file + pages).
3. The reader only transcribes. It reports for each block whether it could read it; **it gives no accuracy percentage**. Math, diagrams, tables, handwriting and unreadable parts are flagged and shown beside the original; the text can't be confirmed until each flagged page is checked or edited. Diagrams are never interpreted: they appear as `[diagram: … — not interpreted]`; unreadable parts as `[unreadable: …]`.
4. Usage is reserved and settled in the same ledger as every other AI call (purpose `ocr`) and counts toward the daily budget. Keys stay on the server. Reading is allowed only while a file is under review, so confirmed text is never rewritten.

**Unverified:** the request shapes (a base64 `document` block for PDFs, `image` blocks for screenshots, PDFs before text) match Anthropic's PDF-support documentation (checked 2026-10-27), but **no live reading has been run**. Tests use fixtures and a local mock.

## What was actually tested

**Run in this build** (`npm run check`: typecheck clean, **all tests pass** — see the count printed by `npm test`; `npm run build` OK):

- *Learning rules & core flow* (HTTP-level, in-memory/temp SQLite): scheduling and inclusive time boundaries, hint-assisted vs unaided evidence, uncertain/failed grades not changing mastery, no mastery from repetition, persistence/reopen/resume, duplicate submissions, misconception evidence and repair follow-ups, workspace separation, cross-origin rejection, import preview/commit.
- *AI failure handling* with **fake transports**: malformed/invalid/truncated output, repair retry, 429/5xx/timeout mapping, request-cap and budget enforcement (including blocking the retry), usage accounting from provider-reported tokens, no key/secret in any API response or log, injection stripping.
- *Math*: 1,080 generated problems cross-checked by the independent solver; 30 labelled checker cases (endpoints, equivalent forms, flipped signs, unparseable/code-like input).
- *Google Calendar end to end* against a **fake Google** (real `GoogleGateway` + real HTTP routes): PKCE, state/CSRF and replay, read-only scope, token encryption at rest, access-token refresh and re-encryption, 401-retry, revoked refresh → reconnect-needed, school-policy 403, revocation on disconnect, deletion, moved/cancelled/vanished events, paging, and an assertion that **every Calendar API request is a GET**. Plus America/New_York DST (Mar 8: 23h day, Nov 1: 25h day, both transitions, repeated and skipped hours, all-day and midnight-edge events, 15:30 study start stable across the change) and recurring-event exceptions.
- *Evaluation harness mechanics* with scripted fakes (a sycophantic grader is caught, budget cut-off, schema-failure reporting) and `npm run eval` on the **offline provider** (`docs/eval-results/offline-baseline.md`).
- *Manual browser walkthroughs* (Chromium via Playwright; screenshots **viewed**): empty state → subject → paste → concept review → diagnostic (wrong, unreadable input preserved, correct, "I don't know") → reload on feedback → pause with draft → resume → summary → re-planned Today → Progress/Memory; sample workspace Today/Plan/Calendar-confirmation/Memory; Settings → Setup in its unverified and verified states; AI-graded practice through the real `AnthropicTransport` over HTTP **against a local mock of the Anthropic API**; mobile (bottom nav) and dark layouts. Testing and the walkthroughs found, and I fixed: mobile nav placement, body-less DELETE rejected, extraction quality, an extractor treating an injected line as a concept, disconnect not actually revoking at Google, a DST gap resolving backwards, and **every school day being capped as a "heavy day"**.

**Not done — requires credentials or a human:**
- ❌ **No live Anthropic call has been made** (no key was available). The live smoke test and live evaluation are implemented and *opt-in*: `npm run smoke:ai -- --confirm-spend`, `npm run eval:live -- --confirm-spend`. They exit with code 2 and say so when credentials or consent are missing; they never fabricate results. Model quality, Haiku-vs-Sonnet, real latency/cost, and thinking-token behaviour are therefore **unmeasured**.
- ❌ **No live Google OAuth** (no Google credentials). Behaviour is verified only against the fake. `docs/GOOGLE_SETUP.md` was written from Google's documented flow without access to Google's current docs; follow its "verify it yourself" checklist.
- ❌ **Live vision reading** (scans/screenshots) is implemented but never run against Anthropic; only fixtures and a local mock. **Live clarification, mistake-kind grading and adaptive question writing** likewise run only against fakes/mocks.
- ❌ **No evidence yet that this improves learning** (no study was run); the app measures per-concept evidence and later checks, it does not claim improvement.
- ❌ **Evaluation labels are drafts** written by the assistant, not human-reviewed (64 items, 6 added for diagnosis). Agreement numbers are provisional until you approve them (`docs/EVAL.md`). Question *usefulness* needs human ratings (a review sheet is exported).
- ❌ Groq transport untested live; Haiku routing unevaluated.
- *Milestone 4 tests:* worker-thread PDF timeout that really terminates; replacing a confirmed file waits for review while the old text and questions stay in use; question grounding (a quote that exists ≠ support; unsupported checks rejected, regenerated once, else refused); diagnosis kinds, observed-vs-pattern, next-action policy, three-miss stop; clarification that never sends another question, closed during test-mode hold, capped; unclear reports; memory evidence, later-check status, dismiss/undo, effect on question choice and prompts; goal-based session phases, soft time budget, honest reflection; Today's recommendation order; vision reading with fixtures (consent gate, attachment shape, cost ledger, flags, review gating, budget stop, key never in output); experience scenarios with scripted AI (all labelled as app-behaviour tests, not model quality).
- *Milestone 4 browser walkthroughs* (Chromium via Playwright, screenshots viewed): (a) offline: Today → start flow → upload `samples/absolute-value-review.pdf` → only the page needing a look shown → concepts with page references → session with "why this question", observed-vs-pattern wording, discrimination follow-up, alternative explanation after a second miss → summary → Memory with evidence → next-day Today; (b) AI path through the real `AnthropicTransport` over HTTP **against a local mock of the Anthropic API** (not Anthropic): scanned fixture → disclosure dialog → vision reading (a PDF document block was received) → flagged math/diagram → confirm blocked until checked → grounded/unconfirmed/general question labels → clarification. The mock demonstrates the plumbing, not model quality.
- *Milestone 3 browser walkthrough* (Chromium, offline mode, fictional `samples/`): upload → review → correct `x^2`→`x²` → confirm → concepts with page references → reject junk → diagnostic → typed answer kept after an aborted request, after a reload, and sent as exactly one attempt → pause/resume from Today → clock advanced 72 h → Today; History and English PDFs through upload/review/concepts. **Not demonstrated:** the in-page PDF viewer (headless Chromium has no PDF plugin), a successful delayed review pass in this run (the diagnostic was answered mostly wrong), AI-written questions for the new samples (no key).
- Not looked at in the browser this round: Subjects detail on mobile, Settings → Availability/Priorities/Data tabs (covered by API tests only).

**Milestone 6 (trust) checks:** unit and HTTP tests for per-confusion evidence, immediate vs next-day, unrelated/hinted/answer-seen attempts, grade correction and invalidation, dismissed notes, unknown cause and self-report, contradiction heuristics, held questions and reports, spelling tolerance, the first-use checklist, and three **simulated** scenarios in `tests/scenario.test.ts` (history confusion chain with injected clocks, math without working, English interpretive answer). These are labelled simulated: they check rules, not that anyone learned. `npm run smoke:ai` reports *blocked* without a key and explicit `--confirm-spend`; *Browser walkthrough (Chromium, offline mode, desktop width):* Setup → First real session checklist (offline: AI steps shown as skipped, never verified); a history subject; Start → typed answer → uncertain grade → “Missed it” → unknown-cause wording (this walkthrough found stale “uncertain / not counted” text left after a self-grade, now fixed and tested) → “I mixed up two ideas” recorded as *You said*. Not walked in the browser: held-question card, support chips with an AI, mobile study screens. **No live model call was made for this milestone**, so the semantic support assessment, live grading wording and live diagnosis remain unverified.

## Limitations

- Calendar can't see **Google Classroom** or school-portal assignments; the app says so and supports manual entry. "Add study sessions to Calendar" (write permission + preview) is **not built** (button labelled unavailable). Original events are never modified.
- **Uploads:** *text PDFs* (≤15 MB, ≤60 pages) are read locally into per-page text in a worker thread that is terminated on timeout; *scanned PDFs and PNG/JPEG/WebP screenshots* can be read automatically **only if you enable the optional Anthropic vision reading** (unverified live); otherwise you type them beside the original. Word/Pages/other formats are rejected (export to PDF). The in-page PDF viewer needs a browser with a PDF plugin (headless Chromium has none; a link opens the original in a new tab). Reading order, line breaks and math are reconstructed from glyph positions: superscripts become `^`, flagged "check math", but fractions/roots in unusual fonts may be wrong — that is why you review each page first.
- Offline concept extraction is rough on real packets (it proposed some headings as concepts and mis-tagged a few math skills); you reject the junk. An AI key gives better proposals, unmeasured here.
- Local mode has no accounts or authentication (hosted mode does; see `docs/ARCHITECTURE.md`).
- Offline mode: non-math questions are templates (a few per concept); open answers are keyword-checked and always need your confirmation. Offline discrimination and gap questions are templates built from your concept summaries; clarification without AI only returns what is already known.
- **Cross-device use** exists only through hosted mode, which is a release candidate for a few invited friends and has not been deployed yet (`docs/LAUNCH_CHECKLIST.md`).
- The time budget assumes about two minutes per question (answering plus reading feedback); that is a planning estimate, not a measurement of you.
- Grounding: keyword/rule checks catch only some contradictions; correct terminology attached to a wrong relationship passes them. The semantic assessment is a single fallible model call and has never run against a live model. An unflagged question is not a verified one.
- Diagnosis from a single answer is a hypothesis (“likely”), shown as such; a MC distractor label shows what the choice *represents*, not why you chose it.
- A simulated clock proves the rules fire; whether a delay of ~20 hours is the right interval for you is unmeasured.
- Google apps left in *Testing* status get refresh tokens that expire after ~7 days → periodic "needs reconnecting" (handled; see `docs/GOOGLE_SETUP.md`).
- The numeric math verifier covers one-variable relations on [-100, 100] and is sampling-based, not a proof. Calendar sync re-reads a [-2 d, +60 d] window.

## Architecture (short)

```
src/core/      pure, provider-independent: learning.ts (evidence + scheduler), diagnosis.ts + nextAction.ts (teaching loop), grounding.ts (quote vs support), priority.ts (Today plan), math*, sources.ts,
               retrieval.ts, calendar.ts (normalise/classify/diff), schedule.ts (availability + study blocks), time.ts, stats.ts
src/ai/        provider.ts (interface + per-request records) · llm.ts (prompts, zod validation, repair retry, Anthropic transport)
               groq.ts (opt-in) · factory.ts (one provider per process) · pricing.ts · offline.ts
src/eval/      dataset, scoring, runner, report, CLI, smoke test      eval/dataset/*.json   (58 draft-labelled items)
src/server/    db.ts (node:sqlite, numbered SQL migrations 001–007, real/demo files) · pdf.ts + pdfWorker.mjs (worker-thread extraction) · services/* · app.ts · doctor.ts · demoSeed.ts
src/web/       React + Vite client
```

Key decisions: concept state is a **replay of the attempt log** (correcting a grade just recomputes); models sit behind `AIProvider`/`LLMTransport` and every response is schema-validated, with quotes/math keys re-verified by the app; budget and call caps are enforced in one wrapper (`metered`) before each request; Google tokens are AES-256-GCM encrypted with `APP_SECRET` and never leave the server; the OAuth flow uses PKCE and the read-only scope only. More in `docs/ARCHITECTURE.md`.

## Next steps

1. **You:** add `ANTHROPIC_API_KEY`, run `npm run smoke:ai -- --confirm-spend`, then `npm run eval:live` on Sonnet; review/approve the eval labels; decide on Haiku for extraction.
2. **You:** follow `docs/GOOGLE_SETUP.md` and the "verify it yourself" checklist with a real calendar.
3. Tune effort/output ceilings from measured token use; add prompt caching for repeated source excerpts.
4. **You:** if you want automatic reading of scans, enable `AI_OCR=anthropic` and try one page; check the result against the original before trusting it. Classroom import with its own explicit read scopes.
5. "Add study sessions to Calendar" with separate write consent and an exact-event preview.
6. Hosted mode (authentication, per-user isolation) is implemented; remaining work is staging validation and live checks (`docs/LAUNCH_CHECKLIST.md`).


## Homework helper
Add an assignment, work on it with graduated help, check your answers, and review later. See [docs/HOMEWORK.md](docs/HOMEWORK.md).
