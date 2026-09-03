-- Supabase Postgres schema for aibuilder API (ported from D1/SQLite).
-- Run via Supabase SQL Editor or REST SQL endpoint.

-- =========================================================================
-- Core tables
-- =========================================================================

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
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
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (project_id, path)
);

CREATE TABLE IF NOT EXISTS messages (
  project_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  "user"     TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_files_project    ON files (project_id);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  phash      TEXT NOT NULL,
  email      TEXT NOT NULL DEFAULT '',
  verified   INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  ip         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exp     BIGINT NOT NULL
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

-- =========================================================================
-- Multiplayer / chat event log
-- =========================================================================

CREATE TABLE IF NOT EXISTS events (
  seq  SERIAL PRIMARY KEY,
  pid  TEXT NOT NULL,
  room TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_room ON events (pid, room, seq);

-- =========================================================================
-- File version history
-- =========================================================================

CREATE TABLE IF NOT EXISTS file_versions (
  project_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  content    TEXT,
  encoding   TEXT NOT NULL DEFAULT 'utf8',
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (project_id, path, seq)
);
CREATE INDEX IF NOT EXISTS idx_file_versions ON file_versions (project_id, path, seq);

-- =========================================================================
-- Snapshots
-- =========================================================================

CREATE TABLE IF NOT EXISTS snapshots (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
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

-- =========================================================================
-- Teams
-- =========================================================================

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  owner       TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id   TEXT NOT NULL,
  name      TEXT NOT NULL,
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (team_id, name)
);
CREATE INDEX IF NOT EXISTS idx_team_members ON team_members (team_id);

-- =========================================================================
-- Credit exchange
-- =========================================================================

CREATE TABLE IF NOT EXISTS interactions (
  project_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  key        TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (project_id, day, key)
);

CREATE TABLE IF NOT EXISTS earnings (
  name  TEXT PRIMARY KEY,
  units INTEGER NOT NULL DEFAULT 0
);

-- =========================================================================
-- Presence
-- =========================================================================

CREATE TABLE IF NOT EXISTS presence (
  pid     TEXT NOT NULL,
  sid     TEXT NOT NULL,
  "user"  TEXT NOT NULL DEFAULT '',
  seen_at BIGINT NOT NULL,
  PRIMARY KEY (pid, sid)
);

-- =========================================================================
-- Feature voting
-- =========================================================================

CREATE TABLE IF NOT EXISTS features (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'proposed',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_votes (
  feature_id TEXT NOT NULL,
  "user"     TEXT NOT NULL,
  vote       INTEGER NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (feature_id, "user")
);
CREATE INDEX IF NOT EXISTS idx_feature_votes ON feature_votes (feature_id);

-- =========================================================================
-- BaaS (generic document store — replaces dynamic table creation)
-- =========================================================================

CREATE TABLE IF NOT EXISTS baas_data (
  project_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  row_id     TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (project_id, collection, row_id)
);
CREATE INDEX IF NOT EXISTS idx_baas_data ON baas_data (project_id, collection);

-- =========================================================================
-- RPC functions for atomic upserts
-- =========================================================================

-- Atomic usage increment (upsert + return new count)
CREATE OR REPLACE FUNCTION increment_usage(p_name text, p_day text, p_amount int)
RETURNS int AS $$
DECLARE
  new_count int;
BEGIN
  INSERT INTO usage (name, day, count) VALUES (p_name, p_day, p_amount)
  ON CONFLICT (name, day) DO UPDATE SET count = usage.count + p_amount
  RETURNING count INTO new_count;
  RETURN new_count;
END;
$$ LANGUAGE plpgsql;

-- Atomic earnings increment
CREATE OR REPLACE FUNCTION increment_earnings(p_name text, p_units int)
RETURNS void AS $$
BEGIN
  INSERT INTO earnings (name, units) VALUES (p_name, p_units)
  ON CONFLICT (name) DO UPDATE SET units = earnings.units + EXCLUDED.units;
END;
$$ LANGUAGE plpgsql;

-- Atomic earnings spend (clamped to 0)
CREATE OR REPLACE FUNCTION spend_earnings(p_name text, p_units int)
RETURNS int AS $$
DECLARE
  new_units int;
BEGIN
  UPDATE earnings SET units = GREATEST(0, units - p_units) WHERE name = p_name
  RETURNING units INTO new_units;
  RETURN COALESCE(new_units, 0);
END;
$$ LANGUAGE plpgsql;

-- Auto-create updated_at trigger for projects
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
