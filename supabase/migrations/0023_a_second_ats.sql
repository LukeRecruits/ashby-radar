-- 0023: make room for a second ATS.
--
-- Greenhouse is joining Ashby as a source. Companies were built for this from 0001
-- (unique on (source, board_name)), but four things assumed Ashby and would break, or
-- quietly misbehave, the day the first Greenhouse row arrived:
--
-- 1. Jobs are keyed on ashby_job_id, a uuid. Greenhouse job ids are integers. Jobs are
--    now keyed on (source, external_job_id), text. ashby_job_id stays, filled for Ashby
--    and null for everything else, because six trigger functions and two views read the
--    jobs table and none of them needs the id. ashby_job_url likewise stays the job URL
--    column for every source: renaming it means rewriting every trigger function body,
--    which Postgres stores as text and would not follow a rename. Same call as the one
--    recorded for has_in_house_ta: a misleading name with a comment beats a rewrite.
--
-- 2. discovery_log is unique on (board_name, discovered_via). "stripe" on Ashby and
--    "stripe" on Greenhouse are two different boards and would collide.
--
-- 3. new_to_ashby reads one backfill marker. Every Greenhouse company is discovered
--    after the Ashby backfill finished, so on that marker every one of them would fire
--    "new" on its first successful check: thousands of false signals in a morning. The
--    rule now reads a marker per source, passed in as jsonb, and a source with no marker
--    fires for nobody. The trigger type keeps the name new_to_ashby and now means "new
--    to its ATS"; the evidence says which.
--
-- 4. lead_list builds every board URL as jobs.ashbyhq.com.
--
-- Ashby's numbers must be identical before and after this migration. Checked by hashing
-- lead_list and lead_roles (minus the new columns) either side.

-- 1. Sources -------------------------------------------------------------------------

alter table public.companies
  add constraint companies_source_check check (source in ('ashby', 'greenhouse'));

-- 2. Jobs ----------------------------------------------------------------------------

alter table public.jobs add column source text not null default 'ashby'
  check (source in ('ashby', 'greenhouse'));
alter table public.jobs add column external_job_id text;

update public.jobs set external_job_id = ashby_job_id::text where external_job_id is null;

alter table public.jobs alter column external_job_id set not null;
alter table public.jobs
  add constraint jobs_source_external_job_id_key unique (source, external_job_id);
alter table public.jobs alter column ashby_job_id drop not null;

comment on column public.jobs.ashby_job_id is
  'Ashby''s job uuid, null for other sources. Identity is (source, external_job_id).';
comment on column public.jobs.ashby_job_url is
  'The public posting URL for every source, despite the name. See migration 0023.';

-- 3. Discovery log -------------------------------------------------------------------

alter table public.discovery_log add column source text not null default 'ashby'
  check (source in ('ashby', 'greenhouse'));
alter table public.discovery_log drop constraint discovery_log_name_via_key;
alter table public.discovery_log
  add constraint discovery_log_source_name_via_key unique (source, board_name, discovered_via);

-- 4. new_to_ashby, per source --------------------------------------------------------

drop function public.candidates_new_to_ashby(date, timestamptz, int);

-- p_markers: {"ashby": "<iso>", "greenhouse": "<iso>"}. A source missing from it, or
-- null, fires for nobody, which is what keeps a source's own backfill from reading as
-- thousands of new customers.
create function public.candidates_new_to_ats(
  p_run_date date,
  p_markers jsonb,
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
      'source', c.source,
      'openRoles', s.open_role_count,
      'firstSnapshot', s.snapshot_date,
      'firstSeenAt', c.first_seen_at,
      'discoveredVia', c.discovered_via
    )
  from public.companies c
  join public.snapshots s
    on s.company_id = c.id and s.snapshot_date = p_run_date
  where (p_markers ->> c.source) is not null
    and c.first_seen_at > (p_markers ->> c.source)::timestamptz
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

revoke execute on function public.candidates_new_to_ats(date, jsonb, int)
  from public, anon, authenticated;
grant execute on function public.candidates_new_to_ats(date, jsonb, int) to service_role;

-- 5. Views ---------------------------------------------------------------------------
-- create or replace may only append columns, so source and external_job_id go on the
-- end. board_url changes value for Greenhouse only; every Ashby row is unchanged.

create or replace view public.lead_list as
 WITH latest_snapshot AS (
         SELECT DISTINCT ON (s_1.company_id) s_1.company_id,
            s_1.snapshot_date,
            s_1.open_role_count,
            s_1.recruiter_role_count,
            s_1.comp_published_count
           FROM public.snapshots s_1
          ORDER BY s_1.company_id, s_1.snapshot_date DESC
        ), baseline_snapshot AS (
         SELECT DISTINCT ON (s_1.company_id) s_1.company_id,
            s_1.open_role_count
           FROM public.snapshots s_1
          WHERE s_1.snapshot_date <= (CURRENT_DATE - 30)
          ORDER BY s_1.company_id, s_1.snapshot_date DESC
        ), open_roles AS (
         SELECT j.company_id,
            count(*) FILTER (WHERE j.published_at < (now() - '120 days'::interval) AND NOT j.is_evergreen) AS stale_roles_120,
            count(*) FILTER (WHERE j.published_at < (now() - '180 days'::interval) AND NOT j.is_evergreen) AS stale_roles_180,
            min(j.published_at) FILTER (WHERE NOT j.is_evergreen) AS oldest_open_role_at
           FROM public.jobs j
          WHERE j.closed_at IS NULL
          GROUP BY j.company_id
        ), signals AS (
         SELECT t.company_id,
            count(DISTINCT t.type) AS signal_count,
            max(t.fired_at) FILTER (WHERE t.type = 'new_to_ashby'::text) AS new_to_ashby_at,
            max(t.fired_at) FILTER (WHERE t.type = 'hiring_spike'::text) AS hiring_spike_at,
            max(t.fired_at) FILTER (WHERE t.type = 'first_recruiter'::text) AS first_recruiter_at,
            max(t.fired_at) FILTER (WHERE t.type = 'sweet_spot'::text) AS sweet_spot_at,
            max(t.fired_at) FILTER (WHERE t.type = 'long_open'::text) AS long_open_at,
            max(t.fired_at) FILTER (WHERE t.type = 'publishes_comp'::text) AS publishes_comp_at
           FROM public.triggers t
          GROUP BY t.company_id
        )
 SELECT c.id,
    c.board_name,
    c.display_name,
    COALESCE(c.display_name, c.board_name) AS label,
    CASE c.source
        WHEN 'greenhouse'::text THEN 'https://job-boards.greenhouse.io/'::text || c.board_name
        ELSE 'https://jobs.ashbyhq.com/'::text || c.board_name
    END AS board_url,
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
    COALESCE(s.open_role_count, 0) AS open_roles,
    COALESCE(s.recruiter_role_count, 0) AS recruiter_roles,
    COALESCE(s.comp_published_count, 0) AS roles_with_pay,
    b.open_role_count AS open_roles_30d_ago,
    s.open_role_count - b.open_role_count AS open_roles_change_30d,
    COALESCE(o.stale_roles_120, 0::bigint) AS stale_roles_120,
    COALESCE(o.stale_roles_180, 0::bigint) AS stale_roles_180,
    o.oldest_open_role_at,
    COALESCE(g.signal_count, 0::bigint) AS signal_count,
    g.new_to_ashby_at,
    g.hiring_spike_at,
    g.first_recruiter_at,
    g.sweet_spot_at,
    g.long_open_at,
    g.publishes_comp_at,
        CASE
            WHEN COALESCE(s.open_role_count, 0) = 0 THEN 'none'::text
            WHEN s.open_role_count >= 1 AND s.open_role_count <= 4 THEN 'small'::text
            WHEN s.open_role_count >= 5 AND s.open_role_count <= 50 THEN 'target'::text
            ELSE 'large'::text
        END AS role_band,
    COALESCE(s.recruiter_role_count, 0) > 0 AS has_in_house_ta,
    COALESCE(s.comp_published_count, 0) > 0 AS publishes_pay,
    c.status = 'active'::text AND c.domain IS NOT NULL AND c.parked_at IS NULL AS is_prospect,
    c.source
   FROM public.companies c
     LEFT JOIN latest_snapshot s ON s.company_id = c.id
     LEFT JOIN baseline_snapshot b ON b.company_id = c.id
     LEFT JOIN open_roles o ON o.company_id = c.id
     LEFT JOIN signals g ON g.company_id = c.id;

create or replace view public.lead_roles as
 SELECT company_id,
    ashby_job_id,
    title,
    department,
    team,
    location,
    address_country,
    address_locality,
    workplace_type,
    employment_type,
    has_compensation,
    published_at,
    CURRENT_DATE - published_at::date AS age_days,
    ashby_job_url,
    first_seen_at,
    is_evergreen,
    external_job_id,
    source
   FROM public.jobs j
  WHERE closed_at IS NULL;

-- create or replace keeps existing grants, but say it again: SELECT and nothing else.
revoke insert, update, delete, truncate, references, trigger
  on public.lead_list, public.lead_roles from anon, authenticated;
grant select on public.lead_list, public.lead_roles to anon;
