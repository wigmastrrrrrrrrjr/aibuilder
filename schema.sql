-- Shared schema: works on node:sqlite locally and Cloudflare D1.
-- BaaS tables (baas_<project>_<collection>) are created lazily at runtime:
--   CREATE TABLE IF NOT EXISTS baas_{proj}_{coll} (
--     id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL
--   );

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  model       TEXT,
  published   INTEGER NOT NULL DEFAULT 0,
  slug        TEXT,
  description TEXT NOT NULL DEFAULT '',
  owner       TEXT NOT NULL DEFAULT '',
  plan        TEXT
);

CREATE TABLE IF NOT EXISTS files (
  project_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  content    TEXT NOT NULL,
  encoding   TEXT NOT NULL DEFAULT 'utf8',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, path)
);

CREATE TABLE IF NOT EXISTS messages (
  project_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_project ON messages (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_files_project    ON files (project_id);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  phash      TEXT NOT NULL,
  email      TEXT NOT NULL DEFAULT '',
  verified   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ip         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exp     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  name  TEXT NOT NULL,
  day   TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, day)
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Multiplayer / chat event log (append-only, per-project rooms)
CREATE TABLE IF NOT EXISTS events (
  seq  INTEGER PRIMARY KEY AUTOINCREMENT,
  pid  TEXT NOT NULL,
  room TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_room ON events (pid, room, seq);

-- Per-file revision history (append-only). content NULL marks a deletion
-- tombstone so deleted files can be restored. Newest revision is always the
-- live content in `files`. Pruned to the latest N revisions per file.
CREATE TABLE IF NOT EXISTS file_versions (
  project_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  content    TEXT,
  encoding   TEXT NOT NULL DEFAULT 'utf8',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, path, seq)
);
CREATE INDEX IF NOT EXISTS idx_file_versions ON file_versions (project_id, path, seq);

-- Project snapshots (point-in-time captures of every file). Auto-created at
-- the end of each generation; lets users roll back to any prior state.
CREATE TABLE IF NOT EXISTS snapshots (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  label      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots (project_id, created_at);

CREATE TABLE IF NOT EXISTS snapshot_files (
  snapshot_id TEXT NOT NULL,
  path        TEXT NOT NULL,
  content     TEXT NOT NULL,
  encoding    TEXT NOT NULL DEFAULT 'utf8',
  PRIMARY KEY (snapshot_id, path)
);
