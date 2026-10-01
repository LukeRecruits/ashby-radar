-- Contacts: the first personal data in this project, and the controls that had to come
-- with them rather than after them.
--
-- Phase 3's rule was that Radar never stores a person. That reversed on 2026-10-01
-- because an outreach funnel has to be tracked per contact to be worth anything, and the
-- reversal carried five conditions, all of which now exist:
--
--   * a legitimate interests assessment          docs/prospecting-lia.md
--   * an Article 14 notice, publicly reachable   candidhq.tech/privacy/prospecting
--   * a suppression list that survives re-discovery   this migration
--   * a stated retention period, 24 months           this migration + config.ts
--   * a record of processing                     docs/prospecting-ropa.md
--
-- Four fields are stored: name, current job title, LinkedIn profile URL, and the company
-- the person is recorded against. No email, no phone, no biography, no posts, no
-- location, no seniority band. Exa returns several of those and they are used to rank and
-- filter the search results in memory; none of them is written here. That is the data
-- minimisation the assessment relies on, so it is enforced by there being nowhere to put
-- them rather than by remembering not to.
--
-- Three things in this file are the compliance machinery rather than the feature:
--
--   1. The suppression list, keyed on a normalised profile URL, with a trigger that
--      refuses the insert. A removal has to survive the next Exa lookup re-finding the
--      same person, otherwise "we deleted you" lasts until the next time that company
--      comes up in the queue.
--   2. purge_expired_contacts(), which makes the 24 months in the public notice a fact
--      about the database rather than a sentence on a web page.
--   3. Four named write functions behind a shared secret, instead of a service-role key
--      in the console. See section 6.

-- 0. Stop the next function arriving open ------------------------------------
--
-- Postgres grants execute on a new function to PUBLIC by default, which includes anon.
-- Migration 0012 fixed the same class of problem for tables and views; functions were
-- not covered, and this migration adds a function that deletes rows. Defaults apply to
-- objects created after this statement, so it runs first, and every function below also
-- gets an explicit revoke, because a default is not something to rely on twice.

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- 1. One profile URL, one spelling -------------------------------------------
--
-- Suppression is only as good as its key. The same person is reachable as
-- https://www.linkedin.com/in/jane-doe, https://uk.linkedin.com/in/jane-doe/,
-- linkedin.com/in/jane-doe?originalSubdomain=uk and half a dozen other spellings, so a
-- suppression list keyed on the URL as typed would be trivially defeated by the next
-- lookup returning a different one.
--
-- Everything collapses to linkedin.com/in/{slug}: scheme, subdomain, trailing path,
-- query string and fragment all go, and the result is lower-cased. Returns null for
-- anything that is not a profile URL, which is what makes the not-null constraint on the
-- generated column below double as validation: a company page, a job advert or a typo
-- cannot be stored as a person.
--
-- Not handled, deliberately: percent-encoding. /in/jos%C3%A9 and /in/josé are two keys.
-- Decoding them here would mean a non-immutable function and so no generated column, for
-- a case that has not come up; the search returns whichever form LinkedIn canonicalises
-- to, consistently.
--
-- immutable is load-bearing. A generated column requires it.

create function public.normalise_linkedin_url(p_url text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select nullif(('linkedin.com/in/' || coalesce(m[1], '')), 'linkedin.com/in/')
  from (
    select regexp_match(
      btrim(lower(coalesce(p_url, ''))),
      '(?:^|\.|/)linkedin\.com/in/([^/?#[:space:]]+)'
    ) as m
  ) s;
$$;

revoke all on function public.normalise_linkedin_url(text) from public, anon, authenticated;

-- 2. The suppression list ----------------------------------------------------
--
-- Deliberately the first table created, because it has to be able to refuse the second.
--
-- It holds a normalised profile URL, a reason and a date. Not a name: once somebody has
-- told us to go away, the minimum we can hold and still honour that is the key we would
-- otherwise match them on. This is the one thing kept indefinitely, and the reason it is
-- kept is the request itself.

create table public.contact_suppressions (
  linkedin_key  text primary key,
  reason        text,
  suppressed_at timestamptz not null default now()
);

alter table public.contact_suppressions enable row level security;

comment on table public.contact_suppressions is
  'Profile URLs that must never be stored again. Article 21(2) objections, honoured permanently. Keyed on normalise_linkedin_url().';

-- 3. Contacts ----------------------------------------------------------------
--
-- One row per person, not per person per company: linkedin_key is unique across the
-- table. Somebody who moves from one Ashby customer to another is the same human being
-- and the same funnel, so add_contact() moves the row rather than duplicating it.
--
-- `on delete cascade` from companies is intentional. A company dropped from Radar takes
-- its contacts with it; a prospect record whose reason for existing has gone is a record
-- with no lawful basis.

create table public.contacts (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  full_name        text not null check (btrim(full_name) <> ''),
  job_title        text,
  linkedin_url     text not null,

  -- Generated, so the key can never drift from the URL it was derived from, and not-null
  -- so a URL that is not a profile is rejected by the database rather than by whichever
  -- caller remembered to check.
  linkedin_key     text not null
                     generated always as (public.normalise_linkedin_url(linkedin_url)) stored,

  source           text not null default 'manual'
                     check (source in ('exa', 'manual')),

  -- Whether Luke is already connected to them. No API exposes this, on any LinkedIn
  -- tier, so it is a toggle in the console. It matters because connections are the warm
  -- list and do not cost an invitation from the weekly hundred.
  is_connection    boolean not null default false,

  added_at         timestamptz not null default now(),

  -- The retention clock. Stamped on creation and on every action taken on this person,
  -- which sprint 5's funnel transitions will also do. 24 months after the last one, the
  -- row is deleted. See purge_expired_contacts().
  last_activity_at timestamptz not null default now(),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint contacts_linkedin_key_key unique (linkedin_key)
);

create index contacts_company_idx on public.contacts (company_id);
create index contacts_last_activity_idx on public.contacts (last_activity_at);

alter table public.contacts enable row level security;

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

comment on table public.contacts is
  'Prospecting contacts. Four fields only; see docs/prospecting-lia.md. Retention 24 months from last_activity_at.';

-- 4. The suppression list, enforced ------------------------------------------
--
-- A check against the list at the point of insert, inside the database, because the
-- thing being guarded against is a future caller that does not know the list exists.
-- The console filters suppressed people out of search results as well, but that is a
-- courtesy to the operator; this is the control.

create function public.refuse_suppressed_contact()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.contact_suppressions s where s.linkedin_key = new.linkedin_key
  ) then
    raise exception 'contact % is suppressed and cannot be stored', new.linkedin_key
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.refuse_suppressed_contact() from public, anon, authenticated;

create trigger contacts_refuse_suppressed
  before insert or update of linkedin_url on public.contacts
  for each row execute function public.refuse_suppressed_contact();

-- 5. Retention ---------------------------------------------------------------
--
-- Called monthly by the `retention` workflow with the period from src/config.ts, so the
-- number lives in one place in the code and is stated in the public notice. Returns the
-- count so the run log records what it did, including the zero.
--
-- security invoker: the caller is the service role. anon could not delete a row through
-- this even if it could reach it, and it cannot reach it.

create function public.purge_expired_contacts(p_retention_months int)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted int;
begin
  if p_retention_months is null or p_retention_months < 1 then
    raise exception 'retention months must be a positive integer, got %', p_retention_months;
  end if;

  with gone as (
    delete from public.contacts
     where last_activity_at < now() - make_interval(months => p_retention_months)
    returning 1
  )
  select count(*) into v_deleted from gone;

  return v_deleted;
end;
$$;

revoke all on function public.purge_expired_contacts(int) from public, anon, authenticated;

-- 6. The console's write path -------------------------------------------------
--
-- The console holds the publishable key, which grants anon. Until now it only ever read,
-- and 0012 made that true rather than assumed. Contacts need writes, and there were
-- three ways to do it:
--
--   a. Put the service-role key in the console's environment. One bug that leaks an env
--      var or lets a request reach an arbitrary URL, and the whole database is writable.
--   b. Grant anon insert and update on contacts with an RLS policy. The publishable key
--      is a browser-grade credential, designed to be public, so that is a write surface
--      for anyone who ever sees it in a screenshot.
--   c. Four named functions, each doing exactly one thing, each requiring a shared secret
--      the publishable key does not contain.
--
-- (c). The token lives in settings.console_write_token and in the console's environment
-- as CONSOLE_WRITE_TOKEN. It is NOT in this migration or anywhere else in the repo: it
-- is set once by hand in both places. If the key leaks, the caller can read the lead
-- views, which was always true, and still cannot write a row.
--
-- It fails closed. No settings row, or an empty token, denies every write, for the same
-- reason the console's password gate denies when CONSOLE_PASSWORD is unset: the failure
-- mode of a misconfiguration should be a tool that does not work, not a tool anyone can
-- write to.
--
-- Not granted to anon, so it cannot be used as an oracle to test candidate tokens:
-- only the four writers call it, and each of them returns the same error either way.

create function public.console_write_allowed(p_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    length(btrim(coalesce(p_token, ''))) >= 24
      and (select s.value #>> '{}' from public.settings s where s.key = 'console_write_token')
          = btrim(p_token),
    false
  );
$$;

revoke all on function public.console_write_allowed(text) from public, anon, authenticated;

-- add_contact: the only way a person enters this database.
--
-- Upserts on the profile URL rather than erroring, because the same person legitimately
-- comes back: found again under a new employer, or re-found after being removed by hand
-- without being suppressed. A conflicting insert therefore moves the row to the new
-- company and refreshes the title, and stamps last_activity_at, which is accurate in
-- both cases. is_connection survives, because that fact is about Luke and does not stop
-- being true when somebody changes job.
create function public.add_contact(
  p_company_id   uuid,
  p_full_name    text,
  p_job_title    text,
  p_linkedin_url text,
  p_source       text,
  p_token        text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.console_write_allowed(p_token) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  if public.normalise_linkedin_url(p_linkedin_url) is null then
    raise exception 'that is not a LinkedIn profile URL' using errcode = 'check_violation';
  end if;

  insert into public.contacts as c (company_id, full_name, job_title, linkedin_url, source)
  values (
    p_company_id,
    btrim(p_full_name),
    nullif(btrim(coalesce(p_job_title, '')), ''),
    btrim(p_linkedin_url),
    coalesce(nullif(p_source, ''), 'manual')
  )
  on conflict (linkedin_key) do update
    set company_id       = excluded.company_id,
        full_name        = excluded.full_name,
        job_title        = coalesce(excluded.job_title, c.job_title),
        linkedin_url     = excluded.linkedin_url,
        last_activity_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- The warm-list toggle. Its own function rather than a general update, so the console
-- can change this one boolean and nothing else.
create function public.set_contact_connection(
  p_contact_id    uuid,
  p_is_connection boolean,
  p_token         text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.console_write_allowed(p_token) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  update public.contacts
     set is_connection    = coalesce(p_is_connection, false),
         last_activity_at = now()
   where id = p_contact_id;

  return found;
end;
$$;

-- Removing somebody who was added in error, or who is simply the wrong person. This is
-- not the objection path: it leaves no suppression, so a later search can find them
-- again. Objections use suppress_contact().
create function public.delete_contact(p_contact_id uuid, p_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.console_write_allowed(p_token) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  delete from public.contacts where id = p_contact_id;
  return found;
end;
$$;

-- The objection path, and the only one that is permanent.
--
-- Records the key first and deletes second, so the two cannot be separated by a failure
-- halfway: a suppression with the contact still present is recoverable by rerunning, a
-- deletion with no suppression silently permits re-adding them tomorrow.
--
-- Returns the number of contact rows removed, which is 0 when somebody asks to be
-- removed before we ever stored them. That is a valid and useful answer: the request
-- still has to be honoured for the future.
create function public.suppress_contact(
  p_linkedin_url text,
  p_reason       text,
  p_token        text
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key     text := public.normalise_linkedin_url(p_linkedin_url);
  v_deleted int;
begin
  if not public.console_write_allowed(p_token) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  if v_key is null then
    raise exception 'that is not a LinkedIn profile URL' using errcode = 'check_violation';
  end if;

  insert into public.contact_suppressions as s (linkedin_key, reason)
  values (v_key, nullif(btrim(coalesce(p_reason, '')), ''))
  on conflict (linkedin_key) do update
    set reason = coalesce(s.reason, excluded.reason);

  with gone as (
    delete from public.contacts where linkedin_key = v_key returning 1
  )
  select count(*) into v_deleted from gone;

  return v_deleted;
end;
$$;

-- 7. The console's read surface ------------------------------------------------
--
-- A seventh lead view, on the same terms as the other six: a plain (security definer)
-- view, so it runs with the owner's rights and reads through the base table's RLS, and
-- anon is granted select on the view and nothing at all on `contacts`.
--
-- It exposes linkedin_key as well as the URL, because the console needs the normalised
-- form to tell whether a person it has just found is already on the list.

create view public.lead_contacts as
select
  c.id,
  c.company_id,
  c.full_name,
  c.job_title,
  c.linkedin_url,
  c.linkedin_key,
  c.source,
  c.is_connection,
  c.added_at,
  c.last_activity_at
from public.contacts c;

-- 8. Grants --------------------------------------------------------------------
--
-- Run the audit in 0012 after this, and every row must still read SELECT and nothing
-- else. Section 0 should have made the revokes below redundant; they are here because
-- the whole lesson of 0012 is that a default privilege nobody tested was handing out
-- write access, and an explicit statement is a thing a reader can check.

revoke all on public.contacts, public.contact_suppressions from anon, authenticated;

revoke insert, update, delete, truncate, references, trigger
  on public.lead_contacts from anon, authenticated;
grant select on public.lead_contacts to anon, authenticated;

-- The four writers, and only to anon: the console authenticates nobody, and anything
-- reaching the database as `authenticated` here would not be the console.
grant execute on function public.add_contact(uuid, text, text, text, text, text) to anon;
grant execute on function public.set_contact_connection(uuid, boolean, text) to anon;
grant execute on function public.delete_contact(uuid, text) to anon;
grant execute on function public.suppress_contact(text, text, text) to anon;
