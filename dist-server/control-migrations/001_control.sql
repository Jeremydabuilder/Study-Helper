-- Control plane (PostgreSQL): everything that must be shared and atomic across students and server instances.
-- It never holds study content (answers, readings, conversations, memory, files, calendar details). That lives in each student's own private database.
-- Better Auth owns the "user", "session", "account" and "verification" tables; they are created by its own migration after this one.

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Closed by default: nobody can be admitted until an operator turns the pilot on and issues invitations.
INSERT INTO app_settings (key, value) VALUES ('pilot_enabled', 'false'::jsonb), ('pilot_max_users', '30'::jsonb);

-- Single-use invitation codes. Only a hash of the code is stored. `label` is an operator note (for example a cohort name), never a student's name or email.
CREATE TABLE invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,          -- a sign-up is in progress with this code; the claim lapses after a few minutes
  used_at TIMESTAMPTZ,
  used_by TEXT,                    -- Better Auth user id
  revoked_at TIMESTAMPTZ
);

-- One row per provider request: the shared spending ledger. user_id is set to NULL when an account is deleted; the cost record stays, the link to the person does not.
CREATE TABLE ai_requests (
  id UUID PRIMARY KEY,
  user_id TEXT,
  purpose TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, attempt INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('reserved','settled','abandoned')),
  worst_usd NUMERIC(12,6) NOT NULL,         -- the conservative amount held before the request is sent
  reserved_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  unknown_usd NUMERIC(12,6) NOT NULL DEFAULT 0,  -- held because the request may have been billed but the amount is unknown
  usd NUMERIC(12,6) NOT NULL DEFAULT 0,     -- estimated cost from provider-reported usage
  outcome TEXT, billing TEXT, input_tokens INT, output_tokens INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ
);
CREATE INDEX ai_requests_user_time ON ai_requests (user_id, created_at DESC);
CREATE INDEX ai_requests_time ON ai_requests (created_at DESC);

-- Per-student daily counters for things other than model calls (uploads, extraction runs, chat messages ...). Atomic upsert with a cap.
CREATE TABLE usage_counters (
  user_id TEXT NOT NULL, day DATE NOT NULL, kind TEXT NOT NULL, n INT NOT NULL DEFAULT 0, bytes BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);

-- Security and operations events. Content-free by design: event names, ids and counts only.
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), event TEXT NOT NULL, user_id TEXT, detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
