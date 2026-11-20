-- 0029: which newsletter subscribers, not just how many.
--
-- 0028 stored a count per company and nobody's address. Luke wants to see who the
-- subscriber at a company is when he opens it, so the import now also sends each active
-- subscriber's email and subscription date. Unsubscribed rows are still dropped on his
-- machine before matching, and every import replaces the table whole, so somebody who
-- unsubscribes disappears on the next import.
--
-- The beehiiv export carries no names, only addresses. The console guesses a name by
-- matching the address to people it already knows at that company.
--
-- Not an anon surface. The publishable key is in a public repo, so a view would publish
-- these addresses. They are read through company_subscriber_emails(), which checks the
-- console's write token (console_write_allowed, 0014) the way every write does.

create table public.company_subscriber_emails (
  company_id     uuid not null references public.companies (id) on delete cascade,
  email          text not null check (email = lower(btrim(email)) and email like '%@%'),
  subscribed_on  date,
  primary key (company_id, email)
);

alter table public.company_subscriber_emails enable row level security;
revoke all on public.company_subscriber_emails from anon, authenticated;

comment on table public.company_subscriber_emails is
  'Active DDR newsletter subscribers at a company''s domain. Read only through company_subscriber_emails(token, id).';

create or replace function public.replace_company_subscribers(p_token text, p_rows jsonb)
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

  delete from public.company_subscriber_emails where true;
  delete from public.company_subscribers where true;

  insert into public.company_subscribers (company_id, subscribers)
  select (r->>'company_id')::uuid, (r->>'subscribers')::int
    from jsonb_array_elements(p_rows) r
    join public.companies c on c.id = (r->>'company_id')::uuid
   where (r->>'subscribers')::int > 0;

  get diagnostics v_rows = row_count;

  insert into public.company_subscriber_emails (company_id, email, subscribed_on)
  select distinct on (s.company_id, lower(btrim(e->>'email')))
         s.company_id, lower(btrim(e->>'email')), (e->>'subscribed_on')::date
    from jsonb_array_elements(p_rows) r
    join public.company_subscribers s on s.company_id = (r->>'company_id')::uuid
   cross join lateral jsonb_array_elements(coalesce(r->'emails', '[]'::jsonb)) e
   where e->>'email' like '%@%';

  delete from public.settings where key = 'warm_import_token_sha256';
  return v_rows;
end;
$$;

revoke all on function public.replace_company_subscribers(text, jsonb) from public, anon, authenticated;
grant execute on function public.replace_company_subscribers(text, jsonb) to anon;

create function public.company_subscriber_emails(p_token text, p_company_id uuid)
returns table (email text, subscribed_on date)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.console_write_allowed(p_token) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query
    select e.email, e.subscribed_on
      from public.company_subscriber_emails e
     where e.company_id = p_company_id
     order by e.subscribed_on nulls last, e.email;
end;
$$;

revoke all on function public.company_subscriber_emails(text, uuid) from public, anon, authenticated;
grant execute on function public.company_subscriber_emails(text, uuid) to anon;
