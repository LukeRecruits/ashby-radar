-- Turn the board list into a lead list.
--
-- Three gaps stood between 4,167 tracked boards and a list you can prospect from:
-- no company name, no domain, and location held only as freeform text. All three
-- are fixable from data Ashby already gives us.
--
-- 1. NAME. The posting API has no company name, which is why display_name has been
--    null since phase 1. The board *page* does: `<title>` on
--    https://jobs.ashbyhq.com/{board} is "<Company> Jobs". 25 of 25 on test, including
--    names no one could guess from the slug: `kpr` is "KP Reddy Co.", and
--    `demo.uipath.com` is "UiPath Workday Sandbox", which is how you learn to bin it.
--
-- 2. DOMAIN. Everything downstream (Clay, Apollo, anything) keys on domain, and Ashby
--    never gives one. But companies link to themselves in their own job adverts, and
--    `descriptionHtml` is already in the response we fetch daily and currently discard.
--    Extracting it costs no extra requests. Scoring candidates against the now-known
--    company name, after folding to the registrable domain, scored 7 of 12 on test with
--    zero false positives: every failure is a refusal, never a wrong answer. Whatever
--    it refuses goes to the verifier, then to Clay.
--
-- 3. LOCATION. Each job carries `address.postalAddress` with addressLocality,
--    addressRegion and addressCountry, plus a `secondaryLocations` array. We stored only
--    the flat `location` string. Over 658 sampled jobs the structured fields cover
--    country 83%, locality 60%. That is segmentation without normalising 4,826
--    freeform strings.
--
-- Note what is NOT here: no contacts, and no person of any kind. Radar's rule is still
-- company and job data only. Storing named people makes this a UK GDPR processing
-- activity that needs a written lawful basis, and that decision is Luke's to make first.

-- companies -----------------------------------------------------------------
alter table companies
  -- How display_name was obtained, so a hand-corrected name is never overwritten
  -- by a later automated pass.
  add column name_source        text,
  add column name_checked_at    timestamptz,
  -- How the domain was obtained and how much to trust it:
  --   100  the site links back to this exact Ashby board. Proof.
  --    90  extracted from the company's own job adverts and the stem matches the name
  --    80  a guessed domain that resolves and whose site names the company
  --   < 80 not accepted; left null for Clay
  add column domain_source      text,
  add column domain_confidence  integer,
  add column domain_checked_at  timestamptz,
  -- Ranked candidates seen in job descriptions, so the enricher can rescore without
  -- refetching every board. Shape: [{"domain": "acme.com", "hits": 12}, ...]
  add column domain_candidates  jsonb not null default '[]'::jsonb,
  -- Where this company actually hires, derived from its open roles each refresh.
  -- Deliberately not called HQ: for a remote-first business the two differ, and where
  -- the roles are is the more useful of the two.
  add column top_country        text,
  add column top_locality       text,
  add column remote_share       integer;

create index companies_domain_idx       on companies (domain) where domain is not null;
create index companies_top_country_idx  on companies (top_country);
create index companies_needs_name_idx   on companies (id) where display_name is null;
create index companies_needs_domain_idx on companies (id) where domain is null;

-- jobs ----------------------------------------------------------------------
-- Structured address, normalised on write. The freeform `location` stays: it is what
-- the company actually wrote, and it carries nuance the structured fields drop
-- ("San Francisco or Sunnyvale" becomes just San Francisco once structured).
alter table jobs
  add column address_country  text,
  add column address_region   text,
  add column address_locality text;

create index jobs_address_country_idx  on jobs (address_country)  where closed_at is null;
create index jobs_address_locality_idx on jobs (address_locality) where closed_at is null;
