-- The first captured text of every material is kept as an immutable original. `text` stays the working copy
-- (later corrections create revisions), so nothing a filter or an edit does can destroy what was first uploaded.
ALTER TABLE sources ADD COLUMN original_text TEXT NOT NULL DEFAULT '';
ALTER TABLE sources ADD COLUMN flags_version INTEGER NOT NULL DEFAULT 0;
UPDATE sources SET original_text = text WHERE original_text = '';

CREATE TRIGGER sources_original_fill AFTER INSERT ON sources WHEN NEW.original_text = ''
BEGIN UPDATE sources SET original_text = NEW.text WHERE id = NEW.id; END;
CREATE TRIGGER sources_original_immutable BEFORE UPDATE OF original_text ON sources
WHEN OLD.original_text <> '' AND NEW.original_text IS NOT OLD.original_text
BEGIN SELECT RAISE(ABORT, 'original source text is immutable'); END;

-- Passages whose wording looks like an instruction to an AI. Detection, not proof: offsets point into original_text.
-- decision: NULL = default for the severity, 'include' / 'exclude' = the student's explicit choice.
CREATE TABLE source_flags (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  char_start INTEGER NOT NULL, char_end INTEGER NOT NULL, severity TEXT NOT NULL CHECK (severity IN ('strong','weak')),
  rule TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL,
  decision TEXT CHECK (decision IN ('include','exclude')), decided_at INTEGER
);
CREATE INDEX source_flags_source ON source_flags(source_id);
