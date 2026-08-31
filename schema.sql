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
  plan        TEXT,
  team_id     TEXT NOT NULL DEFAULT ''
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
  user       TEXT NOT NULL DEFAULT '',
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

-- ---- teambuild: collaborative teams ---------------------------------------
-- A team pools the daily credit grants of every member into one shared budget;
-- any member's generation spends from the pool. Invite codes let others join.
CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  owner       TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id   TEXT NOT NULL,
  name      TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, name)
);
CREATE INDEX IF NOT EXISTS idx_team_members ON team_members (team_id);

-- Credit exchange: one row per unique visitor per published project per day.
-- A new row earns the project owner +1 credit (see `earnings`).
CREATE TABLE IF NOT EXISTS interactions (
  project_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  key        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, day, key)
);

-- Lifetime interaction rewarer balance (integer units of 1/10 credit).
CREATE TABLE IF NOT EXISTS earnings (
  name  TEXT PRIMARY KEY,
  units INTEGER NOT NULL DEFAULT 0
);

-- Who is live on a project right now (server-side cap + roster).
-- Used to enforce the 10-collaborator concurrency limit per project.
CREATE TABLE IF NOT EXISTS presence (
  pid     TEXT NOT NULL,
  sid     TEXT NOT NULL,
  user    TEXT NOT NULL DEFAULT '',
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (pid, sid)
);

-- Community feature voting: proposed experimental aib features + votes.
-- One row per proposed feature; tally computed from feature_votes.
CREATE TABLE IF NOT EXISTS features (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'proposed',  -- proposed | planned | accepted | shipped | rejected
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_votes (
  feature_id TEXT NOT NULL,
  user       TEXT NOT NULL,
  vote       INTEGER NOT NULL,   -- 1 = up, -1 = down, 0 = cleared
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (feature_id, user)
);
CREATE INDEX IF NOT EXISTS idx_feature_votes ON feature_votes (feature_id);
