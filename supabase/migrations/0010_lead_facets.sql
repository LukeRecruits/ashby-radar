-- Filter options, with counts, without reading 5,731 rows to work them out.
--
-- The console's country and city filters need two things the lead list cannot give them:
-- the set of values that actually exist, and how many companies sit behind each. Fetching
-- every row to derive that in the application would be the wrong shape, and PostgREST has
-- no distinct-with-count. So: a second view, two grouped queries wide.
--
-- Counts are over live, unparked companies rather than over the current filter. Facet
-- counts that respond to the other filters are a much bigger machine (every facet becomes
-- its own filtered query), and the useful job here is ordering the list so San Francisco,
-- New York and London are at the top of a 465-entry city dropdown instead of Albany.
--
-- Parked companies are excluded, consistently with every other count in the console: a
-- deliberate "no" should not keep a city in the filter list on its own.

create view lead_facets as
  select
    'country'::text as kind,
    top_country     as value,
    count(*)::int   as companies
  from companies
  where status = 'active' and parked_at is null and top_country is not null
  group by top_country
union all
  select
    'city'::text    as kind,
    top_locality    as value,
    count(*)::int   as companies
  from companies
  where status = 'active' and parked_at is null and top_locality is not null
  group by top_locality;

comment on view lead_facets is
  'Country and city filter options with company counts, over live unparked companies. '
  'Granted to anon alongside lead_list.';

grant select on lead_facets to anon, authenticated;
