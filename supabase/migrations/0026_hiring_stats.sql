-- 0026: three numbers per company, from data Radar already holds or can buy cheaply.
--
--   * Recruiter load: open roles per recruiter on the team the people sweep found.
--   * How long an ad stays up, and how often a role comes back after it came down.
--   * Headcount and funding, from one Exa company search per in-band prospect.
--
-- A closed job is not a filled job. Measured on 2026-11-12 over 3,000 sampled closures:
-- 20% (Ashby) to 26% (Greenhouse) of jobs that "closed" had the same title reappear at
-- the same company under a new id within three days. That is an advert being reposted,
-- not a role being filled, and counting it would halve every company's apparent
-- time-to-fill. Those are counted as swaps and left out of everything else.
--
-- What survives is still "the advert came down", which can mean hired, paused or
-- cancelled. The console says "days live", not "time to hire".
--
-- A real closure followed by the same title 3 to 60 days later is a repost: most often a
-- hire that fell through or a search restarted. That is the number worth a conversation.

-- 1. Title matching, indexed --------------------------------------------------------

-- Applied by hand on 2026-11-12 before this file, to time the query; kept for the record.
create index if not exists jobs_company_title_seen_idx
  on public.jobs (company_id, (lower(regexp_replace(title, '\s+', ' ', 'g'))), first_seen_at);

-- Whether a person's title is a recruiting one, as opposed to HR, people ops or L&D.
-- Written against the 16,219 titles the sweep had stored on 2026-11-12. "Talent" alone
-- is too broad: Talent Development and Talent Management are learning roles.
create function public.is_recruiting_title(p_title text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_title ~* '(recruit|talent acquisition|\mta\M|sourc|talent (partner|lead|manager|advisor|specialist|consultant|coordinator|attraction|operations|ops|director|officer|business partner)|(head|director|vp|vice president|chief) (of )?talent|talent$)'
    and p_title !~* 'talent (development|management|enablement|programs?|engineer|success|solutions)',
    false);
$$;

-- 2. Job outcomes, recomputed daily -------------------------------------------------

create table public.company_job_outcomes (
  company_id       uuid primary key references public.companies (id) on delete cascade,
  computed_at      timestamptz not null default now(),
  window_days      int not null,
  closed_count     int not null,
  swap_count       int not null,
  repost_count     int not null,
  median_days_live numeric
);

alter table public.company_job_outcomes enable row level security;

comment on table public.company_job_outcomes is
  'Per company, over the last window_days: adverts that came down (excluding same-title swaps), swaps, reposts, and the median days an advert was live. Rebuilt whole by refresh_job_outcomes().';

-- Rebuilt whole every morning by the triggers run. About four seconds over 85,000
-- closures. Evergreen postings are excluded, as everywhere else.
create function public.refresh_job_outcomes(p_window_days int, p_swap_days int, p_repost_days int)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows int;
begin
  delete from public.company_job_outcomes where true;

  with c as (
    select j.id, j.company_id, j.closed_at, j.published_at,
           lower(regexp_replace(j.title, '\s+', ' ', 'g')) as t
      from public.jobs j
     where j.closed_at > now() - make_interval(days => p_window_days)
       and not j.is_evergreen
  ),
  k as (
    select c.*,
           exists (
             select 1 from public.jobs o
              where o.company_id = c.company_id
                and lower(regexp_replace(o.title, '\s+', ' ', 'g')) = c.t
                and o.id <> c.id
                and o.first_seen_at between c.closed_at - make_interval(days => p_swap_days)
                                        and c.closed_at + make_interval(days => p_swap_days)
           ) as swapped,
           exists (
             select 1 from public.jobs o
              where o.company_id = c.company_id
                and lower(regexp_replace(o.title, '\s+', ' ', 'g')) = c.t
                and o.first_seen_at >  c.closed_at + make_interval(days => p_swap_days)
                and o.first_seen_at <= c.closed_at + make_interval(days => p_repost_days)
           ) as reposted
      from c
  )
  insert into public.company_job_outcomes
    (company_id, window_days, closed_count, swap_count, repost_count, median_days_live)
  select company_id,
         p_window_days,
         count(*) filter (where not swapped),
         count(*) filter (where swapped),
         count(*) filter (where not swapped and reposted),
         round((percentile_cont(0.5) within group (
           order by extract(epoch from closed_at - published_at) / 86400
         ) filter (where not swapped and published_at is not null))::numeric, 0)
    from k
   group by company_id;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.refresh_job_outcomes(int, int, int) from public, anon, authenticated;

-- 3. Company profile from Exa --------------------------------------------------------

-- Company data only: no person is involved. `matched` false means Exa was asked and
-- nothing it returned could be tied to this company's domain, which is a different
-- state from never asked.
create table public.company_profiles (
  company_id            uuid primary key references public.companies (id) on delete cascade,
  searched_at           timestamptz not null default now(),
  matched               boolean not null default false,
  exa_name              text,
  matched_url           text,
  headcount             int,
  founded_year          int,
  funding_total_usd     numeric,
  latest_round_name     text,
  latest_round_date     text,
  latest_round_usd      numeric
);

alter table public.company_profiles enable row level security;

-- In-band prospects with a domain, never profiled first, then the oldest.
create function public.profile_queue(p_limit int, p_stale_days int)
returns table (company_id uuid, label text, domain text)
language sql
stable
security invoker
set search_path = ''
as $$
  select l.id, l.label, l.domain
    from public.lead_list l
    left join public.company_profiles p on p.company_id = l.id
   where l.is_prospect
     and l.role_band = 'target'
     and l.domain is not null
     and (p.searched_at is null or p.searched_at < now() - make_interval(days => p_stale_days))
   order by p.searched_at nulls first, l.has_in_house_ta, l.stale_roles_120 desc, l.id
   limit p_limit;
$$;

revoke all on function public.profile_queue(int, int) from public, anon, authenticated;

-- 4. The console's read surface -------------------------------------------------------

-- One row per company that has any of the three. Recruiter count is capped by the
-- sweep's ten results per search, so it reads "10" for a big team; in the 5-50 band
-- that cap is rarely reached.
create view public.lead_company_stats as
with people as (
  select p.company_id,
         count(*)                                                     as people_count,
         count(*) filter (where public.is_recruiting_title(p.job_title)) as recruiter_count
    from public.company_people p
   group by p.company_id
)
select
  c.id                                  as company_id,
  pl.searched_at                        as people_searched_at,
  coalesce(pe.people_count, 0)          as people_count,
  coalesce(pe.recruiter_count, 0)       as recruiter_count,
  o.window_days,
  o.closed_count,
  o.swap_count,
  o.repost_count,
  o.median_days_live,
  o.computed_at                         as outcomes_computed_at,
  pr.searched_at                        as profile_searched_at,
  pr.matched                            as profile_matched,
  pr.headcount,
  pr.founded_year,
  pr.funding_total_usd,
  pr.latest_round_name,
  pr.latest_round_date,
  pr.latest_round_usd
from public.companies c
left join public.people_lookups pl       on pl.company_id = c.id
left join people pe                      on pe.company_id = c.id
left join public.company_job_outcomes o  on o.company_id = c.id
left join public.company_profiles pr     on pr.company_id = c.id
where pl.company_id is not null or o.company_id is not null or pr.company_id is not null;

revoke all on public.company_job_outcomes, public.company_profiles from anon, authenticated;
revoke all on public.lead_company_stats from anon, authenticated;
grant select on public.lead_company_stats to anon;
-- Functions in a view run with the caller's execute rights, so anon needs this one. It
-- is pure: a title in, a boolean out, nothing read.
revoke all on function public.is_recruiting_title(text) from public, authenticated;
grant execute on function public.is_recruiting_title(text) to anon;
