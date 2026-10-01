-- Everything the company page needs, and a remote share that is actually true.
--
-- The lead list answers "who is worth a look". The company page answers "what is going
-- on here, and is the answer good enough to spend an invitation on". That is a different
-- read: the roles themselves, broken down; the snapshot history behind the 30-day
-- number; and the evidence attached to each signal rather than just the fact it fired.
--
-- None of that can come out of `lead_list`, which is deliberately one row per company.
-- So four more views, each keyed on company_id, each granted to anon on the same terms:
-- plain (security definer) views reading through the base tables' RLS, so the console
-- gains four shaped read surfaces rather than select on `jobs`, `snapshots` and
-- `triggers`. Every base table stays denied, and the console still cannot write.

-- 1. Fix remote_share ---------------------------------------------------------
--
-- `remote_share` has been counting hybrid roles as remote, and the console has been
-- labelling the result "% remote". Ashby sets `isRemote` true for both Remote and
-- Hybrid workplace types: of 64,827 open roles, 35,102 have isRemote true, but only
-- 18,448 are workplaceType Remote and 16,678 are Hybrid. So a company posting entirely
-- hybrid roles reads as 100% remote, which is the opposite of what it is.
--
-- `workplaceType` is the field that distinguishes them, so the share is computed from
-- that instead, and over the roles that state one rather than over all roles: 8,667 open
-- roles say nothing about workplace at all, and counting silence as "not remote" is the
-- same class of mistake in the other direction. A company whose roles are all silent now
-- gets null, which the console renders as "Not stated".
--
-- src/enrich/location.ts is changed to match, so tomorrow's refresh writes the same
-- definition. This half fixes the history; that half fixes the future. The two must stay
-- in step, exactly as with the location cleanup in 0008 and 0009.

with stated as (
  select
    company_id,
    count(*) filter (where workplace_type is not null)   as stated,
    count(*) filter (where workplace_type = 'Remote')    as remote
  from jobs
  where closed_at is null
  group by company_id
)
update companies c
   set remote_share = case
         when s.stated = 0 then null
         else round(s.remote::numeric * 100 / s.stated)::int
       end
  from stated s
 where s.company_id = c.id
   and c.remote_share is distinct from case
         when s.stated = 0 then null
         else round(s.remote::numeric * 100 / s.stated)::int
       end;

-- 2. The open roles themselves ------------------------------------------------
--
-- One row per open role. The page uses it for the oldest-roles table, which is where
-- `long_open` stops being a badge and becomes a sentence Luke can say out loud: "you
-- have had a Senior Backend Engineer open since April".
--
-- Closed roles are excluded rather than exposed with a flag. Nothing on this page asks a
-- question about a role that is no longer open, and the largest board has 833 live ones.
-- `age_days` is computed here because it is a property of the row rather than a thing
-- the application should be deriving from a timestamp in a different timezone.

create view lead_roles as
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
  (current_date - j.published_at::date)  as age_days,
  j.ashby_job_url,
  j.first_seen_at
from jobs j
where j.closed_at is null;

comment on view lead_roles is
  'Open roles, one per row, for the console company page. Granted to anon.';

-- 3. The same roles, rolled up ------------------------------------------------
--
-- Four breakdowns in one view, shaped exactly like `lead_facets`: a kind, a value, and
-- counts. Doing it in SQL rather than grouping in the application is the same argument
-- as the facets view, for the same reason: a company page should not have to read 833
-- rows to draw a bar chart of eleven departments.
--
-- Each group carries stale and paid counts alongside the total, because the useful
-- question is not "how many engineering roles" but "how many of them have been sat there
-- since the spring", and that is the thing worth opening a conversation about.
--
-- Nulls become 'Not stated' rather than disappearing. A department every role names and
-- a city two thirds of them name are different situations, and a view that silently drops
-- the silent rows makes the second look like the first.
--
-- **The four branches each read `jobs` directly, and that is the whole point.** The first
-- version of this view shared one `with open_roles as (...)` CTE, which is tidier to read
-- and was 25 times slower: a CTE is an optimisation fence, so Postgres materialised all
-- 64,827 open roles, scanned that result four times, and threw away 64,797 rows each
-- time. 83ms for one company page, with `jobs_company_open_idx` never touched. Repeating
-- the `from jobs where closed_at is null` lets the `company_id` predicate push into each
-- branch: index scan, 3.2ms for OpenAI's 836 roles. Do not refactor the repetition away.

create view lead_role_groups as
  select
    company_id,
    'department'::text                 as kind,
    coalesce(department, 'Not stated') as value,
    count(*)::int                                                           as roles,
    count(*) filter (where published_at < now() - interval '120 days')::int as stale_roles,
    count(*) filter (where has_compensation)::int                           as roles_with_pay
  from jobs
  where closed_at is null
  group by company_id, coalesce(department, 'Not stated')
union all
  select
    company_id,
    'city'::text,
    coalesce(address_locality, 'Not stated'),
    count(*)::int,
    count(*) filter (where published_at < now() - interval '120 days')::int,
    count(*) filter (where has_compensation)::int
  from jobs
  where closed_at is null
  group by company_id, coalesce(address_locality, 'Not stated')
union all
  select
    company_id,
    'country'::text,
    coalesce(address_country, 'Not stated'),
    count(*)::int,
    count(*) filter (where published_at < now() - interval '120 days')::int,
    count(*) filter (where has_compensation)::int
  from jobs
  where closed_at is null
  group by company_id, coalesce(address_country, 'Not stated')
union all
  select
    company_id,
    'workplace'::text,
    coalesce(workplace_type, 'Not stated'),
    count(*)::int,
    count(*) filter (where published_at < now() - interval '120 days')::int,
    count(*) filter (where has_compensation)::int
  from jobs
  where closed_at is null
  group by company_id, coalesce(workplace_type, 'Not stated');

comment on view lead_role_groups is
  'Open roles rolled up by department, city, country and workplace type, with stale and '
  'paid counts per group. Granted to anon alongside lead_roles.';

-- 4. The snapshot history -----------------------------------------------------
--
-- The series behind the 30-day number. 120 days is four times the window any trigger
-- compares over, which is enough to see a trend and short enough that the read stays one
-- small page per company.
--
-- Today it returns two rows for everyone, because history started on 2026-09-30. The
-- page says so rather than drawing a confident line through two points.

create view lead_history as
select
  company_id,
  snapshot_date,
  open_role_count,
  recruiter_role_count,
  comp_published_count
from snapshots
where snapshot_date >= current_date - 120;

comment on view lead_history is
  'Up to 120 days of daily snapshots per company, for the console trend. Granted to anon.';

-- 5. Signals, with their evidence ---------------------------------------------
--
-- `lead_list` carries one timestamp per signal type, which is all a table row can show.
-- The evidence is the part that makes a signal worth acting on: which roles are stale and
-- how old, which jobs appeared in a spike, what the baseline was. It is already stored,
-- as jsonb on every trigger row, and has never been readable from the console.
--
-- `exported_at` is left out. It is about the retired Clay hand-off, not about the company.

create view lead_signals as
select
  t.id,
  t.company_id,
  t.type,
  t.fired_at,
  t.evidence,
  t.reviewed
from triggers t;

comment on view lead_signals is
  'Fired triggers with their evidence, for the console company page. Granted to anon.';

grant select on lead_roles, lead_role_groups, lead_history, lead_signals
  to anon, authenticated;
