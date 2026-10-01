-- The health page's read surface.
--
-- Everything in Radar runs unattended on a schedule, and the failure mode that matters is
-- not a crash. A crash is loud: the Actions run goes red and GitHub emails. The quiet
-- failure is the one this project has already seen in its sibling, where a scorer kept
-- reporting "active" for sixteen days while writing nothing, because the model id it
-- called had been retired. Nothing failed. Nothing happened either.
--
-- So the page answers three questions, each of which has a number behind it that would
-- move if a job stopped doing its work while still succeeding:
--
--   * Did each workflow run, and when did it last succeed?
--   * Is the data it maintains still growing and still complete?
--   * Do the signals still mean anything, or has a rule gone silent or gone mad?
--
-- Three views. All read-only to anon on the same terms as the other ten.

-- 1. Every run, with an outcome rather than a pair of counters ------------------
--
-- `outcome` is derived here rather than in the console because "partial" is a real state
-- that two integers do not say on their own: the refresh checking 4,100 companies with
-- 12 failures is healthy, and the same run with 4,100 failures is not, and both have a
-- non-zero `failed`.
--
-- An unfinished run is 'running', which is also what a run killed mid-flight looks like
-- for ever. That is deliberate: a run row that never closed is a fact worth seeing, not
-- one to tidy away into 'failed'.

create view public.health_runs as
select
  r.id,
  r.workflow,
  r.started_at,
  r.finished_at,
  extract(epoch from (r.finished_at - r.started_at))::int as seconds,
  r.checked,
  r.succeeded,
  r.failed,
  case
    when r.finished_at is null                         then 'running'
    when r.failed > 0 and r.succeeded = 0              then 'failed'
    when r.failed > 0                                  then 'partial'
    else                                                    'ok'
  end as outcome,
  left(r.notes, 600) as notes
from public.runs r;

-- 2. One row per workflow: when it last ran and last worked --------------------
--
-- `hours_since_success` is the number the page is really for. A workflow whose last run
-- was an hour ago and whose last success was four days ago is the exact shape of the
-- failure this page exists to catch, and no single run row says it.

create view public.health_workflows as
select
  r.workflow,
  count(*)                                              as runs_30d,
  max(r.started_at)                                     as last_run_at,
  max(r.finished_at) filter (where r.failed = 0 and r.finished_at is not null)
                                                        as last_success_at,
  round(extract(epoch from (now() - max(r.started_at))) / 3600)::int
                                                        as hours_since_run,
  round(extract(epoch from (
    now() - max(r.finished_at) filter (where r.failed = 0 and r.finished_at is not null)
  )) / 3600)::int                                       as hours_since_success,
  sum(r.checked)                                        as checked_30d,
  sum(r.failed)                                         as failed_30d
from public.runs r
where r.started_at > now() - interval '30 days'
group by r.workflow;

-- 3. The state of the data, in one row ------------------------------------------
--
-- Deliberately one row of named numbers rather than a tidy long format. Every one of
-- these is a different question and the page prints them as sentences; pivoting them into
-- (metric, value) pairs would make the view prettier and the page worse.
--
-- The funnel of qualification at the bottom is the one worth watching over time: 3,243
-- prospects, 1,925 in band, 1,489 of those not hiring a recruiter, 1,131 of those with
-- three or more genuinely stale roles. If the last number collapses, a rule has broken.

create view public.health_summary as
select
  (select count(*) from public.companies)                                          as companies,
  (select count(*) from public.companies where status = 'active')                  as active,
  (select count(*) from public.companies where status = 'inactive')                as inactive,
  (select count(*) from public.companies where status = 'not_found')               as not_found,
  (select count(*) from public.companies where status = 'unverified')              as unverified,
  (select count(*) from public.companies where display_name is not null)           as named,
  (select count(*) from public.companies where domain is not null)                 as with_domain,
  (select count(*) from public.companies where top_country is not null)            as with_country,
  (select count(*) from public.companies where parked_at is not null)              as parked,

  (select count(*) from public.jobs where closed_at is null)                       as open_roles,
  (select count(*) from public.jobs where closed_at is null and is_evergreen)      as evergreen_roles,
  (select count(*) from public.jobs where closed_at is null and not is_evergreen
      and published_at < now() - interval '120 days')                              as stale_roles,
  (select count(*) from public.jobs)                                               as jobs_ever,

  (select count(distinct snapshot_date) from public.snapshots)                     as snapshot_days,
  (select min(snapshot_date) from public.snapshots)                                as first_snapshot,
  (select max(snapshot_date) from public.snapshots)                                as last_snapshot,
  (select count(*) from public.snapshots
    where snapshot_date = (select max(s.snapshot_date) from public.snapshots s))   as companies_in_last_snapshot,

  (select count(*) from public.triggers)                                           as signals,
  (select count(distinct company_id) from public.triggers)                         as companies_with_signal,

  (select count(*) from public.contacts)                                           as contacts,
  (select count(*) from public.contact_suppressions)                               as suppressions,

  (select count(*) from public.lead_list where is_prospect)                        as prospects,
  (select count(*) from public.lead_list where is_prospect and role_band = 'target') as in_band,
  (select count(*) from public.lead_list
    where is_prospect and role_band = 'target' and not has_in_house_ta)            as in_band_no_recruiter_req,
  (select count(*) from public.lead_list
    where is_prospect and role_band = 'target' and not has_in_house_ta
      and stale_roles_120 >= 3)                                                    as fully_qualified;

-- 4. Grants ---------------------------------------------------------------------

revoke insert, update, delete, truncate, references, trigger
  on public.health_runs, public.health_workflows, public.health_summary
  from anon, authenticated;

grant select
  on public.health_runs, public.health_workflows, public.health_summary
  to anon, authenticated;
