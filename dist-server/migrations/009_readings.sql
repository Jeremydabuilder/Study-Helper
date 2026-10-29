-- Annotation workspace, study items made from annotations, essay outlines, and chat conversations.
-- Everything is stored in the same per-workspace database as the rest of the app; the demo workspace has its own copy.

-- A teacher's prompt or rubric pasted by the student, attached to one reading. It is data, never instructions to the app.
CREATE TABLE reading_prompts (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('prompt','rubric')), text TEXT NOT NULL, updated_at INTEGER NOT NULL
);

-- A highlight with the student's note. `quote` is always copied from the stored text by the server, never supplied by the browser.
CREATE TABLE annotations (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  char_start INTEGER NOT NULL, char_end INTEGER NOT NULL, quote TEXT NOT NULL, source_rev INTEGER NOT NULL DEFAULT 1,
  category TEXT NOT NULL DEFAULT 'none' CHECK (category IN ('none','theme','characterization','imagery','argument','evidence','question','vocabulary','other')),
  note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX annotations_source ON annotations(source_id, char_start);

-- Optional AI help on an annotation, kept so it survives a reload. `note_snapshot` records which version of the note a feedback was about.
CREATE TABLE annotation_assists (
  id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('explain','define','question','feedback')), term TEXT,
  payload TEXT NOT NULL, note_snapshot TEXT, model TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX assists_annotation ON annotation_assists(annotation_id, created_at);

-- Which questions in the study system were made from which annotation (so edits/deletes can retire them and the UI can say where a card came from).
CREATE TABLE annotation_items (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('flashcard','short_answer','practice')), note_snapshot TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE INDEX annotation_items_annotation ON annotation_items(annotation_id);

CREATE TABLE outlines (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('study','general')), title TEXT NOT NULL DEFAULT 'New conversation',
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL, source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL,
  context TEXT, direct INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX messages_conv ON messages(conversation_id, created_at);
