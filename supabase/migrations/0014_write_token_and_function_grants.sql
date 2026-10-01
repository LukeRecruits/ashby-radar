-- Two things 0013 left open, both found by running the audit rather than by reading it.
--
-- 1. The write token was stored in plaintext. The console compares a shared secret
--    against settings.console_write_token, so a reader of that one row held a working
--    credential. There is no reason for the database to be able to reproduce the secret:
--    it only ever needs to recognise it. So it stores a SHA-256 of the token instead,
--    under a new key, and the plaintext exists in exactly one place, the console's
--    environment variable. Rotating it is now two steps that cannot be done in the wrong
--    order by accident: set the new hash here, set the new value in Vercel.
--
-- 2. anon could execute eleven functions, not four. Postgres grants EXECUTE on a new
--    function to PUBLIC, and the seven trigger-rule functions from 0005 predate the
--    default-privilege change at the top of 0013, so they were still carrying it.
--
--    They leak nothing: every one is `security invoker`, verified rather than assumed
--    (`pg_proc.prosecdef` is false for all seven), so an anon caller reads through the
--    base tables' RLS and gets an empty set. But "the console can execute four named
--    functions and nothing else" is a sentence worth being able to say without a
--    footnote, and an empty result from a function anon should not be able to call is
--    the kind of thing that stops being harmless when somebody later adds a
--    `security definer` to one of them for an unrelated reason.

-- 1. Hash the token ----------------------------------------------------------
--
-- `extensions.digest` is pgcrypto, which Supabase installs in the `extensions` schema.
-- Schema-qualified because search_path is pinned empty.
--
-- Still fails closed: no settings row, a short token, or an empty one denies the write.
-- The length floor is on the presented token rather than the stored hash, so a two
-- character token cannot be set by mistake and then used.

create or replace function public.console_write_allowed(p_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    length(btrim(coalesce(p_token, ''))) >= 24
      and (
        select s.value #>> '{}'
          from public.settings s
         where s.key = 'console_write_token_sha256'
      ) = encode(extensions.digest(btrim(p_token), 'sha256'), 'hex'),
    false
  );
$$;

revoke all on function public.console_write_allowed(text) from public, anon, authenticated;

-- The plaintext key from 0013 never held a value, but delete it so nothing can be
-- confused about which key is live.
delete from public.settings where key = 'console_write_token';

-- 2. Take EXECUTE off the rule functions --------------------------------------
--
-- service_role keeps its explicit grant, which is what the triggers workflow uses.
-- set_updated_at is deliberately left alone: it returns `trigger`, so PostgREST will not
-- expose it, and trigger firing is a worse thing to be clever about than this is worth.

revoke execute on function public.baseline_snapshots(date, int, int) from public, anon, authenticated;
revoke execute on function public.candidates_new_to_ashby(date, timestamptz, int) from public, anon, authenticated;
revoke execute on function public.candidates_hiring_spike(date, int, int, int, int, int) from public, anon, authenticated;
revoke execute on function public.candidates_first_recruiter(date, int, int) from public, anon, authenticated;
revoke execute on function public.candidates_sweet_spot(date, int, int, int, int, int) from public, anon, authenticated;
revoke execute on function public.candidates_long_open(date, int, int, int) from public, anon, authenticated;
revoke execute on function public.candidates_publishes_comp(date, int, int) from public, anon, authenticated;
