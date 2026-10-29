# Architecture notes

See the README for the overview. Details worth knowing:

**Evidence → state.** `core/learning.ts#replay` folds an ordered attempt log into a `ConceptState`. Classification (`first_cold`, `delayed_unaided`, `recent_unaided`, `after_explanation`, `hinted`, `assisted`) and weights are in `DEFAULT_PARAMS`; override via the `scheduler_params` setting. `nextInterval` is the only place intervals change. Replacing the scheduler means replacing `nextInterval` + `replay`; nothing else depends on its internals.

**Planning.** `core/priority.ts#planToday` = Σ weight·component (urgency, weakness, overdue, prereq, unassessed, repair) / Σ weights → 0–100 ordering score. Components are returned and shown. `core/schedule.ts#buildSchedule` places study blocks into free windows; it is pure and recomputed on demand, so "replanning" is just calling it again after any input changes.

**Calendar.** `CalendarGateway` (Google / in-memory / unconfigured). `core/calendar.ts` normalises events (all-day = floating inclusive dates; timed = instants), classifies conservatively, and diffs a sync window against stored events. `services/calendar.ts` applies the diff in one transaction. Proposals are never auto-confirmed; confirmed items keep `user_edited` fields that sync will not overwrite.

**AI boundary.** `ai/provider.ts` is the interface; `ai/llm.ts` builds prompts, validates with zod (`ai/schemas.ts`), retries once with a repair prompt, then raises a typed `AIError`. The app (not the model) verifies quotes, math keys (`verifyMathSpec`), and evidence quotes. `services/common.ts#metered` enforces the daily cap.

**Migrations.** `src/server/migrations/NNN_name.sql`, applied in order inside a transaction and recorded in `schema_migrations`. Add a new numbered file for any schema change; never edit applied ones.

**AI cost layer.** `AIProvider` methods take optional `CallOpts` (`beforeRequest`, `onRequest`). `LLMProvider.call` emits one `RequestRecord` per HTTP request (outcome `ok | invalid_output | truncated | <error code>`, attempt number, provider-reported tokens, latency). `services/common.ts#metered` supplies the hooks: `beforeRequest` enforces the request cap and the rolling-24h estimated-dollar budget (spent + worst-case cost of the next request, using `ai/pricing.ts`), `onRequest` writes a row to `ai_usage` (migration 003). Setup states (`offline | configured_unverified | verified | verify_failed`) are *derived* from `ai_usage` history, so there is no separate flag to drift. One provider is built per process by `ai/factory.ts`; the sample workspace never uses it.

**Evaluation.** `eval/dataset/*.json` (draft-labelled) → `src/eval/run.ts` calls an `AIProvider` directly with the same collector/budget gate → `report.ts`. It is deliberately not coupled to the server so it can compare models without touching app data.

**Prompt-injection defence in depth.** `core/sources.ts#detectInstructionLike` flags (never deletes) wording that looks like orders to an AI; strong flags are masked out of the model-facing view (`sourceSafety.ts#modelChunks`), all flags are stored in `source_flags` with original offsets and are student-overridable. `sources.original_text` is protected by a trigger. The model prompt, schema validation and quote re-verification are the real boundaries.

## Teaching loop, memory and sessions (milestone 4)

- `core/diagnosis.ts` classifies one answer (six kinds); `core/nextAction.ts` maps evidence to the next question's purpose. `services/practice.ts` stores per-session teaching state in `sessions.notes` (consecutive misses, the pending next action) and tags each attempt with `mistake_kind`.
- Observed mistakes live in `observed_mistakes` (one per attempt); `misconceptions` are *patterns* (≥2 different questions, specific label, 30 days). Notes in `memories` carry provenance JSON (attempts, basis, check state, dismissed) and are written by `services/teachingMemory.ts`.
- `services/sessionPlan.ts` builds goal sessions (open → core → check slots sized from a soft time budget) and Today's single recommendation. Slots carry a `phase`; follow-ups after a miss are `priority` slots.
- Questions carry `grounding` (`source`/`weak`/`none`), `question_evidence.support`, `focus`/`contrast_id`, and `retired_at` when their passage changes or the student reports them unclear.
- Files: `source_files` (original bytes), `source_revisions`, `source_pending` (a replacement under review; the confirmed text stays live until confirmed). PDF text extraction runs in `pdfWorker.mjs` (a worker thread terminated on timeout). Optional vision reading is `services/ocr.ts` (explicit opt-in, consent token, ledger-accounted).

## Homework helper (M9)
Tables `homework`, `homework_questions`, `homework_work` (versions), `homework_help` (assistance ledger), `homework_checks` (append-only), `homework_time`, `homework_concepts` in each student's SQLite database (migration `010_homework.sql`). Service `services/homework.ts`; exact math step checker `core/stepcheck.ts`; sheet parsing `core/homeworkParse.ts`; two provider methods (`homeworkHelp`, `homeworkCheck`) behind the same ledger/budget wrapper as every other call. Homework reads Memory and the student's materials but writes only notes with provenance, never `attempts` or `concept_state`. See HOMEWORK.md.
