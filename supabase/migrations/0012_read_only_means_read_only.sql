-- Make "read-only" true, because it was not.
--
-- The console's whole security model is one sentence: anon can select a handful of shaped
-- views and can do nothing else. Writing 0011 is what finally tested it, and it was
-- false.
--
-- Supabase ships `alter default privileges in schema public grant all on tables to anon,
-- authenticated`. Every table and every view created in `public` therefore arrives with
-- `arwdDxtm` already granted to anon: insert, update, delete, truncate, the lot. The
-- `grant select on lead_list to anon` lines in 0008, 0010 and 0011 did nothing at all.
-- They granted a privilege anon already had, and read like a restriction while being an
-- expansion of nothing.
--
-- On the base tables that was survivable, because RLS is enabled with no policies and RLS
-- outranks a grant. On a view it is not, for two compounding reasons:
--
--   1. **Views have no RLS of their own.** There is nothing to fall back on.
--   2. **These are plain (security definer) views deliberately**, so they execute with the
--      owner's rights. A write through one runs as the owner and so bypasses the base
--      tables' RLS entirely. The property that makes them a safe read surface is exactly
--      what makes a write through them unsafe.
--
-- And three of the four views added in 0011 are simple single-table selects with a where
-- clause, which Postgres makes **automatically updatable**. Confirmed, not inferred:
-- `information_schema.views` reported is_updatable YES for lead_roles, lead_history and
-- lead_signals, and an `update lead_signals set reviewed = true` run as anon was accepted
-- rather than refused. The publishable key is a browser-grade credential. It could have
-- rewritten the jobs table.
--
-- `lead_list`, `lead_facets` and `lead_role_groups` were never writable, but only because
-- aggregates and unions make a view non-auto-updatable. That is luck, not design, and it
-- is the second time in this project that a control nobody tested turned out not to be
-- doing its job. The first was the console being publicly readable while Vercel reported
-- it protected. Same lesson twice: assert it from the outside or do not claim it.
--
-- Two layers here, because one of them is about today and the other is about the next
-- view somebody adds.

-- 1. Today: take the write privileges off every object anon can name -----------

revoke insert, update, delete, truncate, references, trigger
  on lead_list, lead_facets, lead_roles, lead_role_groups, lead_history, lead_signals
  from anon, authenticated;

grant select
  on lead_list, lead_facets, lead_roles, lead_role_groups, lead_history, lead_signals
  to anon, authenticated;

-- The base tables are protected by RLS rather than by grants, which held, but a privilege
-- nothing should ever use is a privilege worth not holding. Defence in depth: if RLS is
-- ever disabled on one of these by accident, the grant should not be waiting underneath.
-- `select` goes too: anon has never been able to read a row from any of them and the
-- console reads the views instead.

revoke all on companies, jobs, snapshots, triggers, runs, discovery_log, settings
  from anon, authenticated;

-- 2. Tomorrow: stop the defaults handing it all back ---------------------------
--
-- Without this, the next `create view` in this schema arrives writable by anon again and
-- the person adding it will have no reason to suspect that.
--
-- Supabase sets these defaults twice over, once for `postgres` and once for
-- `supabase_admin`. Only the `postgres` set can be changed from here: the second raises
-- "42501: permission denied to change default privileges", because the connecting role is
-- not a member of supabase_admin. It is also the one that does not matter in practice,
-- since everything in this project is created as `postgres` (migrations through the API,
-- and the dashboard's SQL editor alike). Worth knowing rather than worth fighting: if an
-- object ever does arrive owned by supabase_admin, it will carry the write grants again,
-- so the check below is the thing to run, not this line.
--
--   select table_name, string_agg(privilege_type, ',')
--     from information_schema.role_table_grants
--    where grantee in ('anon','authenticated') and table_schema = 'public'
--    group by table_name;
--
-- Every row of that should read SELECT and nothing else. Anything with an INSERT, UPDATE
-- or DELETE beside it is this bug again.

alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;

-- service_role keeps everything. The three GitHub Actions workflows write through it, and
-- it is the only key that is never exposed to a browser.
