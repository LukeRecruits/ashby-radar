-- "Last success" was defined as a run with zero failures, which is wrong twice over.
--
-- The health page went live and immediately reported Discovery as having never succeeded
-- and being late. Discovery has run once, successfully: it swept 7,792 board names and
-- five Common Crawl index pages failed, which is the documented normal behaviour of that
-- index server and precisely why there is a seven-step backoff ladder. A run that did its
-- job with a handful of retried pages is a success, and a health page that cries wolf on
-- day one gets ignored by day three.
--
-- The second fault has not happened yet and would have been worse. The retention job sets
-- `succeeded` to the number of contacts it deleted, so a month with nothing to delete
-- finishes with succeeded = 0 and failed = 0. Under any definition keyed on succeeded > 0
-- it would never register a success and would show as permanently late, which is the
-- health page inventing exactly the kind of quiet failure it exists to detect.
--
-- So: finished, and either nothing failed or more succeeded than failed. That accepts the
-- no-op, accepts the run with a few retries, and still rejects a run that mostly failed or
-- one that never finished. `failed_30d` stays on the page beside it, so a rising failure
-- count is still visible even while the runs keep passing.

create or replace view public.health_workflows as
select
  r.workflow,
  count(*)                                              as runs_30d,
  max(r.started_at)                                     as last_run_at,
  max(r.finished_at) filter (
    where r.finished_at is not null and (r.failed = 0 or r.succeeded > r.failed)
  )                                                     as last_success_at,
  round(extract(epoch from (now() - max(r.started_at))) / 3600)::int
                                                        as hours_since_run,
  round(extract(epoch from (
    now() - max(r.finished_at) filter (
      where r.finished_at is not null and (r.failed = 0 or r.succeeded > r.failed)
    )
  )) / 3600)::int                                       as hours_since_success,
  sum(r.checked)                                        as checked_30d,
  sum(r.failed)                                         as failed_30d
from public.runs r
where r.started_at > now() - interval '30 days'
group by r.workflow;
