-- A replacement for a confirmed file waits here until the student has reviewed and confirmed it; the confirmed text stays in use meanwhile.
CREATE TABLE source_pending (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE, file_id TEXT NOT NULL REFERENCES source_files(id),
  text TEXT NOT NULL, extraction TEXT, page_count INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);

-- Quote existence is not support. grounding = how well the passage the question cites actually contains what the answer needs.
--   source: the cited passage contains the answer's key terms   weak: quote exists but the key terms are not in it   none: no verifiable passage
ALTER TABLE questions ADD COLUMN grounding TEXT NOT NULL DEFAULT 'none' CHECK (grounding IN ('source','weak','none'));
ALTER TABLE questions ADD COLUMN reported_unclear INTEGER NOT NULL DEFAULT 0;
ALTER TABLE question_evidence ADD COLUMN support TEXT NOT NULL DEFAULT 'unchecked';
UPDATE questions SET grounding = 'weak' WHERE source_note LIKE 'Based on your material%';

-- What was seen in one answer (observed) is kept apart from a recurring pattern inferred from several (misconceptions).
ALTER TABLE attempts ADD COLUMN mistake_kind TEXT;
CREATE TABLE observed_mistakes (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE, concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, label TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX observed_mistakes_concept ON observed_mistakes(concept_id, created_at);

-- Free-form questions about one piece of feedback; tied to the attempt, never to other questions.
CREATE TABLE attempt_clarifications (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE, question TEXT NOT NULL, answer TEXT NOT NULL, ai INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
-- Explanations already shown for a concept in a session, so a failed explanation is not simply repeated.
ALTER TABLE sessions ADD COLUMN notes TEXT;

-- Why a question was written (so a discrimination or gap-filling question is reused as such), and what it contrasts with.
ALTER TABLE questions ADD COLUMN focus TEXT;
ALTER TABLE questions ADD COLUMN contrast_id TEXT;
