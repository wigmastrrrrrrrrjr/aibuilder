-- ============================================================================
-- API v2 storage: schema + RLS + Realtime.
-- Run once in Supabase Dashboard -> SQL Editor.
--
-- Security model (learned the hard way):
--   * The worker is the ONLY writer. It talks through the service_role key,
--     which bypasses RLS.
--   * anon / authenticated (the published keys, incl. Realtime subscribers)
--     get READ-ONLY access to public surfaces only. Nothing else.
--   * v2_users / v2_sessions / v2_files / v2_credit_ledger are fully locked.
-- ============================================================================

begin;

-- ---- tables ----------------------------------------------------------------
create table if not exists public.v2_users (
  id uuid not null default gen_random_uuid() primary key,
  name text not null unique,
  phash text not null,
  email_sha text not null default '',
  ip_tag text not null default '',
  verified boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.v2_sessions (
  token text not null primary key,
  user_id uuid not null references public.v2_users(id) on delete cascade,
  exp bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists v2_sessions_user_idx on public.v2_sessions(user_id);

create table if not exists public.v2_projects (
  id uuid not null default gen_random_uuid() primary key,
  owner text not null,
  name text not null,
  description text not null default '',
  model text not null default '',
  plan text not null default 'free',
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists v2_projects_owner_idx on public.v2_projects(owner);
create index if not exists v2_projects_published_idx on public.v2_projects(published, updated_at desc);

create table if not exists public.v2_files (
  project_id uuid not null references public.v2_projects(id) on delete cascade,
  path text not null,
  content text not null default '',
  encoding text not null default 'utf-8',
  updated_at timestamptz not null default now(),
  primary key (project_id, path)
);
create index if not exists v2_files_project_idx on public.v2_files(project_id);

create table if not exists public.v2_messages (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.v2_projects(id) on delete cascade,
  seq bigint not null,
  role text not null default 'user',
  content text not null default '',
  t bigint not null default 0,
  unique (project_id, seq)
);
create index if not exists v2_messages_project_idx on public.v2_messages(project_id, seq);

-- public realtime chat rooms (like the legacy live capability, now durable)
create table if not exists public.v2_events (
  id bigint generated always as identity primary key,
  room text not null,
  type text not null default 'message',
  user text not null default 'anon',
  data jsonb not null default '{}'::jsonb,
  ts bigint not null default 0
);
create index if not exists v2_events_room_idx on public.v2_events(room, ts);

create table if not exists public.v2_credit_ledger (
  id bigint generated always as identity primary key,
  name text not null,
  day text not null,
  kind text not null,
  units bigint not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists v2_ledger_name_idx on public.v2_credit_ledger(name, day);

-- ---- RLS -------------------------------------------------------------------
alter table public.v2_users enable row level security;
alter table public.v2_sessions enable row level security;
alter table public.v2_projects enable row level security;
alter table public.v2_files enable row level security;
alter table public.v2_messages enable row level security;
alter table public.v2_events enable row level security;
alter table public.v2_credit_ledger enable row level security;

-- users / sessions / files / ledger: denied (service_role writes only)
drop policy if exists v2_users_all on public.v2_users;
drop policy if exists v2_sessions_all on public.v2_sessions;
drop policy if exists v2_files_all on public.v2_files;
drop policy if exists v2_ledger_all on public.v2_credit_ledger;

-- projects: anon/authenticated may read published projects (drives discover feed)
drop policy if exists v2_projects_read_published on public.v2_projects;
create policy v2_projects_read_published on public.v2_projects
  for select to anon, authenticated
  using (published = true);

-- messages: anon/authenticated may read chat for published projects only
drop policy if exists v2_messages_read_published on public.v2_messages;
create policy v2_messages_read_published on public.v2_messages
  for select to anon, authenticated
  using (exists (select 1 from public.v2_projects p where p.id = v2_messages.project_id and p.published = true));

-- events: public rooms, anyone may read + post to them (real-time chat surface)
drop policy if exists v2_events_select on public.v2_events;
create policy v2_events_select on public.v2_events
  for select to anon, authenticated using (true);
drop policy if exists v2_events_insert on public.v2_events;
create policy v2_events_insert on public.v2_events
  for insert to anon, authenticated with check (true);

-- PostgREST/Realtime need explicit grants (service_role is unaffected)
grant select on public.v2_projects to anon, authenticated;
grant select on public.v2_messages to anon, authenticated;
grant select, insert on public.v2_events to anon, authenticated;
grant usage, select on sequence public.v2_events_id_seq to anon, authenticated;

-- ---- Realtime --------------------------------------------------------------
-- Full replica identity so every realtime payload carries the full row.
alter table public.v2_projects replica identity full;
alter table public.v2_messages replica identity full;
alter table public.v2_events replica identity full;

-- Re-enable publishing (a prior lockdown may have set publish='').
alter publication supabase_realtime set (publish = 'insert, update, delete, truncate');

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'v2_events') then
    alter publication supabase_realtime add table public.v2_events;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'v2_messages') then
    alter publication supabase_realtime add table public.v2_messages;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'v2_projects') then
    alter publication supabase_realtime add table public.v2_projects;
  end if;
end $$;

commit;