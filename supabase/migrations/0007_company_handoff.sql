-- The company is the unit of work, and Clay is the contact layer.
--
-- Decided 2026-09-30. Radar never stores a person. It holds companies, jobs and
-- signals, and hands qualified companies to Clay, which finds and holds the people.
--
-- That is a deliberate choice, not an omission. Storing named contacts would make
-- Radar a UK GDPR processing activity in its own right, needing a written legitimate
-- interests assessment, an Article 14 notice (the data would come from Clay, not from
-- the person), a retention period and a suppression list that survives deletion. Clay
-- is built for holding that data and is already covered for it. Radar stays clean.
--
-- So the console shows a company and a link into Clay, never a name and a job title.
-- If that ever changes, the paperwork above has to exist first.
--
-- Three columns, all about the company:
--   exported_at    when this company was pushed to Clay, so it goes once
--   parked_at      set aside by hand and kept out of every future push
--   parked_reason  why, because "UiPath Workday Sandbox" and "an RPO, not a buyer"
--                  are different kinds of no and the list is worth keeping honest

alter table companies
  add column exported_at   timestamptz,
  add column parked_at     timestamptz,
  add column parked_reason text;

-- A prospect: live on Ashby, has a domain Clay can key on, not parked.
create index companies_prospect_idx on companies (id)
  where status = 'active' and domain is not null and parked_at is null;

create index companies_unexported_idx on companies (first_seen_at)
  where exported_at is null and parked_at is null;
