-- R2 objects whose submission row is already deleted but whose R2 delete
-- failed (R2 unavailable). Every housekeeping run retries them first, so an
-- erasure request finishes promptly; the admin API reports how many are left.
CREATE TABLE pending_deletes (
  r2_key     TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL
);

-- Retention runs in steps that each fit a request's budget; this is the next
-- step (0 = start). A partly done clean-up continues on the next run.
INSERT OR IGNORE INTO state (key, value) VALUES ('retention_step', '0');
