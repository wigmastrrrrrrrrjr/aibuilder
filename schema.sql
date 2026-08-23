-- Shared schema: works on node:sqlite locally and Cloudflare D1.
-- BaaS tables (baas_<project>_<collection>) are created lazily at runtime:
--   CREATE TABLE IF NOT EXISTS baas_{proj}_{coll} (
--     id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL
--   );

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  project_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  content    TEXT NOT NULL,
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
