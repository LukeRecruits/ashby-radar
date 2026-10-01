-- Make "stalling" mean a stalled role, and make long_open mean something.
--
-- Two faults, one cause. `long_open` fires for a company with any role published 120+ days
-- ago that is still open, and it fired for 2,521 of 4,167 active boards: 60% of the
-- directory, which carries no information. Worse, some of those are not stale roles at
-- all. Blockstream's oldest "stalled" role is "Don't see an open position that fits? Apply
-- Here!", live for 1,806 days, which is a pipeline form rather than a vacancy nobody can
-- fill.
--
-- Measured on today's data, before changing anything:
--
--   15,233 open roles are 120+ days old, across 2,526 companies
--      332 of those roles are evergreen postings
--      105 companies have NOTHING BUT evergreen postings as their stale evidence
--
-- So 105 companies are currently being flagged as struggling to hire on the evidence of a
-- form that invites speculative applications. That is a false claim to open a conversation
-- with, and the conversation is the whole point of the signal.
--
-- Two changes, in the order they matter:
--
--   1. An evergreen posting is not a stale role, anywhere. One definition, used by the
--      rule and by every view, because this project has twice had the same quantity
--      defined in two places and watched them drift (locations in 0008/0009, remote_share
--      in 0011).
--   2. A floor under the rule: three or more genuinely stale roles AND five to fifty open
--      roles in total. The band is the one CandidHQ sells into, and three stale roles is
--      a pattern where one is an accident. That takes it from 2,521 companies to 1,131.

-- 1. What an evergreen posting looks like -------------------------------------
--
-- Built from the data rather than from imagination: the regex was written against the
-- actual stale titles on the board and then every title it matches was read back. All 332
-- matches are genuine pipeline postings, and the handful that look borderline
-- ("Account Executive (Future Opportunities)") are pipelines too, which is why the
-- parenthesised forms are matched rather than only the bare ones.
--
-- Precision over recall, deliberately. A false positive here silences a real signal, so
-- the patterns are the phrases that only ever appear on a pipeline posting. A few
-- evergreen postings with idiosyncratic titles will slip through and be counted as stale;
-- the floor of three absorbs that.

create function public.is_evergreen_posting(p_title text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  -- The parentheses round the pattern are load bearing: `~*` binds tighter than `||`, so
  -- without them this reads as (title ~* first_chunk) || the_rest, which is a boolean
  -- concatenated with text.
  select coalesce(
    p_title ~* (
      '(general|open|spontaneous|speculative|future)\s+(application|applications|opportunities|roles?|positions?)'
      || '|don.?t see|didn.?t see|can.?t find|apply here'
      || '|talent (pool|community|network|pipeline)'
      || '|general (interest|enquiry|inquiry)|keep in touch'
      || '|other (roles|opportunities)|join (our )?talent'
      || '|future (opportunit|openings)'
    ),
    false
  );
$$;

revoke all on function public.is_evergreen_posting(text) from public, anon, authenticated;

-- Stored on the row rather than evaluated on every read. `lead_list` is read on every page
-- of the console and a regex across 64,827 open titles per read is a cost paid thousands
-- of times for an answer that changes only when a job is written.
alter table public.jobs
  add column is_evergreen boolean
    generated always as (public.is_evergreen_posting(title)) stored;

create index jobs_stale_idx on public.jobs (company_id, published_at)
  where closed_at is null and not is_evergreen;

-- 2. The views, using the one definition --------------------------------------
--
-- `create or replace` rather than drop and recreate, because `work_queue` depends on
-- `lead_list` and dropping it would take the queue with it. Replacing in place keeps the
-- grants too, which is one fewer thing to get wrong after 0012.

create or replace view public.lead_roles as
select
  j.company_id,
  j.ashby_job_id,
  j.title,
  j.department,
  j.team,
  j.location,
  j.address_country,
  j.address_locality,
  j.workplace_type,
  j.employment_type,
  j.has_compensation,
  j.published_at,
  (current_date - j.published_at::date) as age_days,
  j.ashby_job_url,
  j.first_seen_at,
  j.is_evergreen
from public.jobs j
where j.closed_at is null;

-- `oldest_open_role_at` excludes evergreen postings too. It is printed on the company page
-- as "Oldest open role", and 1,806 days of an application form is the same false claim in
-- a different box.
create or replace view public.lead_list as
with latest_snapshot as (
  select distinct on (s.company_id)
    s.company_id, s.snapshot_date, s.open_role_count, s.recruiter_role_count, s.comp_published_count
  from public.snapshots s
  order by s.company_id, s.snapshot_date desc
), baseline_snapshot as (
  select distinct on (s.company_id) s.company_id, s.open_role_count
  from public.snapshots s
  where s.snapshot_date <= (current_date - 30)
  order by s.company_id, s.snapshot_date desc
), open_roles as (
  select
    j.company_id,
    count(*) filter (
      where j.published_at < (now() - '120 days'::interval) and not j.is_evergreen
    ) as stale_roles_120,
    count(*) filter (
      where j.published_at < (now() - '180 days'::interval) and not j.is_evergreen
    ) as stale_roles_180,
    min(j.published_at) filter (where not j.is_evergreen) as oldest_open_role_at
  from public.jobs j
  where j.closed_at is null
  group by j.company_id
), signals as (
  select
    t.company_id,
    count(distinct t.type) as signal_count,
    max(t.fired_at) filter (where t.type = 'new_to_ashby')    as new_to_ashby_at,
    max(t.fired_at) filter (where t.type = 'hiring_spike')    as hiring_spike_at,
    max(t.fired_at) filter (where t.type = 'first_recruiter') as first_recruiter_at,
    max(t.fired_at) filter (where t.type = 'sweet_spot')      as sweet_spot_at,
    max(t.fired_at) filter (where t.type = 'long_open')       as long_open_at,
    max(t.fired_at) filter (where t.type = 'publishes_comp')  as publishes_comp_at
  from public.triggers t
  group by t.company_id
)
select
  c.id,
  c.board_name,
  c.display_name,
  coalesce(c.display_name, c.board_name) as label,
  'https://jobs.ashbyhq.com/' || c.board_name as board_url,
  c.status,
  c.domain,
  c.domain_confidence,
  c.domain_source,
  c.top_country,
  c.top_locality,
  c.remote_share,
  c.discovered_via,
  c.first_seen_at,
  c.last_checked_at,
  c.last_active_at,
  c.parked_at,
  c.parked_reason,
  c.exported_at,
  s.snapshot_date,
  coalesce(s.open_role_count, 0)      as open_roles,
  coalesce(s.recruiter_role_count, 0) as recruiter_roles,
  coalesce(s.comp_published_count, 0) as roles_with_pay,
  b.open_role_count                   as open_roles_30d_ago,
  s.open_role_count - b.open_role_count as open_roles_change_30d,
  coalesce(o.stale_roles_120, 0::bigint) as stale_roles_120,
  coalesce(o.stale_roles_180, 0::bigint) as stale_roles_180,
  o.oldest_open_role_at,
  coalesce(g.signal_count, 0::bigint) as signal_count,
  g.new_to_ashby_at,
  g.hiring_spike_at,
  g.first_recruiter_at,
  g.sweet_spot_at,
  g.long_open_at,
  g.publishes_comp_at,
  case
    when coalesce(s.open_role_count, 0) = 0 then 'none'
    when s.open_role_count between 1 and 4  then 'small'
    when s.open_role_count between 5 and 50 then 'target'
    else 'large'
  end as role_band,
  coalesce(s.recruiter_role_count, 0) > 0 as has_in_house_ta,
  coalesce(s.comp_published_count, 0) > 0 as publishes_pay,
  c.status = 'active' and c.domain is not null and c.parked_at is null as is_prospect
from public.companies c
left join latest_snapshot s on s.company_id = c.id
left join baseline_snapshot b on b.company_id = c.id
left join open_roles o on o.company_id = c.id
left join signals g on g.company_id = c.id;

-- The four breakdowns keep their repeated from-clause, which is load bearing: sharing one
-- CTE here was 25 times slower, because a CTE is an optimisation fence and the company_id
-- predicate could not push down into it. See 0011.
create or replace view public.lead_role_groups as
select
  j.company_id,
  'department'::text as kind,
  coalesce(j.department, 'Not stated') as value,
  count(*)::int as roles,
  count(*) filter (where j.published_at < (now() - '120 days'::interval) and not j.is_evergreen)::int as stale_roles,
  count(*) filter (where j.has_compensation)::int as roles_with_pay
from public.jobs j
where j.closed_at is null
group by j.company_id, coalesce(j.department, 'Not stated')
union all
select
  j.company_id,
  'city'::text,
  coalesce(j.address_locality, 'Not stated'),
  count(*)::int,
  count(*) filter (where j.published_at < (now() - '120 days'::interval) and not j.is_evergreen)::int,
  count(*) filter (where j.has_compensation)::int
from public.jobs j
where j.closed_at is null
group by j.company_id, coalesce(j.address_locality, 'Not stated')
union all
select
  j.company_id,
  'country'::text,
  coalesce(j.address_country, 'Not stated'),
  count(*)::int,
  count(*) filter (where j.published_at < (now() - '120 days'::interval) and not j.is_evergreen)::int,
  count(*) filter (where j.has_compensation)::int
from public.jobs j
where j.closed_at is null
group by j.company_id, coalesce(j.address_country, 'Not stated')
union all
select
  j.company_id,
  'workplace'::text,
  coalesce(j.workplace_type, 'Not stated'),
  count(*)::int,
  count(*) filter (where j.published_at < (now() - '120 days'::interval) and not j.is_evergreen)::int,
  count(*) filter (where j.has_compensation)::int
from public.jobs j
where j.closed_at is null
group by j.company_id, coalesce(j.workplace_type, 'Not stated');

-- 3. The rule, with a floor ---------------------------------------------------
--
-- The old four-argument signature is dropped rather than left beside the new one, so
-- there is no version of this rule that can be called without a floor.
--
-- Both halves of the floor are parameters, like every other threshold in 0005, and both
-- are passed from src/config.ts. The band is the same 5-50 the sweet_spot rule uses and
-- is deliberately the same numbers, because it is the same claim about who CandidHQ is
-- for.

drop function public.candidates_long_open(date, int, int, int);

create function public.candidates_long_open(
  p_run_date          date,
  p_min_age_days      int,
  p_min_stale_roles   int,
  p_min_open_roles    int,
  p_max_open_roles    int,
  p_max_evidence_jobs int,
  p_dedupe_days       int
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
      and not j.is_evergreen
      and j.published_at < p_run_date::timestamptz - make_interval(days => p_min_age_days)
    group by j.company_id
    having count(*) >= p_min_stale_roles
  )
  select
    c.id,
    jsonb_build_object(
      'openRoles', s.open_role_count,
      'staleRoles', st.stale_count,
      'oldestDays', st.oldest_days,
      'minAgeDays', p_min_age_days,
      'minStaleRoles', p_min_stale_roles,
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
        and not sj.is_evergreen
        and sj.published_at < p_run_date::timestamptz - make_interval(days => p_min_age_days)
      order by sj.published_at
      limit p_max_evidence_jobs
    ) x
  ) j on true
  where s.open_role_count between p_min_open_roles and p_max_open_roles
    and not exists (
      select 1 from public.triggers t
      where t.company_id = c.id
        and t.type = 'long_open'
        and t.fired_at > now() - make_interval(days => p_dedupe_days)
    );
$$;

revoke all on function public.candidates_long_open(date, int, int, int, int, int, int)
  from public, anon, authenticated;
grant execute on function public.candidates_long_open(date, int, int, int, int, int, int)
  to service_role;
