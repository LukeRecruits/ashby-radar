-- Phase 3: the trigger engine.
--
-- Two things live here: a small settings table, and one candidate function per trigger
-- rule.
--
-- Why the rules are SQL rather than TypeScript. Each rule is a set comparison across
-- snapshots and jobs for every active company at once. Done in TypeScript it would be
-- several thousand round trips a day, or one enormous download of history that grows by
-- 4,000 rows every morning. Done here it is six queries. Every threshold is a function
-- parameter, never a literal, so src/config.ts stays the only place Luke tunes anything.
--
-- Every function returns the same shape: (company_id, evidence). The evidence is what
-- Luke reads to check a trigger in under ten seconds, so each one carries today's role
-- count plus whatever made the rule fire.
--
-- Every rule also applies the "one trigger per company per type per N days" rule itself,
-- via p_dedupe_days. Doing it here rather than in the caller means a rule can never fire
-- twice because two processes evaluated at once.

-- settings ------------------------------------------------------------------
-- Key/value state that is not about a company. Right now that is one key,
-- initial_backfill_completed_at, which stops new_to_ashby firing for all 5,731
-- discovered companies the first time the engine runs.
create table public.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.settings enable row level security;

create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

-- Helpers -------------------------------------------------------------------

-- The most recent snapshot at or before the baseline date, per company.
--
-- The rules that compare against "30 days ago" cannot demand a snapshot dated exactly
-- 30 days ago: one missed morning run would silence them for a day. The baseline is
-- instead the latest snapshot inside a window ending on the baseline date, so a gap
-- degrades the comparison slightly rather than dropping it.
create function public.baseline_snapshots(
  p_run_date date,
  p_lookback_days int,
  p_window_days int
)
returns table (company_id uuid, snapshot_date date, open_role_count int)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct on (s.company_id)
    s.company_id, s.snapshot_date, s.open_role_count
  from public.snapshots s
  where s.snapshot_date <= p_run_date - p_lookback_days
    and s.snapshot_date >= p_run_date - p_lookback_days - p_window_days
  order by s.company_id, s.snapshot_date desc;
$$;

-- Trigger 1: new_to_ashby ---------------------------------------------------
-- A company's first ever successful check, but only for companies discovered after the
-- initial backfill finished. A null marker returns nothing, which is what keeps the
-- first evaluation from firing this for every company we have ever seen.
create function public.candidates_new_to_ashby(
  p_run_date date,
  p_backfill_completed_at timestamptz,
  p_dedupe_days int
)
returns table (company_id uuid, evidence jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    jsonb_build_object(
      'openRoles', s.open_role_count,
      'firstSnapshot', s.snapshot_date,
      'firstSeenAt', c.first_seen_at,
      'discoveredVia', c.discovered_via
    )
  from public.companies c
  join public.snapshots s
    on s.company_id = c.id and s.snapshot_date = p_run_date
  where p_backfill_completed_at is not null
    and c.first_seen_at > p_backfill_completed_at
    and not exists (
      select 1 from public.snapshots earlier
      where earlier.company_id = c.id and earlier.snapshot_date < p_run_date
    )
    and not exists (
      select 1 from public.triggers t
      where t.company_id = c.id
        and t.type = 'new_to_ashby'
        and t.fired_at > now() - make_interval(days => p_dedupe_days)
    );
$$;

-- Trigger 2: hiring_spike ---------------------------------------------------
-- Open roles up p_min_increase or more against the baseline. Evidence names the jobs
-- that appeared since, which is the part Luke actually reads.
create function public.candidates_hiring_spike(
  p_run_date date,
  p_lookback_days int,
  p_window_days int,
  p_min_increase int,
  p_max_evidence_jobs int,
  p_dedupe_days int
)
returns table (company_id uuid, evidence jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  with baseline as (
    select * from public.baseline_snapshots(p_run_date, p_lookback_days, p_window_days)
  )
  select
    c.id,
    jsonb_build_object(
      'openRoles', s.open_role_count,
      'baselineOpenRoles', b.open_role_count,
      'baselineDate', b.snapshot_date,
      'increase', s.open_role_count - b.open_role_count,
      'newJobs', coalesce(j.jobs, '[]'::jsonb)
    )
  from public.companies c
  join public.snapshots s
    on s.company_id = c.id and s.snapshot_date = p_run_date
  join baseline b on b.company_id = c.id
  left join lateral (
    select jsonb_agg(
             jsonb_build_object('title', x.title, 'url', x.ashby_job_url)
             order by x.first_seen_at desc
           ) as jobs
    from (
      select nj.title, nj.ashby_job_url, nj.first_seen_at
      from public.jobs nj
      where nj.company_id = c.id
        and nj.closed_at is null
        and nj.first_seen_at > b.snapshot_date::timestamptz
      order by nj.first_seen_at desc
      limit p_max_evidence_jobs
    ) x
  ) j on true
  where s.open_role_count - b.open_role_count >= p_min_increase
    and not exists (
      select 1 from public.triggers t
      where t.company_id = c.id
        and t.type = 'hiring_spike'
        and t.fired_at > now() - make_interval(days => p_dedupe_days)
    );
$$;

-- Trigger 3: first_recruiter ------------------------------------------------
-- A recruiting hire appears where none existed in the previous p_lookback_days.
--
-- The test runs on snapshots.recruiter_role_count rather than matching job titles in
-- SQL. That count is written by the refresh using the one title pattern in
-- src/config.ts, so there is a single definition of what counts as a recruiting hire
-- and no second regex to drift. The caller attaches the matching job titles as
-- evidence using that same pattern.
--
-- The "exists an earlier snapshot" clause is what stops this firing for every company
-- with a recruiter on the board the day the history starts. Absence of a recruiter role
-- can only be evidence once we have watched the company for at least a day.
create function public.candidates_first_recruiter(
  p_run_date date,
  p_lookback_days int,
  p_dedupe_days int
)
returns table (company_id uuid, evidence jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    jsonb_build_object(
      'openRoles', s.open_role_count,
      'recruiterRoles', s.recruiter_role_count,
      'quietSince', (
        select min(h.snapshot_date) from public.snapshots h
        where h.company_id = c.id
          and h.snapshot_date < p_run_date
          and h.snapshot_date >= p_run_date - p_lookback_days
      )
    )
  from public.companies c
  join public.snapshots s
    on s.company_id = c.id and s.snapshot_date = p_run_date
  where s.recruiter_role_count > 0
    and exists (
      select 1 from public.snapshots earlier
      where earlier.company_id = c.id and earlier.snapshot_date < p_run_date
    )
    and not exists (
      select 1 from public.snapshots prior
      where prior.company_id = c.id
        and prior.snapshot_date < p_run_date
        and prior.snapshot_date >= p_run_date - p_lookback_days
        and prior.recruiter_role_count > 0
    )
    and not exists (
      select 1 from public.triggers t
      where t.company_id = c.id
        and t.type = 'first_recruiter'
        and t.fired_at > now() - make_interval(days => p_dedupe_days)
    );
$$;

-- Trigger 4: sweet_spot -----------------------------------------------------
-- Into the size band CandidHQ sells to, from outside it. Needs a baseline for the same
-- reason first_recruiter needs history: "wasn't in range then" is not a claim we can
-- make about a company we had not yet seen.
create function public.candidates_sweet_spot(
  p_run_date date,
  p_lookback_days int,
  p_window_days int,
  p_min_roles int,
  p_max_roles int,
  p_dedupe_days int
)
returns table (company_id uuid, evidence jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  with baseline as (
    select * from public.baseline_snapshots(p_run_date, p_lookback_days, p_window_days)
  )
  select
    c.id,
    jsonb_build_object(
      'openRoles', s.open_role_count,
      'baselineOpenRoles', b.open_role_count,
      'baselineDate', b.snapshot_date,
      'band', p_min_roles || '-' || p_max_roles
    )
  from public.companies c
  join public.snapshots s
    on s.company_id = c.id and s.snapshot_date = p_run_date
  join baseline b on b.company_id = c.id
  where s.open_role_count between p_min_roles and p_max_roles
    and b.open_role_count not between p_min_roles and p_max_roles
    and not exists (
      select 1 from public.triggers t
      where t.company_id = c.id
        and t.type = 'sweet_spot'
        and t.fired_at > now() - make_interval(days => p_dedupe_days)
    );
$$;

-- Trigger 5: long_open ------------------------------------------------------
-- A role published p_min_age_days ago or more that is still open. published_at comes
-- from Ashby, not from our own history, so this one is true on day one and needs no
-- warm-up. That also makes it the loudest rule by far: on the first evaluation roughly
-- three quarters of active boards qualify.
create function public.candidates_long_open(
  p_run_date date,
  p_min_age_days int,
  p_max_evidence_jobs int,
  p_dedupe_days int
)
returns table (company_id uuid, evidence jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  with stale as (
    select
      j.company_id,
      count(*) as stale_count,
      max((p_run_date - j.published_at::date)) as oldest_days
    from public.jobs j
    where j.closed_at is null
      and j.published_at is not null
      and j.published_at < p_run_date::timestamptz - make_interval(days => p_min_age_days)
    group by j.company_id
  )
  select
    c.id,
    jsonb_build_object(
      'openRoles', s.open_role_count,
      'staleRoles', st.stale_count,
      'oldestDays', st.oldest_days,
      'minAgeDays', p_min_age_days,
      'jobs', coalesce(j.jobs, '[]'::jsonb)
    )
  from public.companies c
  join public.snapshots s
    on s.company_id = c.id and s.snapshot_date = p_run_date
  join stale st on st.company_id = c.id
  left join lateral (
    select jsonb_agg(
             jsonb_build_object(
               'title', x.title,
               'url', x.ashby_job_url,
               'ageDays', p_run_date - x.published_at::date
             )
             order by x.published_at
           ) as jobs
    from (
      select sj.title, sj.ashby_job_url, sj.published_at
      from public.jobs sj
      where sj.company_id = c.id
        and sj.closed_at is null
        and sj.published_at is not null
        and sj.published_at < p_run_date::timestamptz - make_interval(days => p_min_age_days)
      order by sj.published_at
      limit p_max_evidence_jobs
    ) x
  ) j on true
  where not exists (
    select 1 from public.triggers t
    where t.company_id = c.id
      and t.type = 'long_open'
      and t.fired_at > now() - make_interval(days => p_dedupe_days)
  );
$$;

-- Trigger 6: publishes_comp -------------------------------------------------
-- The company shows pay on a job for the first time. Like first_recruiter, "first"
-- can only mean first in our history, so an earlier snapshot has to exist.
create function public.candidates_publishes_comp(
  p_run_date date,
  p_max_evidence_jobs int,
  p_dedupe_days int
)
returns table (company_id uuid, evidence jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    jsonb_build_object(
      'openRoles', s.open_role_count,
      'compRoles', s.comp_published_count,
      'jobs', coalesce(j.jobs, '[]'::jsonb)
    )
  from public.companies c
  join public.snapshots s
    on s.company_id = c.id and s.snapshot_date = p_run_date
  left join lateral (
    select jsonb_agg(
             jsonb_build_object('title', x.title, 'url', x.ashby_job_url)
             order by x.published_at desc
           ) as jobs
    from (
      select cj.title, cj.ashby_job_url, cj.published_at
      from public.jobs cj
      where cj.company_id = c.id
        and cj.closed_at is null
        and cj.has_compensation
      order by cj.published_at desc nulls last
      limit p_max_evidence_jobs
    ) x
  ) j on true
  where s.comp_published_count > 0
    and exists (
      select 1 from public.snapshots earlier
      where earlier.company_id = c.id and earlier.snapshot_date < p_run_date
    )
    and not exists (
      select 1 from public.snapshots prior
      where prior.company_id = c.id
        and prior.snapshot_date < p_run_date
        and prior.comp_published_count > 0
    )
    and not exists (
      select 1 from public.triggers t
      where t.company_id = c.id
        and t.type = 'publishes_comp'
        and t.fired_at > now() - make_interval(days => p_dedupe_days)
    );
$$;

-- Indexes the rules lean on ------------------------------------------------
-- Every rule does "this company's snapshots before today" or "this company's open jobs
-- by publish date". Both are per-company lookups the existing indexes do not cover.
create index snapshots_company_date_desc_idx on public.snapshots (company_id, snapshot_date desc);
create index jobs_company_published_open_idx on public.jobs (company_id, published_at)
  where closed_at is null;
