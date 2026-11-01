-- A grace period starts when maintenance first observes no usable guest session.
-- No content or contact information is stored here. Kept in backups so a restart
-- or restore cannot silently reset the retention clock.
CREATE TABLE guest_expiry (
  user_id TEXT PRIMARY KEY,
  unreachable_since TIMESTAMPTZ NOT NULL
);
CREATE INDEX guest_expiry_since ON guest_expiry (unreachable_since);
