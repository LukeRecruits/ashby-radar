-- Two edges 0008 missed, both found by checking its own output rather than by trusting it.
--
-- 1. A COUNTRY IN THE CITY FIELD, WHEN THE COUNTRY FIELD SAYS SOMETHING ELSE. 0008 only
--    dropped a country-shaped locality when it equalled the country, or when the country
--    was missing. That left "Primary" as locality "United States" / country "U.S.A", and
--    RevenueBase as locality "United States" / country "India". Both are the same fault,
--    and comparing the two fields was never the right test: a country name in a city
--    field is wrong whatever sits beside it. The rule here drops it outright, with the
--    city-states still allowlisted.
--
-- 2. THE COUNTRY FIELD HAS ITS OWN JUNK. Spot-checking the long tail turned up "U.S" and
--    "U.S.A" as separate countries from "United States", "People's Republic of China"
--    separate from China, "France, Metropolitan" separate from France, and a handful of
--    companies who typed their remote policy into it: "Any Location", "Remote - Global",
--    "Europe (CET +/- 1h)", "LATAM", "North America". Country is the primary segmentation
--    Luke asked for, so a country filter offering "Remote - Global" as an option is a
--    defect even at one company.
--
-- Both are mirrored in src/enrich/location.ts, so tomorrow's refresh writes them clean:
-- the new aliases, a NON_COUNTRY reject list, and `clean()` now strips a trailing
-- parenthetical before anything else looks at the value.

create table _m0009_country_alias (raw text primary key, canonical text not null);
insert into _m0009_country_alias (raw, canonical) values
  ('u.s', 'United States'), ('u.s.', 'United States'),
  ('u.s.a', 'United States'), ('u.s.a.', 'United States'),
  ('usa', 'United States'), ('us', 'United States'),
  ('united states of america', 'United States'), ('america', 'United States'),
  ('uk', 'United Kingdom'), ('u.k.', 'United Kingdom'), ('gb', 'United Kingdom'),
  ('great britain', 'United Kingdom'), ('england', 'United Kingdom'),
  ('scotland', 'United Kingdom'), ('wales', 'United Kingdom'),
  ('northern ireland', 'United Kingdom'),
  ('people''s republic of china', 'China'), ('prc', 'China'),
  ('france, metropolitan', 'France'),
  ('korea, republic of', 'South Korea'),
  ('russian federation', 'Russia'),
  ('viet nam', 'Vietnam'),
  ('czech republic', 'Czechia'),
  ('swaziland', 'Eswatini'),
  ('deutschland', 'Germany'), ('the netherlands', 'Netherlands'),
  ('holland', 'Netherlands'), ('españa', 'Spain'), ('italia', 'Italy'),
  ('schweiz', 'Switzerland'), ('brasil', 'Brazil'), ('polska', 'Poland'),
  ('méxico', 'Mexico');

create table _m0009_non_country (name text primary key);
insert into _m0009_non_country (name) values
  ('europe'), ('eu'), ('european union'), ('emea'), ('apac'), ('latam'),
  ('latin america'), ('north america'), ('south america'), ('americas'), ('asia'),
  ('asia pacific'), ('africa'), ('middle east'), ('oceania'), ('caribbean'),
  ('nordics'), ('benelux'), ('dach'), ('anz'), ('international'),
  ('united states and canada'), ('any location'), ('remote'), ('remote - global'),
  ('global'), ('worldwide'), ('anywhere'), ('multiple'), ('various'), ('distributed');

create table _m0009_city_state (name text primary key);
insert into _m0009_city_state (name) values
  ('singapore'), ('hong kong'), ('macau'), ('macao'), ('monaco'), ('gibraltar'),
  ('luxembourg'), ('vatican city'), ('san marino'), ('liechtenstein'), ('andorra'),
  ('malta'), ('bahrain'), ('brunei');

-- Strip a trailing parenthetical first, so "Europe (CET +/- 1h)" can be recognised.
update jobs      set address_country = btrim(regexp_replace(address_country, '\s*\([^)]*\)\s*$', ''))
  where address_country ~ '\([^)]*\)\s*$';
update companies set top_country     = btrim(regexp_replace(top_country,     '\s*\([^)]*\)\s*$', ''))
  where top_country ~ '\([^)]*\)\s*$';

update jobs j set address_country = a.canonical
  from _m0009_country_alias a
 where lower(j.address_country) = a.raw and j.address_country is distinct from a.canonical;
update companies c set top_country = a.canonical
  from _m0009_country_alias a
 where lower(c.top_country) = a.raw and c.top_country is distinct from a.canonical;

update jobs      set address_country = null where lower(address_country) in (select name from _m0009_non_country);
update companies set top_country     = null where lower(top_country)     in (select name from _m0009_non_country);

-- Now the country field is canonical, so it is a trustworthy list of what a country name
-- looks like. Anything matching it in the city field is the leak, whatever the country
-- field beside it happens to say.
create table _m0009_country_like (name text primary key);
insert into _m0009_country_like (name)
  select distinct lower(address_country) from jobs where address_country is not null
  union
  select distinct lower(top_country) from companies where top_country is not null;

update jobs set address_locality = null
 where address_locality is not null
   and lower(address_locality) in (select name from _m0009_country_like)
   and lower(address_locality) not in (select name from _m0009_city_state);

update companies set top_locality = null
 where top_locality is not null
   and lower(top_locality) in (select name from _m0009_country_like)
   and lower(top_locality) not in (select name from _m0009_city_state);

drop table _m0009_country_alias;
drop table _m0009_non_country;
drop table _m0009_city_state;
drop table _m0009_country_like;
