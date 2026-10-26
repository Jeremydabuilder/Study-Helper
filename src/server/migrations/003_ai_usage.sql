-- Per-HTTP-request AI accounting (a repair retry is its own row) + which model graded an attempt.
ALTER TABLE ai_usage ADD COLUMN provider TEXT;
ALTER TABLE ai_usage ADD COLUMN model TEXT;
ALTER TABLE ai_usage ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_usage ADD COLUMN outcome TEXT;            -- ok | invalid_output | truncated | <error code>
ALTER TABLE ai_usage ADD COLUMN input_tokens INTEGER;
ALTER TABLE ai_usage ADD COLUMN output_tokens INTEGER;
ALTER TABLE ai_usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN usage_source TEXT;       -- provider | estimated | none
ALTER TABLE ai_usage ADD COLUMN est_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN price_known INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_usage ADD COLUMN stop_reason TEXT;
ALTER TABLE ai_usage ADD COLUMN request_id TEXT;
CREATE INDEX ai_usage_ts ON ai_usage(ts);
ALTER TABLE attempts ADD COLUMN grade_model TEXT;
