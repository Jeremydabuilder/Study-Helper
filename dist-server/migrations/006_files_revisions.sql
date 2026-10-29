-- Uploaded originals are stored byte-for-byte, separate from the text extracted from them.
CREATE TABLE source_files (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, filename TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('pdf','png','jpeg','webp')),
  bytes INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX source_files_sha ON source_files(sha256);

-- A material uploaded from a file starts as a draft: the student reviews the extracted text page by page before anything is built on it.
ALTER TABLE sources ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft','confirmed'));
ALTER TABLE sources ADD COLUMN file_id TEXT REFERENCES source_files(id);
ALTER TABLE sources ADD COLUMN page_count INTEGER;
ALTER TABLE sources ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sources ADD COLUMN extraction TEXT; -- JSON: method, per-page warnings

-- Every change to the working text of a file-based material is a revision; nothing is overwritten without a trace.
CREATE TABLE source_revisions (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, rev INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('extracted','corrected','transcribed','replaced')), text TEXT NOT NULL, file_id TEXT REFERENCES source_files(id),
  note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE (source_id, rev)
);

-- When the text a concept or question was built from changes and its passage can no longer be found, the link is marked stale, never silently kept.
ALTER TABLE concept_refs ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
ALTER TABLE questions ADD COLUMN retired_at INTEGER;
ALTER TABLE questions ADD COLUMN retired_reason TEXT;
CREATE TABLE question_evidence (
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  quote TEXT NOT NULL, char_start INTEGER NOT NULL, char_end INTEGER NOT NULL, label TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (question_id, source_id, quote)
);
