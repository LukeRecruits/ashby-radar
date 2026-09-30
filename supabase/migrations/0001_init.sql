-- Ashby Radar: initial schema.
-- All writes happen server-side with the service-role key. RLS is enabled with no
-- policies so anon/authenticated clients are denied by default; phase 5 adds a
-- restricted read-only role with explicit policies.

create extension if not exists pgcrypto;

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- companies -----------------------------------------------------------------
create table companies (
  id              uuid primary key default gen_random_uuid(),
  source          text        not null default 'ashby',
  board_name      text        not null,
  display_name    text,
  domain          text,
  status          text        not null default 'unverified'
                    check (status in ('unverified', 'active', 'inactive', 'not_found')),
  discovered_via  text,
  first_seen_at   timestamptz not null default now(),
  last_checked_at timestamptz,
  last_active_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint companies_source_board_name_key unique (source, board_name)
);

-- Board names are case-sensitive, so the unique constraint above is too. This index
-- exists purely to find near-duplicates that differ only by case.
create index companies_board_name_lower_idx on companies (source, lower(board_name));
create index companies_status_idx on companies (status);

create trigger companies_set_updated_at
  before update on companies
  for each row execute function set_updated_at();

-- jobs ----------------------------------------------------------------------
create table jobs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies (id),
  ashby_job_url    text not null unique,
  title            text,
  department       text,
  team             text,
  location         text,
  is_remote        boolean,
  workplace_type   text,
  employment_type  text,
  is_listed        boolean,
  published_at     timestamptz,
  has_compensation boolean     not null default false,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index jobs_company_id_idx on jobs (company_id);
-- Open jobs per company: the hot path for the daily diff and the trigger engine.
create index jobs_company_open_idx on jobs (company_id) where closed_at is null;
create index jobs_published_at_idx on jobs (published_at);

create trigger jobs_set_updated_at
  before update on jobs
  for each row execute function set_updated_at();

-- snapshots -----------------------------------------------------------------
create table snapshots (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references companies (id),
  snapshot_date        date not null,
  open_role_count      integer not null default 0,
  recruiter_role_count integer not null default 0,
  comp_published_count integer not null default 0,
  created_at           timestamptz not null default now(),
  constraint snapshots_company_date_key unique (company_id, snapshot_date)
);

create index snapshots_date_idx on snapshots (snapshot_date);

-- triggers ------------------------------------------------------------------
create table triggers (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid  not null references companies (id),
  type        text  not null check (type in (
                'new_to_ashby', 'hiring_spike', 'first_recruiter',
                'sweet_spot', 'long_open', 'publishes_comp')),
  fired_at    timestamptz not null default now(),
  evidence    jsonb not null default '{}'::jsonb,
  reviewed    boolean not null default false,
  exported_at timestamptz
);

-- Supports the "one per company per type per 30 days" check.
create index triggers_company_type_fired_idx on triggers (company_id, type, fired_at desc);
create index triggers_unexported_idx on triggers (fired_at) where exported_at is null;

-- runs ----------------------------------------------------------------------
create table runs (
  id          uuid primary key default gen_random_uuid(),
  workflow    text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  checked     integer not null default 0,
  succeeded   integer not null default 0,
  failed      integer not null default 0,
  notes       text
);

create index runs_workflow_started_idx on runs (workflow, started_at desc);

-- discovery_log -------------------------------------------------------------
-- One row per (board_name, discovered_via) rather than one per raw crawl hit.
-- A full Common Crawl sweep returns millions of URLs for a few thousand boards;
-- storing every hit buys nothing for coverage debugging and costs a lot of disk.
-- hit_count records how often the name was seen, source_url the first example.
create table discovery_log (
  id             bigserial primary key,
  board_name     text not null,
  source_url     text,
  discovered_via text not null,
  hit_count      integer not null default 1,
  found_at       timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  constraint discovery_log_name_via_key unique (board_name, discovered_via)
);

create index discovery_log_board_name_idx on discovery_log (board_name);

-- Lock everything down by default ------------------------------------------
alter table companies     enable row level security;
alter table jobs          enable row level security;
alter table snapshots     enable row level security;
alter table triggers      enable row level security;
alter table runs          enable row level security;
alter table discovery_log enable row level security;
