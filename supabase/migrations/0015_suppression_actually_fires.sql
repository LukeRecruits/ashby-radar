-- The suppression list was not suppressing anything.
--
-- 0013 put a BEFORE INSERT OR UPDATE trigger on contacts that refuses a row whose
-- `linkedin_key` is on the suppression list, and tested nothing. Tested from outside
-- through PostgREST as anon, the sequence was:
--
--   suppress_contact('.../in/radar-write-test', ...)  ->  1   (row deleted, key recorded)
--   add_contact('.../in/radar-write-test', ...)       ->  a uuid, inserted happily
--
-- **`linkedin_key` is a stored generated column, and a generated column is computed
-- after BEFORE triggers have run.** So inside the trigger `new.linkedin_key` is null,
-- `where s.linkedin_key = null` matches no row, and every insert was waved through. The
-- control read correctly and did nothing, which is the third time in this project that
-- has been the case: the publicly readable console, the decorative grants in 0012, and
-- now this. The pattern is always the same, a claim nobody asserted from outside the
-- thing making it.
--
-- The fix is to compute the key in the trigger rather than read it. normalise_linkedin_url
-- is immutable and is the same function the generated column uses, so the two cannot
-- disagree. It also means the check no longer depends on the order in which Postgres
-- fills columns, which is the kind of dependency that was never visible in the first
-- place.
--
-- Also worth having: the insert into contact_suppressions now removes any matching
-- contact as a database-level consequence rather than only inside suppress_contact(), so
-- a suppression added by hand in the SQL editor (the likely route when an objection
-- arrives by email) deletes the person too. Previously that would have recorded the
-- objection and left the row in place.

create or replace function public.refuse_suppressed_contact()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_key text := public.normalise_linkedin_url(new.linkedin_url);
begin
  if v_key is null then
    raise exception '% is not a LinkedIn profile URL', new.linkedin_url
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.contact_suppressions s where s.linkedin_key = v_key
  ) then
    raise exception 'contact % is suppressed and cannot be stored', v_key
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.refuse_suppressed_contact() from public, anon, authenticated;

-- The trigger needs to fire on any update that could change the key, not only on an
-- update that names linkedin_url, and the column list was a narrowing with no benefit.
drop trigger if exists contacts_refuse_suppressed on public.contacts;

create trigger contacts_refuse_suppressed
  before insert or update on public.contacts
  for each row execute function public.refuse_suppressed_contact();

-- A suppression deletes the person, wherever the suppression came from.
create function public.apply_suppression()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.contacts c where c.linkedin_key = new.linkedin_key;
  return new;
end;
$$;

revoke all on function public.apply_suppression() from public, anon, authenticated;

create trigger contact_suppressions_apply
  after insert on public.contact_suppressions
  for each row execute function public.apply_suppression();
