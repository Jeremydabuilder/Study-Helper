-- Support for a question, kept honest and separate from "a quote was located":
--   none          no passage cited / not tied to the material
--   located       a quote was found in the material; whether it supports the answer was NOT assessed (or only by keyword overlap, a heuristic)
--   plausible     a structured comparison of question, key and source context found it plausibly supported (still fallible)
--   contradicted  a check found the key conflicts with the source      insufficient  the source does not say enough to judge
--   accepted      the student reviewed a held question and accepted it
-- Questions that are contradicted/insufficient (or reported) are ON HOLD: never served, so they cannot influence learning records until resolved.
ALTER TABLE questions ADD COLUMN support_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE questions ADD COLUMN support_method TEXT;
ALTER TABLE questions ADD COLUMN support_note TEXT NOT NULL DEFAULT '';
ALTER TABLE questions ADD COLUMN on_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE questions ADD COLUMN hold_reason TEXT;
ALTER TABLE questions ADD COLUMN interpretive INTEGER NOT NULL DEFAULT 0;
-- the memory/confusion target a question was written to test, e.g. '<conceptId>|confusion:<otherConceptId>'
ALTER TABLE questions ADD COLUMN tests_key TEXT;
UPDATE questions SET support_state = 'located' WHERE grounding IN ('source', 'weak');

-- A wrong answer does not say why it was wrong. certainty: direct (the student said so) | likely (a tag, a chosen distractor, rubric evidence) | unknown.
ALTER TABLE observed_mistakes ADD COLUMN certainty TEXT NOT NULL DEFAULT 'likely';
-- the student's own account of a miss (optional, one tap), kept as their statement
ALTER TABLE attempts ADD COLUMN self_cause TEXT;
-- why a pattern was withdrawn (e.g. its supporting answers were regraded), so provenance is never silently lost
ALTER TABLE misconceptions ADD COLUMN note TEXT;
