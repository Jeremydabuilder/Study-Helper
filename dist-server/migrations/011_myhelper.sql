-- My Helper: the owner's everyday tasks and projects, kept beside Study Helper's data in the same private database.
-- School assignments are NOT stored here: they are the one copy in academic_items, which Study Helper's homework already links to.
ALTER TABLE academic_items ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
CREATE TABLE mh_tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('Personal','Project')),
  when_label TEXT NOT NULL DEFAULT 'This week' CHECK (when_label IN ('Today','Tomorrow','This week')), due_date TEXT,
  done_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE mh_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', stage INTEGER NOT NULL DEFAULT 1 CHECK (stage BETWEEN 1 AND 5),
  notes TEXT NOT NULL DEFAULT '', next_action TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- What has already been brought in from the old browser-only My Helper, so importing the same file again never makes copies.
CREATE TABLE mh_import_keys (
  kind TEXT NOT NULL CHECK (kind IN ('task','project','memory')), legacy_key TEXT NOT NULL, target_id TEXT NOT NULL, imported_at INTEGER NOT NULL,
  PRIMARY KEY (kind, legacy_key)
);
