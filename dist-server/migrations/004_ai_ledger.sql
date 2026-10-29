-- Reservation-based AI accounting. A row is created when a request is RESERVED (before it is sent) and reconciled
-- when it finishes. Spend that is not yet known is held at its conservative reservation, never at zero.
ALTER TABLE ai_usage ADD COLUMN request_uid TEXT;
ALTER TABLE ai_usage ADD COLUMN status TEXT NOT NULL DEFAULT 'settled';   -- reserved | settled | abandoned
ALTER TABLE ai_usage ADD COLUMN billing TEXT;                              -- reported | estimated | none_reported | not_sent | unknown
ALTER TABLE ai_usage ADD COLUMN worst_usd REAL NOT NULL DEFAULT 0;         -- the original worst-case reservation
ALTER TABLE ai_usage ADD COLUMN reserved_usd REAL NOT NULL DEFAULT 0;      -- still held while the request is in flight
ALTER TABLE ai_usage ADD COLUMN unknown_usd REAL NOT NULL DEFAULT 0;       -- held because billing is unknown (timeout, abandoned)
ALTER TABLE ai_usage ADD COLUMN expires_at INTEGER;                        -- after this an unsettled reservation is treated as abandoned
ALTER TABLE ai_usage ADD COLUMN cred_fp TEXT;                              -- fingerprint of credential+endpoint (never the secret)
UPDATE ai_usage SET request_uid = 'legacy-' || id,
  billing = CASE WHEN usage_source = 'provider' THEN 'reported' WHEN outcome IN ('ok','invalid_output','truncated') THEN 'estimated' ELSE 'none_reported' END;
CREATE UNIQUE INDEX ai_usage_uid ON ai_usage(request_uid);
CREATE INDEX ai_usage_status ON ai_usage(status);
