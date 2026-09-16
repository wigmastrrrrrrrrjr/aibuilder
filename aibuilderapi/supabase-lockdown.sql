-- Supabase security lockdown — project trwxpgmkpaddnyktbleg
-- ===========================================================
-- Run this in: Supabase Dashboard -> SQL Editor -> New query -> Run.
--
-- Why it's safe for aibuilder: the app only uses this project for Supabase
-- Realtime BROADCAST channels (chat.js + live.js server broadcasts, SDK
-- subscriptions). Broadcast does NOT require any table access or RLS
-- policies, so locking everything down does not break realtime. All durable
-- data lives in the worker's D1 database, not here.
--
-- What it fixes (Advisor findings 06 Sep 2026):
--   * rls_disabled_in_public       — RLS was OFF on public tables
--   * sensitive_columns_exposed    — users.phash (password hashes), email, ip
--                                    readable/editable/deletable by anyone
--     (confirmed with the anon key: users, messages, events, presence,
--      teams, files were all exposed via the public REST API)
BEGIN;

-- 0) Hard wipe: this project is legacy — the app now stores everything in D1
--    (IPs as HMAC tags, emails as sha256 digests). Nothing here should have data.
DELETE FROM public.users;
DELETE FROM public.sessions;
DELETE FROM public.projects;
DELETE FROM public.messages;
DELETE FROM public.events;
DELETE FROM public.presence;
DELETE FROM public.teams;
DELETE FROM public.files;

-- 1) Enable RLS on every public table.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tablename);
  END LOOP;
END $$;

-- 2) Drop the default permissive policies Supabase generated on creation.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I;', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- 3) Remove ALL table/sequence access from the public and signed-in roles.
REVOKE ALL ON ALL TABLES   IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- 4) The worker's service_role keeps full access (bypasses RLS by design —
--    it is the only role that should ever touch this project's tables).
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- 5) Stop Realtime from replicating row data; only broadcast channels remain.
ALTER PUBLICATION supabase_realtime SET (publish = '');

COMMIT;