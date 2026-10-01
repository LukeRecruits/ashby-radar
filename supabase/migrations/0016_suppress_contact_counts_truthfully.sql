-- suppress_contact() was reporting 0 rows removed while removing one.
--
-- 0015 added an AFTER INSERT trigger on contact_suppressions that deletes any matching
-- contact, so that an objection recorded by hand in the SQL editor also removes the
-- person. That made the delete inside suppress_contact() a no-op: by the time it runs,
-- the trigger has already taken the row, so `returning` counts nothing and the function
-- returns 0.
--
-- It matters because that number is the answer to "was this person in there". The
-- handling runbook in docs/prospecting-ropa.md tells Luke to read it, and the console
-- prints it back to him. A 0 that means 1 is worse than no number at all.
--
-- So the count is taken before the insert, which is also the only point at which it is
-- knowable. The delete stays, after the insert, for the one case the trigger cannot
-- cover: a key that is already on the suppression list takes the ON CONFLICT path, which
-- fires no insert trigger. That state should be impossible now, since the insert trigger
-- refuses a suppressed contact, but it was possible before 0015 and a second line of
-- defence here costs nothing.

create or replace function public.suppress_contact(
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
  v_key   text := public.normalise_linkedin_url(p_linkedin_url);
  v_found int;
begin
  if not public.console_write_allowed(p_token) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  if v_key is null then
    raise exception 'that is not a LinkedIn profile URL' using errcode = 'check_violation';
  end if;

  select count(*) into v_found from public.contacts c where c.linkedin_key = v_key;

  insert into public.contact_suppressions as s (linkedin_key, reason)
  values (v_key, nullif(btrim(coalesce(p_reason, '')), ''))
  on conflict (linkedin_key) do update
    set reason = coalesce(s.reason, excluded.reason);

  delete from public.contacts c where c.linkedin_key = v_key;

  return v_found;
end;
$$;

grant execute on function public.suppress_contact(text, text, text) to anon;
