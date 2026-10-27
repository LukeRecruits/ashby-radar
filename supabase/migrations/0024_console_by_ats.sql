-- The health numbers, one row per ATS.
--
-- Until Greenhouse, every company was an Ashby company and `health_summary` was one row
-- about all of them. With two sources in `companies`, one row would add Greenhouse's
-- discovered boards to Ashby's and the funnel of qualification would stop meaning
-- anything for either. So the view becomes one row per source, and the health page puts
-- the two side by side.
--
-- Every number keeps the definition it had in 0021, restricted to the row's source. For
-- Ashby that restriction is a no-op today (every company, job, snapshot and trigger
-- belongs to an Ashby company, and none is orphaned), so the Ashby numbers on the page do
-- not move when this lands.
--
-- Sources are listed explicitly as well as read from `companies`, so Greenhouse has a
-- row of zeros before its first discovery run. Zero companies from a source that is
-- meant to be running is exactly the quiet failure this page is for, and a missing row
-- cannot be seen.
--
-- Two numbers are not about a company and do not split:
--   * `suppressions` is a list of people's profile URLs with no employer attached. It is
--     the same global count on every row, and the page prints it once.
--   * `contacts` does split, through `contacts.company_id`. A contact whose company has
--     gone (company_id null) is counted in no source; `contacts_unattached` carries them
--     on every row so the total is never quietly short.
--
-- Built from grouped CTEs rather than per-row scalar subqueries: `lead_list` is the
-- expensive view here, and grouping it once by source reads it once rather than four
-- times per row.
--
-- The column list changes (a leading `source`), which `create or replace` cannot do, so
-- the view is dropped and recreated and its grants restated. Nothing depends on it.

drop view if exists public.health_summary;

create view public.health_summary as
with sources as (
  select 'ashby'::text as source
  union
  select 'greenhouse'::text
  union
  select distinct c.source from public.companies c
),
co as (
  select
    c.source,
    count(*)                                              as companies,
    count(*) filter (where c.status = 'active')           as active,
    count(*) filter (where c.status = 'inactive')         as inactive,
    count(*) filter (where c.status = 'not_found')        as not_found,
    count(*) filter (where c.status = 'unverified')       as unverified,
    count(*) filter (where c.display_name is not null)    as named,
    count(*) filter (where c.domain is not null)          as with_domain,
    count(*) filter (where c.top_country is not null)     as with_country,
    count(*) filter (where c.parked_at is not null)       as parked
  from public.companies c
  group by c.source
),
jb as (
  select
    c.source,
    count(*) filter (where j.closed_at is null)                                  as open_roles,
    count(*) filter (where j.closed_at is null and j.is_evergreen)               as evergreen_roles,
    count(*) filter (where j.closed_at is null and not j.is_evergreen
                       and j.published_at < now() - interval '120 days')         as stale_roles,
    count(*)                                                                     as jobs_ever
  from public.jobs j
  join public.companies c on c.id = j.company_id
  group by c.source
),
sn as (
  select
    c.source,
    count(distinct s.snapshot_date)                       as snapshot_days,
    min(s.snapshot_date)                                  as first_snapshot,
    max(s.snapshot_date)                                  as last_snapshot
  from public.snapshots s
  join public.companies c on c.id = s.company_id
  group by c.source
),
-- Each source's own latest snapshot day. The two refreshes run at different times of
-- day, so "today's snapshot" for Greenhouse can be a different date from Ashby's.
sn_last as (
  select
    c.source,
    count(*)                                              as companies_in_last_snapshot
  from public.snapshots s
  join public.companies c on c.id = s.company_id
  join sn on sn.source = c.source and s.snapshot_date = sn.last_snapshot
  group by c.source
),
tr as (
  select
    c.source,
    count(*)                                              as signals,
    count(distinct t.company_id)                          as companies_with_signal
  from public.triggers t
  join public.companies c on c.id = t.company_id
  group by c.source
),
ct as (
  select
    c.source,
    count(*)                                              as contacts
  from public.contacts k
  join public.companies c on c.id = k.company_id
  group by c.source
),
ll as (
  select
    l.source,
    count(*) filter (where l.is_prospect)                                        as prospects,
    count(*) filter (where l.is_prospect and l.role_band = 'target')             as in_band,
    count(*) filter (where l.is_prospect and l.role_band = 'target'
                       and not l.has_in_house_ta)                                as in_band_no_recruiter_req,
    count(*) filter (where l.is_prospect and l.role_band = 'target'
                       and not l.has_in_house_ta and l.stale_roles_120 >= 3)     as fully_qualified
  from public.lead_list l
  group by l.source
)
select
  src.source,

  coalesce(co.companies, 0)                    as companies,
  coalesce(co.active, 0)                       as active,
  coalesce(co.inactive, 0)                     as inactive,
  coalesce(co.not_found, 0)                    as not_found,
  coalesce(co.unverified, 0)                   as unverified,
  coalesce(co.named, 0)                        as named,
  coalesce(co.with_domain, 0)                  as with_domain,
  coalesce(co.with_country, 0)                 as with_country,
  coalesce(co.parked, 0)                       as parked,

  coalesce(jb.open_roles, 0)                   as open_roles,
  coalesce(jb.evergreen_roles, 0)              as evergreen_roles,
  coalesce(jb.stale_roles, 0)                  as stale_roles,
  coalesce(jb.jobs_ever, 0)                    as jobs_ever,

  coalesce(sn.snapshot_days, 0)                as snapshot_days,
  sn.first_snapshot,
  sn.last_snapshot,
  coalesce(sl.companies_in_last_snapshot, 0)   as companies_in_last_snapshot,

  coalesce(tr.signals, 0)                      as signals,
  coalesce(tr.companies_with_signal, 0)        as companies_with_signal,

  coalesce(ct.contacts, 0)                     as contacts,
  (select count(*) from public.contacts k where k.company_id is null)
                                               as contacts_unattached,
  (select count(*) from public.contact_suppressions)
                                               as suppressions,

  coalesce(ll.prospects, 0)                    as prospects,
  coalesce(ll.in_band, 0)                      as in_band,
  coalesce(ll.in_band_no_recruiter_req, 0)     as in_band_no_recruiter_req,
  coalesce(ll.fully_qualified, 0)              as fully_qualified
from sources src
left join co          on co.source = src.source
left join jb          on jb.source = src.source
left join sn          on sn.source = src.source
left join sn_last sl  on sl.source = src.source
left join tr          on tr.source = src.source
left join ct          on ct.source = src.source
left join ll          on ll.source = src.source;

comment on view public.health_summary is
  'One row per ATS source: coverage, freshness and the qualification funnel, each with '
  'the 0021 definition restricted to that source. suppressions and contacts_unattached '
  'are global and repeat on every row. Read-only to anon.';

-- Grants ---------------------------------------------------------------------------
--
-- A recreated view picks up the schema's default privileges again, so the revoke is
-- restated rather than assumed (README, "The write hole that was open until
-- 2026-10-01"). It ends SELECT and nothing else for anon and authenticated.

revoke insert, update, delete, truncate, references, trigger
  on public.health_summary
  from anon, authenticated;

grant select on public.health_summary to anon, authenticated;
