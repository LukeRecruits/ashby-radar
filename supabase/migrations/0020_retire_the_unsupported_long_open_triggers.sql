-- Take back the 1,387 claims the rule no longer stands behind.
--
-- 0019 put a floor under long_open and stopped counting evergreen postings as stale
-- roles. That changes the rule going forward and does nothing about the 2,518 triggers
-- already on the board, which are what the console actually renders: the stalling badge
-- on the lead list, `signal_count`, and the evidence panel on the company page all read
-- the `triggers` table, not the rule.
--
-- So until these are cleared, the floor has changed nothing anybody can see, and the
-- console goes on showing a signal for 1,387 companies that the rule would now refuse to
-- fire for. Measured before deleting: 2,518 fired, 1,131 still supported, 1,387 not.
--
-- These are deleted rather than kept as history. A trigger row is a claim that this
-- company is worth talking to and an opener to use on them, and a claim produced by a
-- rule we have since decided was wrong is not history worth keeping, it is a landmine in
-- a list meant to be worked by hand. The rule re-fires for any company that qualifies
-- tomorrow, so nothing true is lost.
--
-- Written as a set comparison against the same conditions 0019's function uses, rather
-- than against a list of ids, so it deletes exactly what the rule would refuse today.

with today as (
  select s.company_id, s.open_role_count
    from public.snapshots s
   where s.snapshot_date = (select max(s2.snapshot_date) from public.snapshots s2)
), stale as (
  select j.company_id
    from public.jobs j
   where j.closed_at is null
     and j.published_at is not null
     and not j.is_evergreen
     and j.published_at < now() - interval '120 days'
   group by j.company_id
   having count(*) >= 3
), qualifies as (
  select t.company_id
    from today t
    join stale s on s.company_id = t.company_id
   where t.open_role_count between 5 and 50
)
delete from public.triggers t
 where t.type = 'long_open'
   and not exists (select 1 from qualifies q where q.company_id = t.company_id);
