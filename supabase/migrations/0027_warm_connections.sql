-- 0027: the warm list. Luke's own LinkedIn connections, matched to Radar companies.
--
-- Until now Luke checked LinkedIn by hand, company by company, for anybody he knew. His
-- LinkedIn data export (Connections.csv: name, profile URL, company, position, date
-- connected) answers that for every company at once. The matching happens on his
-- machine; only connections at a Radar company are sent here, so the other ~15,000 rows
-- of his network never reach this database.
--
-- Two kinds of match:
--   * profile:  the connection IS somebody the people sweep found on the talent team.
--               Exact, on the normalised profile URL. The warmest row there is.
--   * employer: the connection's stated current company matches a Radar company's name.
--               `ambiguous` is true when that name matched more than one company (Sage
--               and Sage AI Labs, Cleo's regional boards), so the console says "check".
--
-- An import replaces the table whole, through one function that takes a single-use
-- token: its SHA-256 is put in settings just before an import and the function deletes it
-- on success. Between imports nothing can write here at all. Suppression applies: an
-- objected profile is skipped on import and deleted when it is suppressed later.
--
-- Contacts already on the outreach list who turn out to be connections get is_connection
-- set, which moves them from "To invite" to "To message" in the work queue.

create table public.warm_connections (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  full_name     text not null,
  position      text,
  linkedin_url  text not null,
  linkedin_key  text not null,
  connected_on  date,
  match_type    text not null check (match_type in ('profile', 'employer')),
  ambiguous     boolean not null default false,
  is_talent     boolean not null default false,
  imported_at   timestamptz not null default now(),
  unique (company_id, linkedin_key)
);

alter table public.warm_connections enable row level security;
create index warm_connections_key_idx on public.warm_connections (linkedin_key);

comment on table public.warm_connections is
  'Luke''s LinkedIn connections at Radar companies, from his own data export. Replaced whole by replace_warm_connections().';

-- Suppression reaches here too.
create function public.apply_suppression_to_warm()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.warm_connections w where w.linkedin_key = new.linkedin_key;
  return new;
end;
$$;

revoke all on function public.apply_suppression_to_warm() from public, anon, authenticated;

create trigger contact_suppressions_apply_warm
  after insert on public.contact_suppressions
  for each row execute function public.apply_suppression_to_warm();

-- The import. Security definer because the caller is anon with a token, the same shape
-- as the console's write functions, but the token is single-use and separate from the
-- console's, so the console cannot rewrite the warm list and an import cannot touch
-- contacts beyond the one flag.
create function public.replace_warm_connections(p_token text, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows int;
begin
  if length(btrim(coalesce(p_token, ''))) < 24
     or coalesce((
       select s.value #>> '{}' from public.settings s where s.key = 'warm_import_token_sha256'
     ), '') <> encode(extensions.digest(btrim(p_token), 'sha256'), 'hex')
  then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  delete from public.warm_connections where true;

  insert into public.warm_connections
    (company_id, full_name, position, linkedin_url, linkedin_key, connected_on,
     match_type, ambiguous, is_talent)
  select distinct on ((r->>'company_id')::uuid, public.normalise_linkedin_url(r->>'linkedin_url'))
         (r->>'company_id')::uuid,
         r->>'full_name',
         nullif(r->>'position', ''),
         r->>'linkedin_url',
         public.normalise_linkedin_url(r->>'linkedin_url'),
         case when r->>'connected_on' ~ '^\d{4}-\d{2}-\d{2}$' then (r->>'connected_on')::date end,
         r->>'match_type',
         coalesce((r->>'ambiguous')::boolean, false),
         coalesce((r->>'is_talent')::boolean, false)
    from jsonb_array_elements(p_rows) r
    join public.companies c on c.id = (r->>'company_id')::uuid
   where public.normalise_linkedin_url(r->>'linkedin_url') is not null
     and not exists (
       select 1 from public.contact_suppressions s
        where s.linkedin_key = public.normalise_linkedin_url(r->>'linkedin_url')
     )
   order by (r->>'company_id')::uuid, public.normalise_linkedin_url(r->>'linkedin_url'),
            (r->>'match_type') = 'profile' desc;

  get diagnostics v_rows = row_count;

  update public.contacts ct
     set is_connection = true
   where not ct.is_connection
     and exists (select 1 from public.warm_connections w where w.linkedin_key = ct.linkedin_key);

  -- Single use.
  delete from public.settings where key = 'warm_import_token_sha256';
  return v_rows;
end;
$$;

revoke all on function public.replace_warm_connections(text, jsonb) from public, anon, authenticated;
grant execute on function public.replace_warm_connections(text, jsonb) to anon;

-- The console's read surface ---------------------------------------------------------

create view public.lead_warm_connections as
select w.id, w.company_id, w.full_name, w.position, w.linkedin_url, w.linkedin_key,
       w.connected_on, w.match_type, w.ambiguous, w.is_talent, w.imported_at
  from public.warm_connections w;

-- One row per company with at least one connection, carrying enough of the lead to rank
-- and filter on without a second read.
create view public.lead_warm as
with w as (
  select company_id,
         count(*)                                         as connections,
         count(*) filter (where is_talent)                as talent_connections,
         count(*) filter (where match_type = 'profile')   as profile_matches,
         bool_and(ambiguous)                              as all_ambiguous,
         max(connected_on)                                as newest_connected_on,
         max(imported_at)                                 as imported_at
    from public.warm_connections
   group by company_id
)
select l.id as company_id, l.label, l.domain, l.source, l.status, l.parked_at,
       l.is_prospect, l.role_band, l.open_roles, l.recruiter_roles, l.stale_roles_120,
       w.connections, w.talent_connections, w.profile_matches, w.all_ambiguous,
       w.newest_connected_on, w.imported_at
  from w
  join public.lead_list l on l.id = w.company_id;

revoke all on public.warm_connections from anon, authenticated;
revoke all on public.lead_warm, public.lead_warm_connections from anon, authenticated;
grant select on public.lead_warm, public.lead_warm_connections to anon;
