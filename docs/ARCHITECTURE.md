# Architecture notes

See the README for the overview. Details worth knowing:

**Evidence → state.** `core/learning.ts#replay` folds an ordered attempt log into a `ConceptState`. Classification (`first_cold`, `delayed_unaided`, `recent_unaided`, `after_explanation`, `hinted`, `assisted`) and weights are in `DEFAULT_PARAMS`; override via the `scheduler_params` setting. `nextInterval` is the only place intervals change. Replacing the scheduler means replacing `nextInterval` + `replay`; nothing else depends on its internals.

**Planning.** `core/priority.ts#planToday` = Σ weight·component (urgency, weakness, overdue, prereq, unassessed, repair) / Σ weights → 0–100 ordering score. Components are returned and shown. `core/schedule.ts#buildSchedule` places study blocks into free windows; it is pure and recomputed on demand, so "replanning" is just calling it again after any input changes.

**Calendar.** `CalendarGateway` (Google / in-memory / unconfigured). `core/calendar.ts` normalises events (all-day = floating inclusive dates; timed = instants), classifies conservatively, and diffs a sync window against stored events. `services/calendar.ts` applies the diff in one transaction. Proposals are never auto-confirmed; confirmed items keep `user_edited` fields that sync will not overwrite.

**AI boundary.** `ai/provider.ts` is the interface; `ai/llm.ts` builds prompts, validates with zod (`ai/schemas.ts`), retries once with a repair prompt, then raises a typed `AIError`. The app (not the model) verifies quotes, math keys (`verifyMathSpec`), and evidence quotes. `services/common.ts#metered` enforces the daily cap.

**Migrations.** `src/server/migrations/NNN_name.sql`, applied in order inside a transaction and recorded in `schema_migrations`. Add a new numbered file for any schema change; never edit applied ones.
