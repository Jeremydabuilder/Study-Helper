-- Problem reports a student chooses to send. Anything attached is text the student saw in a preview and confirmed; the server never attaches study content by itself.
CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  message TEXT NOT NULL,
  attachment JSONB,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done'))
);
CREATE INDEX reports_user ON reports (user_id);
