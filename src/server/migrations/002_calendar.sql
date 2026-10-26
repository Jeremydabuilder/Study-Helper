-- Google Calendar (read-only) + academic items. Tokens are stored encrypted (AES-256-GCM, key from APP_SECRET).
CREATE TABLE cal_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1), provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected','reauth_required','error','disconnected')),
  account_email TEXT, scope TEXT, token_enc TEXT, connected_at INTEGER, last_sync_at INTEGER, last_sync_ok_at INTEGER, last_error TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE cal_calendars (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tz TEXT NOT NULL DEFAULT 'UTC', color TEXT,
  selected INTEGER NOT NULL DEFAULT 0, detect_academic INTEGER NOT NULL DEFAULT 0,
  counts_busy INTEGER NOT NULL DEFAULT 0, all_day_busy INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL DEFAULT 'other',
  last_synced_at INTEGER
);
CREATE TABLE cal_events (
  key TEXT PRIMARY KEY, calendar_id TEXT NOT NULL REFERENCES cal_calendars(id) ON DELETE CASCADE, event_id TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', all_day INTEGER NOT NULL,
  start_utc INTEGER, end_utc INTEGER, start_date TEXT, end_date TEXT, tz TEXT NOT NULL,
  status TEXT NOT NULL, transparent INTEGER NOT NULL DEFAULT 0, recurring_event_id TEXT,
  etag TEXT NOT NULL DEFAULT '', source_updated TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL,
  missing INTEGER NOT NULL DEFAULT 0, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE INDEX cal_events_cal ON cal_events(calendar_id, start_utc);
CREATE TABLE cal_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added','changed','cancelled','missing')),
  event_key TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', seen INTEGER NOT NULL DEFAULT 0
);
-- Assessments, homework, projects. Created from confirmed calendar proposals or entered manually.
CREATE TABLE academic_items (
  id TEXT PRIMARY KEY, subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('homework','test','quiz','project','presentation','other_deadline')),
  title TEXT NOT NULL,
  due_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (due_kind IN ('unknown','date','datetime')), due_date TEXT, due_at INTEGER,
  topics_text TEXT, format TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('proposed','confirmed','dismissed')),
  source TEXT NOT NULL CHECK (source IN ('manual','calendar')), event_key TEXT,
  sync_state TEXT NOT NULL DEFAULT 'ok' CHECK (sync_state IN ('ok','source_changed','source_cancelled','source_missing')), sync_note TEXT NOT NULL DEFAULT '',
  estimate_min INTEGER, done_min INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER, user_edited TEXT NOT NULL DEFAULT '[]', proposal TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX academic_items_event ON academic_items(event_key) WHERE event_key IS NOT NULL;
CREATE TABLE academic_item_concepts (
  item_id TEXT NOT NULL REFERENCES academic_items(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, PRIMARY KEY (item_id, concept_id)
);
