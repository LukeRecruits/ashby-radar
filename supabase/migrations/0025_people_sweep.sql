-- 0025: the people sweep.
--
-- Until now a person reached Radar only when Luke pressed Add after a live search on one
-- company page. Luke reversed that on 2026-11-05: the talent and people team at every
-- in-band prospect is now looked up in bulk by a scheduled job, named, and shown on the
-- lead list and the company page before anybody clicks. He is updating the LIA himself.
--
-- `company_people` is what the sweep found. It is not the outreach pipeline: `contacts`
-- still is, and still holds only people Luke has chosen to approach. Adding somebody from
-- here copies them into `contacts` through the existing add_contact().
--
-- Three controls, each asserted from outside after applying (see README):
--
--   * A suppressed profile can never be stored here. The key is computed in the BEFORE
--     trigger, not as a generated column, because 0015 found that a generated column is
--     computed after BEFORE triggers run.
--   * A new suppression deletes the person from here as well as from contacts.
--   * anon reads two views and nothing else, and can write nothing.
--
-- Each sweep replaces a company's list, so somebody who has left drops out at the next
-- pass rather than lingering. Rows not seen for 24 months are purged by the retention job.

-- 1. What the sweep found -------------------------------------------------------------

create table public.company_people (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  full_name      text not null,
  job_title      text,
  linkedin_url   text not null,
  linkedin_key   text not null,
  started_at     text,
  seniority_band smallint not null default 0,
  rank           smallint not null default 0,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  unique (company_id, linkedin_key)
);

alter table public.company_people enable row level security;

create index company_people_key_idx on public.company_people (linkedin_key);
create index company_people_last_seen_idx on public.company_people (last_seen_at);

comment on table public.company_people is
  'Talent and people staff found by the scheduled Exa sweep. Not the outreach pipeline; contacts is.';

-- One row per company the sweep has looked at, including the ones where it found nobody,
-- so "never searched" and "searched, nobody there" are different states.
create table public.people_lookups (
  company_id  uuid primary key references public.companies (id) on delete cascade,
  searched_at timestamptz not null default now(),
  returned    int not null default 0,
  kept        int not null default 0,
  dropped     jsonb not null default '{}'::jsonb
);

alter table public.people_lookups enable row level security;

-- 2. Suppression, enforced here too ---------------------------------------------------

create function public.prepare_company_person()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.linkedin_key := public.normalise_linkedin_url(new.linkedin_url);
  if new.linkedin_key is null then
    raise exception 'that is not a LinkedIn profile URL' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.contact_suppressions s where s.linkedin_key = new.linkedin_key
  ) then
    raise exception 'person % is suppressed and cannot be stored', new.linkedin_key
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.prepare_company_person() from public, anon, authenticated;

create trigger company_people_prepare
  before insert or update on public.company_people
  for each row execute function public.prepare_company_person();

create function public.apply_suppression_to_people()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.company_people p where p.linkedin_key = new.linkedin_key;
  return new;
end;
$$;

revoke all on function public.apply_suppression_to_people() from public, anon, authenticated;

create trigger contact_suppressions_apply_people
  after insert on public.contact_suppressions
  for each row execute function public.apply_suppression_to_people();

-- 3. The sweep's two functions (service role only) ------------------------------------

-- In-band prospects not searched in p_stale_days, best first: no open recruiter req,
-- then the most stalled roles. Reads lead_list so "in band" is defined once.
create function public.people_sweep_queue(p_limit int, p_stale_days int)
returns table (company_id uuid, label text, domain text)
language sql
stable
security invoker
set search_path = ''
as $$
  select l.id, l.label, l.domain
    from public.lead_list l
    left join public.people_lookups pl on pl.company_id = l.id
   where l.is_prospect
     and l.role_band = 'target'
     and (pl.searched_at is null or pl.searched_at < now() - make_interval(days => p_stale_days))
   order by pl.searched_at nulls first,
            l.has_in_house_ta,
            l.stale_roles_120 desc,
            l.id
   limit p_limit;
$$;

revoke all on function public.people_sweep_queue(int, int) from public, anon, authenticated;

-- Replace one company's list in one transaction. Suppressed people are skipped here
-- rather than left to the trigger, so one objection cannot fail a whole company.
create function public.replace_company_people(
  p_company_id uuid,
  p_people     jsonb,
  p_returned   int,
  p_dropped    jsonb
)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_kept int;
begin
  with incoming as (
    select distinct on (public.normalise_linkedin_url(p->>'linkedin_url'))
           p->>'full_name'                              as full_name,
           nullif(p->>'job_title', '')                  as job_title,
           p->>'linkedin_url'                           as linkedin_url,
           public.normalise_linkedin_url(p->>'linkedin_url') as linkedin_key,
           nullif(p->>'started_at', '')                 as started_at,
           coalesce((p->>'seniority_band')::smallint, 0) as seniority_band,
           coalesce((p->>'rank')::smallint, 0)          as rank
      from jsonb_array_elements(coalesce(p_people, '[]'::jsonb)) p
     where public.normalise_linkedin_url(p->>'linkedin_url') is not null
       and not exists (
         select 1 from public.contact_suppressions s
          where s.linkedin_key = public.normalise_linkedin_url(p->>'linkedin_url')
       )
  ),
  gone as (
    delete from public.company_people cp
     where cp.company_id = p_company_id
       and cp.linkedin_key not in (select linkedin_key from incoming)
    returning 1
  ),
  kept as (
    insert into public.company_people as cp
      (company_id, full_name, job_title, linkedin_url, linkedin_key, started_at, seniority_band, rank)
    select p_company_id, full_name, job_title, linkedin_url, linkedin_key, started_at, seniority_band, rank
      from incoming
    on conflict (company_id, linkedin_key) do update
      set full_name      = excluded.full_name,
          job_title      = excluded.job_title,
          linkedin_url   = excluded.linkedin_url,
          started_at     = excluded.started_at,
          seniority_band = excluded.seniority_band,
          rank           = excluded.rank,
          last_seen_at   = now()
    returning 1
  )
  select count(*) into v_kept from kept;

  insert into public.people_lookups as pl (company_id, searched_at, returned, kept, dropped)
  values (p_company_id, now(), coalesce(p_returned, 0), v_kept, coalesce(p_dropped, '{}'::jsonb))
  on conflict (company_id) do update
    set searched_at = excluded.searched_at,
        returned    = excluded.returned,
        kept        = excluded.kept,
        dropped     = excluded.dropped;

  return v_kept;
end;
$$;

revoke all on function public.replace_company_people(uuid, jsonb, int, jsonb) from public, anon, authenticated;

create function public.purge_stale_company_people(p_retention_months int)
returns int
language sql
security invoker
set search_path = ''
as $$
  with gone as (
    delete from public.company_people
     where last_seen_at < now() - make_interval(months => p_retention_months)
    returning 1
  )
  select count(*)::int from gone;
$$;

revoke all on function public.purge_stale_company_people(int) from public, anon, authenticated;

-- 4. The console's read surface -------------------------------------------------------

create view public.lead_people as
select
  p.id,
  p.company_id,
  p.full_name,
  p.job_title,
  p.linkedin_url,
  p.linkedin_key,
  p.started_at,
  p.seniority_band,
  p.rank,
  p.first_seen_at,
  p.last_seen_at
from public.company_people p;

-- One row per searched company: team size, the most senior person, and whether that
-- person is new in post (a new people leader is a reason to get in touch).
create view public.lead_people_summary as
with ranked as (
  select p.*,
         row_number() over (partition by p.company_id order by p.rank desc, p.full_name) as n
    from public.company_people p
)
select
  pl.company_id,
  pl.searched_at,
  pl.kept                                                   as people_count,
  count(r.id) filter (where r.seniority_band >= 3)          as senior_count,
  max(r.full_name)  filter (where r.n = 1)                  as top_name,
  max(r.job_title)  filter (where r.n = 1)                  as top_title,
  max(r.started_at) filter (where r.n = 1)                  as top_started_at,
  max(r.linkedin_url) filter (where r.n = 1)                as top_linkedin_url,
  coalesce(bool_or(
    r.seniority_band >= 3
    and r.started_at ~ '^\d{4}-\d{2}'
    and to_date(left(r.started_at, 7), 'YYYY-MM') >= (now() - interval '6 months')::date
  ), false)                                                 as new_leader
from public.people_lookups pl
left join ranked r on r.company_id = pl.company_id
group by pl.company_id, pl.searched_at, pl.kept;

revoke all on public.company_people, public.people_lookups from anon, authenticated;
revoke all on public.lead_people, public.lead_people_summary from anon, authenticated;
grant select on public.lead_people, public.lead_people_summary to anon;
