-- perchlight-forms: submissions, their files and notifications, and counters.
-- Times shown in the desktop app are "YYYY-MM-DD HH:MM:SS" UTC text (like
-- datetime('now')); times the Worker only compares are Unix milliseconds.

-- status: new | read | archived (the inbox) or spam.
-- data: JSON of the configured fields. extra: JSON of fields not in the
-- config (kept and flagged), or NULL. No IP addresses, user agents or cookies.
CREATE TABLE submissions (
  id              TEXT PRIMARY KEY,
  form_id         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  created_ms      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'archived', 'spam')),
  spam_reasons    TEXT,
  data            TEXT NOT NULL,
  extra           TEXT,
  summary         TEXT NOT NULL DEFAULT '',
  reply_email     TEXT,
  content_hash    TEXT NOT NULL,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  origin          TEXT,
  turnstile       TEXT NOT NULL DEFAULT 'off' CHECK (turnstile IN ('passed', 'off', 'unverified')),
  seconds_on_page REAL,
  consent_at      TEXT,
  consent_version TEXT
);
CREATE INDEX submissions_form_status_time ON submissions (form_id, status, created_ms);
CREATE INDEX submissions_time ON submissions (created_ms);
CREATE INDEX submissions_reply_email ON submissions (reply_email);
CREATE INDEX submissions_hash_time ON submissions (content_hash, created_ms);

-- Attachments. The bytes are in R2 (never public) under r2_key; the original
-- name is kept only here.
CREATE TABLE files (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
  field         TEXT NOT NULL,
  name          TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  r2_key        TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL
);
CREATE INDEX files_submission ON files (submission_id);

-- One row per notification channel per submission. UNIQUE (submission_id,
-- channel) plus claiming a row with a conditional update before sending is
-- what makes "once per submission" hold when two sends overlap.
-- channel: email:<your address> | webhook:<name> | autoreply
CREATE TABLE deliveries (
  id              TEXT PRIMARY KEY,
  submission_id   TEXT NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'failed', 'unknown', 'skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  claimed_at      INTEGER,
  created_ms      INTEGER NOT NULL,
  sent_at         TEXT,
  last_error      TEXT,
  UNIQUE (submission_id, channel)
);
CREATE INDEX deliveries_due ON deliveries (status, next_attempt_at);

-- Rate limit: a hash whose key changes every day, never an IP. Kept 48 hours.
CREATE TABLE rate_counters (
  key   TEXT NOT NULL,
  hour  TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, hour)
);

-- Per UTC day and form. kind: ok | spam | spam_dropped | rate_limited |
-- invalid | duplicate | autoreply. form_id '*' kind 'spam_cap' is the
-- deployment-wide count of stored spam (SPAM_DAILY_CAP).
CREATE TABLE daily_counts (
  day     TEXT NOT NULL,
  form_id TEXT NOT NULL,
  kind    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, form_id, kind)
);

-- Auto-replies: at most one per address per 24 hours (by keyed hash). Kept 2 days.
CREATE TABLE autoreply_sent (
  email_hash TEXT PRIMARY KEY,
  sent_ms    INTEGER NOT NULL
);

-- Housekeeping state (there is no cron trigger; see docs/adr/0001):
-- last_run / last_retention (Unix ms) and r2_cursor.
CREATE TABLE state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO state (key, value) VALUES ('last_run', '0'), ('last_retention', '0'), ('r2_cursor', '');
