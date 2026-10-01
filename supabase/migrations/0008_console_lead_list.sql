-- The console reads one view, and the city filter behind it is clean.
--
-- Two jobs, both prerequisites for the console rather than features of it.
--
-- 1. CLEAN THE CITY FIELD. The first full enrichment pass left three faults that split
--    or polluted the only segmentation Luke asked for by name. "New York City" (425
--    companies) and "New York" (485) are one market shown as two. "United States" was
--    the fifth most common *city*, on 170 companies. "Europe" and "Latin America" are
--    not cities at all. All three make a city filter lie, so they are fixed here in the
--    history and in src/enrich/location.ts for everything written from now on.
--
--    Singapore, Hong Kong, Luxembourg, Gibraltar and Monaco are the exception that
--    matters: there the city really is the country, and a blanket "drop locality when it
--    equals country" rule would have silently binned 74 companies in Singapore alone.
--
-- 2. ONE VIEW FOR THE CONSOLE. `lead_list` joins a company to its latest snapshot, its
--    stale-role counts and its signals, so the list page is one query with no joins in
--    the application. It is also the entire read surface the web app is granted: every
--    base table stays denied to anon, so the console physically cannot read a row this
--    view does not expose, and cannot write at all.
--
-- No contacts here. Radar still stores no person. That changes in 0009, and only once
-- the legitimate interests assessment and the Article 14 notice exist.

-- 1. Clean the city field ---------------------------------------------------

-- Mirrors LOCALITY_ALIASES in src/enrich/location.ts. Kept in step by hand: this half
-- runs once over history, that half runs on every refresh forever.
create table _m0008_locality_alias (raw text primary key, canonical text not null);
insert into _m0008_locality_alias (raw, canonical) values
  ('new york city', 'New York'), ('nyc', 'New York'), ('new york, ny', 'New York'),
  ('manhattan', 'New York'),
  ('washington dc', 'Washington'), ('washington d.c', 'Washington'),
  ('washington d.c.', 'Washington'), ('washington, dc', 'Washington'),
  ('washington, d.c', 'Washington'), ('washington, d.c.', 'Washington'),
  ('san francisco bay area', 'San Francisco'), ('sf', 'San Francisco'),
  ('saint louis', 'St. Louis'), ('st louis', 'St. Louis'),
  ('bangalore', 'Bengaluru'), ('bengaluru, karnataka', 'Bengaluru'),
  ('bombay', 'Mumbai'), ('calcutta', 'Kolkata'), ('madras', 'Chennai'),
  ('gurgaon', 'Gurugram'),
  ('bogota', 'Bogotá'), ('sao paulo', 'São Paulo'),
  ('ciudad de méxico', 'Mexico City'), ('ciudad de mexico', 'Mexico City'),
  ('cdmx', 'Mexico City'),
  ('münchen', 'Munich'), ('muenchen', 'Munich'),
  ('köln', 'Cologne'), ('koeln', 'Cologne'),
  ('zürich', 'Zurich'), ('zuerich', 'Zurich'),
  ('genève', 'Geneva'), ('geneve', 'Geneva'),
  ('wien', 'Vienna'), ('praha', 'Prague'), ('warszawa', 'Warsaw'),
  ('lisboa', 'Lisbon'), ('milano', 'Milan'), ('roma', 'Rome'),
  ('torino', 'Turin'), ('napoli', 'Naples'), ('firenze', 'Florence'),
  ('bruxelles', 'Brussels'), ('brussel', 'Brussels'),
  ('den haag', 'The Hague'), ('''s-gravenhage', 'The Hague'),
  ('københavn', 'Copenhagen'), ('kobenhavn', 'Copenhagen'),
  ('göteborg', 'Gothenburg'), ('goteborg', 'Gothenburg'),
  ('kiev', 'Kyiv'), ('moskva', 'Moscow'),
  ('tel aviv-yafo', 'Tel Aviv'), ('tel-aviv', 'Tel Aviv'),
  ('peking', 'Beijing');

create table _m0008_non_city (name text primary key);
insert into _m0008_non_city (name) values
  ('europe'), ('eu'), ('european union'), ('emea'), ('apac'), ('latam'),
  ('latin america'), ('north america'), ('south america'), ('americas'), ('asia'),
  ('asia pacific'), ('africa'), ('middle east'), ('oceania'), ('caribbean'),
  ('nordics'), ('benelux'), ('dach'), ('anz'), ('international'),
  ('united states and canada');

create table _m0008_city_state (name text primary key);
insert into _m0008_city_state (name) values
  ('singapore'), ('hong kong'), ('macau'), ('macao'), ('monaco'), ('gibraltar'),
  ('luxembourg'), ('vatican city'), ('san marino'), ('liechtenstein'), ('andorra'),
  ('malta'), ('bahrain'), ('brunei');

-- Every country spelling we have actually stored, which is the reliable way to spot a
-- country sitting in a city field without maintaining a world list.
create table _m0008_country_like (name text primary key);
insert into _m0008_country_like (name)
  select distinct lower(address_country) from jobs where address_country is not null
  union
  select distinct lower(top_country) from companies where top_country is not null;

-- jobs: fold the aliases first, then drop what is not a city.
update jobs j set address_locality = a.canonical
  from _m0008_locality_alias a
 where lower(j.address_locality) = a.raw and j.address_locality is distinct from a.canonical;

update jobs set address_locality = null
 where address_locality is not null
   and lower(address_locality) in (select name from _m0008_non_city);

update jobs set address_locality = null
 where address_locality is not null
   and lower(address_locality) not in (select name from _m0008_city_state)
   and (
     lower(address_locality) = lower(address_country)
     or (address_country is null and lower(address_locality) in (select name from _m0008_country_like))
   );

-- companies: the same remap applied to the already-derived pair. Tomorrow's 05:00
-- refresh recomputes top_country and top_locality from the now-clean jobs anyway; this
-- is so the console is not reading known-wrong cities in the meantime.
update companies c set top_locality = a.canonical
  from _m0008_locality_alias a
 where lower(c.top_locality) = a.raw and c.top_locality is distinct from a.canonical;

update companies set top_locality = null
 where top_locality is not null
   and lower(top_locality) in (select name from _m0008_non_city);

update companies set top_locality = null
 where top_locality is not null
   and lower(top_locality) not in (select name from _m0008_city_state)
   and (
     lower(top_locality) = lower(top_country)
     or (top_country is null and lower(top_locality) in (select name from _m0008_country_like))
   );

-- Helper tables, deliberately real rather than temporary so the migration behaves the
-- same whether or not the runner wraps it in a transaction. Dropped as soon as used.
drop table _m0008_locality_alias;
drop table _m0008_non_city;
drop table _m0008_city_state;
drop table _m0008_country_like;

-- 2. The console's read surface ---------------------------------------------

-- A plain (security definer) view on purpose. It runs with the owner's rights, so it
-- reads through the base tables' RLS, and anon is granted this and nothing else. The
-- alternative, security_invoker with per-table policies, would mean granting anon direct
-- select on companies, jobs, snapshots and triggers and then trying to narrow it back
-- down. Exposing one shaped, read-only view is the smaller surface.
create view lead_list as
with latest_snapshot as (
  select distinct on (company_id)
    company_id, snapshot_date, open_role_count, recruiter_role_count, comp_published_count
  from snapshots
  order by company_id, snapshot_date desc
),
-- The latest snapshot at or before 30 days ago, rather than one dated exactly then, so a
-- missed morning degrades the trend instead of blanking it.
baseline_snapshot as (
  select distinct on (company_id) company_id, open_role_count
  from snapshots
  where snapshot_date <= current_date - 30
  order by company_id, snapshot_date desc
),
open_roles as (
  select
    company_id,
    count(*) filter (where published_at < now() - interval '120 days') as stale_roles_120,
    count(*) filter (where published_at < now() - interval '180 days') as stale_roles_180,
    min(published_at)                                                  as oldest_open_role_at
  from jobs
  where closed_at is null
  group by company_id
),
signals as (
  select
    company_id,
    count(distinct type)                                        as signal_count,
    max(fired_at) filter (where type = 'new_to_ashby')          as new_to_ashby_at,
    max(fired_at) filter (where type = 'hiring_spike')          as hiring_spike_at,
    max(fired_at) filter (where type = 'first_recruiter')       as first_recruiter_at,
    max(fired_at) filter (where type = 'sweet_spot')            as sweet_spot_at,
    max(fired_at) filter (where type = 'long_open')             as long_open_at,
    max(fired_at) filter (where type = 'publishes_comp')        as publishes_comp_at
  from triggers
  group by company_id
)
select
  c.id,
  c.board_name,
  c.display_name,
  coalesce(c.display_name, c.board_name)                as label,
  'https://jobs.ashbyhq.com/' || c.board_name           as board_url,
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
  coalesce(s.open_role_count, 0)                        as open_roles,
  coalesce(s.recruiter_role_count, 0)                   as recruiter_roles,
  coalesce(s.comp_published_count, 0)                   as roles_with_pay,
  b.open_role_count                                     as open_roles_30d_ago,
  s.open_role_count - b.open_role_count                 as open_roles_change_30d,

  coalesce(o.stale_roles_120, 0)                        as stale_roles_120,
  coalesce(o.stale_roles_180, 0)                        as stale_roles_180,
  o.oldest_open_role_at,

  coalesce(g.signal_count, 0)                           as signal_count,
  g.new_to_ashby_at,
  g.hiring_spike_at,
  g.first_recruiter_at,
  g.sweet_spot_at,
  g.long_open_at,
  g.publishes_comp_at,

  -- The band CandidHQ sells into, as a value you can filter on rather than two numbers
  -- the application has to combine.
  case
    when coalesce(s.open_role_count, 0) = 0        then 'none'
    when s.open_role_count between 1 and 4         then 'small'
    when s.open_role_count between 5 and 50        then 'target'
    else                                                'large'
  end                                                   as role_band,
  -- No in-house recruiter on the board is the strongest single qualifier we have: it is
  -- who feels the candidate-experience problem without having anyone to hand it to.
  coalesce(s.recruiter_role_count, 0) > 0               as has_in_house_ta,
  coalesce(s.comp_published_count, 0) > 0               as publishes_pay,
  (c.status = 'active' and c.domain is not null and c.parked_at is null) as is_prospect
from companies c
left join latest_snapshot   s on s.company_id = c.id
left join baseline_snapshot b on b.company_id = c.id
left join open_roles        o on o.company_id = c.id
left join signals           g on g.company_id = c.id;

comment on view lead_list is
  'Read surface for the Radar console. One row per company with its latest snapshot, '
  'stale-role counts and signals. Granted to anon; every base table stays denied.';

grant select on lead_list to anon, authenticated;
