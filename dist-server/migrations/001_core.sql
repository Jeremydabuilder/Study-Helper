-- Core learning records. IDs are UUID text so exports/imports merge without collisions.
CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT '', grade TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  default_minutes INTEGER NOT NULL DEFAULT 20,
  about TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE subjects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '[]', archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE sources (
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'notes', text TEXT NOT NULL, content_hash TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'pasted', ocr INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX sources_subject ON sources(subject_id);
CREATE TABLE source_chunks (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, text TEXT NOT NULL, page INTEGER, para INTEGER NOT NULL,
  char_start INTEGER NOT NULL, char_end INTEGER NOT NULL, label TEXT NOT NULL, uncertain INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX chunks_source ON source_chunks(source_id, idx);

CREATE TABLE concepts (
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected')),
  skill_tag TEXT, support TEXT NOT NULL DEFAULT 'unverified' CHECK (support IN ('source','ai','unverified')),
  support_note TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'student',
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX concepts_subject ON concepts(subject_id, status);
CREATE TABLE concept_refs (
  id TEXT PRIMARY KEY, concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, chunk_id TEXT REFERENCES source_chunks(id) ON DELETE SET NULL,
  quote TEXT NOT NULL, char_start INTEGER NOT NULL, char_end INTEGER NOT NULL, label TEXT NOT NULL
);
CREATE INDEX refs_concept ON concept_refs(concept_id);
CREATE TABLE concept_prereqs (
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  prereq_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, PRIMARY KEY (concept_id, prereq_id)
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY, concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL,
  choices TEXT, answer_spec TEXT NOT NULL, rubric TEXT, hints TEXT NOT NULL DEFAULT '[]',
  worked_example TEXT NOT NULL DEFAULT '', explanation TEXT NOT NULL DEFAULT '',
  difficulty INTEGER NOT NULL DEFAULT 2, family TEXT, heldout INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL, verified INTEGER, verify_note TEXT NOT NULL DEFAULT '',
  source_note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE INDEX questions_concept ON questions(concept_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, subject_id TEXT, mode TEXT NOT NULL CHECK (mode IN ('diagnostic','practice','review','exam','mixed')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  planned_minutes INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, active_ms INTEGER NOT NULL DEFAULT 0,
  slots TEXT NOT NULL, current TEXT, summary TEXT, hold_feedback INTEGER NOT NULL DEFAULT 0, item_id TEXT
);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  answer_text TEXT NOT NULL DEFAULT '', reasoning_text TEXT NOT NULL DEFAULT '', confidence INTEGER,
  hints_used INTEGER NOT NULL DEFAULT 0, saw_answer INTEGER NOT NULL DEFAULT 0, idk INTEGER NOT NULL DEFAULT 0,
  response_ms INTEGER, correctness REAL,
  grade_status TEXT NOT NULL DEFAULT 'pending' CHECK (grade_status IN ('graded','uncertain','failed','pending')),
  grade_source TEXT NOT NULL DEFAULT 'deterministic', grade_confidence TEXT,
  feedback TEXT NOT NULL DEFAULT '', diagnosis TEXT, feedback_shown INTEGER NOT NULL DEFAULT 1,
  client_token TEXT UNIQUE, student_note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE INDEX attempts_concept ON attempts(concept_id, created_at);
CREATE INDEX attempts_session ON attempts(session_id);
CREATE TABLE concept_state (
  concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
  state TEXT NOT NULL, level TEXT NOT NULL, due_at INTEGER, updated_at INTEGER NOT NULL
);

CREATE TABLE misconceptions (
  id TEXT PRIMARY KEY, concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  label TEXT NOT NULL, description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','repaired','dismissed')),
  origin TEXT NOT NULL DEFAULT 'observed', count INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, repaired_at INTEGER
);
CREATE TABLE misconception_evidence (
  misconception_id TEXT NOT NULL REFERENCES misconceptions(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE, PRIMARY KEY (misconception_id, attempt_id)
);
CREATE TABLE followups (
  id TEXT PRIMARY KEY, concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  misconception_id TEXT REFERENCES misconceptions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('repair','repair_check')), earliest_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')), created_at INTEGER NOT NULL, done_at INTEGER
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('student_stated','observed','ai_inferred')),
  text TEXT NOT NULL, subject_id TEXT, concept_id TEXT, provenance TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE plan_overrides (
  id TEXT PRIMARY KEY, date_key TEXT NOT NULL, concept_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('pin','skip')),
  created_at INTEGER NOT NULL, UNIQUE (date_key, concept_id)
);
CREATE TABLE ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, purpose TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT, ms INTEGER);
