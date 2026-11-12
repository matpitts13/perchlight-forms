-- Expired submissions whose R2 files couldn't be deleted. They're kept (so
-- no file is left without its row) and retried one by one, at most hourly,
-- while newer expired submissions are cleaned up past them.
CREATE TABLE retention_waiting (
  submission_id TEXT PRIMARY KEY REFERENCES submissions (id) ON DELETE CASCADE,
  since_ms      INTEGER NOT NULL,
  retry_after   INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX retention_waiting_retry ON retention_waiting (retry_after);

-- The last retention problems (JSON: { step: { error, at } }) for GET /api/forms,
-- and how many times in a row the R2 sweep's current page has failed.
INSERT OR IGNORE INTO state (key, value) VALUES ('retention_errors', '{}'), ('r2_failures', '0');
