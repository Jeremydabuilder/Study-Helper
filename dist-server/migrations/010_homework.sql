-- Homework helper. Everything here lives in the student's own database. Homework never writes to attempts or concept_state:
-- finishing homework (with or without help) is not independent evidence of understanding.
CREATE TABLE homework (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  item_id TEXT REFERENCES academic_items(id) ON DELETE SET NULL,      -- the Plan entry for this assignment (never a duplicate)
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,           -- the original instructions as pasted/uploaded; never edited
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,                                         -- the confirmed copy, editable by the student
  preamble TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('math','science','history','english','other')),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active')),
  work_status TEXT NOT NULL DEFAULT 'not_started' CHECK (work_status IN ('not_started','working','stuck','completed')),
  assessment_mode INTEGER NOT NULL DEFAULT 0,                         -- the student says this is a test/quiz in progress: concept help only
  split TEXT NOT NULL DEFAULT 'numbered',
  due_hints TEXT NOT NULL DEFAULT '[]',                               -- dates quoted from the sheet, suggestions only
  est_min INTEGER,
  priority_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX homework_state ON homework(state, updated_at);
CREATE TABLE homework_questions (
  id TEXT PRIMARY KEY, homework_id TEXT NOT NULL REFERENCES homework(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, label TEXT NOT NULL, prompt TEXT NOT NULL,
  model_prompt TEXT NOT NULL,                                         -- what an AI may see: strong instruction-like passages replaced by a marker
  masked INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('math','science','history','english','other')),
  unreadable INTEGER NOT NULL DEFAULT 0,                              -- the sheet had text that could not be read; the student must fix or acknowledge before solving
  acknowledged INTEGER NOT NULL DEFAULT 0,
  work_status TEXT NOT NULL DEFAULT 'not_started' CHECK (work_status IN ('not_started','working','stuck','completed')),
  est_min INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX homework_questions_hw ON homework_questions(homework_id, position);
-- every saved version of the student's working is kept; the newest is current
CREATE TABLE homework_work (
  id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES homework_questions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, text TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'typed' CHECK (origin IN ('typed','photo','pasted')), source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, UNIQUE (question_id, version)
);
-- the assistance ledger: what help was shown on which question, in what order
CREATE TABLE homework_help (
  id TEXT PRIMARY KEY, homework_id TEXT NOT NULL REFERENCES homework(id) ON DELETE CASCADE, question_id TEXT NOT NULL REFERENCES homework_questions(id) ON DELETE CASCADE,
  action TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1,
  assistance TEXT NOT NULL CHECK (assistance IN ('none','hint','explanation_viewed','ai_helped_draft','worked_answer_shown')),
  ask TEXT, response TEXT NOT NULL, basis TEXT, ai INTEGER NOT NULL DEFAULT 0, used TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);
CREATE INDEX homework_help_q ON homework_help(question_id, created_at);
-- checks are append-only: a challenge adds to a check, it never replaces it
CREATE TABLE homework_checks (
  id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES homework_questions(id) ON DELETE CASCADE, work_id TEXT REFERENCES homework_work(id) ON DELETE SET NULL,
  work_text TEXT NOT NULL, method TEXT NOT NULL CHECK (method IN ('exact','assistant','both','none')),
  verdict TEXT NOT NULL CHECK (verdict IN ('correct','needs_revision','uncertain','unchecked')),
  result TEXT NOT NULL, challenge TEXT, challenged_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX homework_checks_q ON homework_checks(question_id, created_at);
CREATE TABLE homework_time (
  id TEXT PRIMARY KEY, homework_id TEXT NOT NULL REFERENCES homework(id) ON DELETE CASCADE, question_id TEXT REFERENCES homework_questions(id) ON DELETE SET NULL,
  minutes REAL NOT NULL, at INTEGER NOT NULL
);
-- which topics (concepts) a question touches; suggested by word overlap, always editable
CREATE TABLE homework_concepts (
  question_id TEXT NOT NULL REFERENCES homework_questions(id) ON DELETE CASCADE, concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('suggested','student')), PRIMARY KEY (question_id, concept_id)
);
