-- Kaggle terminal relay jobs (see src/kterm.js + terminald/kaggeld/agent.py).
-- Each row is one shell command the AI wants run on the Kaggle executor.
-- status: pending -> running -> done | abandoned (or left pending on relay busy).
-- `files` is the baseline project snapshot JSON sent to the agent so it can
-- materialize the project before running; `result_files` is the JSON map the
-- agent posts back, diffed against `files` to sync edits into app storage.
CREATE TABLE IF NOT EXISTS kterm_jobs (
  id           TEXT PRIMARY KEY,
  pid          TEXT NOT NULL,
  cmd          TEXT NOT NULL,
  cwd          TEXT NOT NULL DEFAULT '',
  timeout_ms   INTEGER NOT NULL DEFAULT 30000,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | abandoned
  output       TEXT,
  code         INTEGER,
  blocked      INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  agent        TEXT,
  files        TEXT,
  result_files TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kterm_pending ON kterm_jobs (status, created_at);