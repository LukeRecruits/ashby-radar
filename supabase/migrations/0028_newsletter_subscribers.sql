-- 0028: Data Driven Recruiter newsletter subscribers, as a count per company.
--
-- People subscribed to read a newsletter, not to be prospected, so nothing here names
-- anybody: no email, no name, only "N active subscribers have an address at this
-- company's domain". Matching happens on Luke's machine against his beehiiv export, and
-- unsubscribed (inactive) rows are dropped before matching. First import 2026-11-12:
-- 3,813 active of 4,058, 189 matched, at 169 companies.
--
-- Same single-use token as the connections import (settings.warm_import_token_sha256),
-- deleted on success. lead_warm is rebuilt so a company with subscribers but no
-- connections is on the warm list too.

create table public.company_subscribers (
  company_id   uuid primary key references public.companies (id) on delete cascade,
  subscribers  int not null check (subscribers > 0),
  imported_at  timestamptz not null default now()
);

alter table public.company_subscribers enable row level security;

comment on table public.company_subscribers is
  'Count of active DDR newsletter subscribers whose email domain is this company''s. No personal data.';

create function public.replace_company_subscribers(p_token text, p_rows jsonb)
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

  delete from public.company_subscribers where true;

  insert into public.company_subscribers (company_id, subscribers)
  select (r->>'company_id')::uuid, (r->>'subscribers')::int
    from jsonb_array_elements(p_rows) r
    join public.companies c on c.id = (r->>'company_id')::uuid
   where (r->>'subscribers')::int > 0;

  get diagnostics v_rows = row_count;
  delete from public.settings where key = 'warm_import_token_sha256';
  return v_rows;
end;
$$;

revoke all on function public.replace_company_subscribers(text, jsonb) from public, anon, authenticated;
grant execute on function public.replace_company_subscribers(text, jsonb) to anon;

drop view public.lead_warm;

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
),
ids as (
  select company_id from w
  union
  select company_id from public.company_subscribers
)
select l.id as company_id, l.label, l.domain, l.source, l.status, l.parked_at,
       l.is_prospect, l.role_band, l.open_roles, l.recruiter_roles, l.stale_roles_120,
       coalesce(w.connections, 0)        as connections,
       coalesce(w.talent_connections, 0) as talent_connections,
       coalesce(w.profile_matches, 0)    as profile_matches,
       coalesce(w.all_ambiguous, false)  as all_ambiguous,
       w.newest_connected_on,
       w.imported_at,
       coalesce(s.subscribers, 0)        as subscribers
  from ids
  join public.lead_list l on l.id = ids.company_id
  left join w on w.company_id = ids.company_id
  left join public.company_subscribers s on s.company_id = ids.company_id;

revoke all on public.company_subscribers from anon, authenticated;
revoke all on public.lead_warm from anon, authenticated;
grant select on public.lead_warm to anon;
