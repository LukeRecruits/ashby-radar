-- Phase 2: make the job diff key the Ashby job id, not the job URL.
--
-- The build pack says to diff on ashby_job_url so a re-posted role is not mistaken for
-- a new one. Live probing shows the URL is not a stable identity: the posting API echoes
-- back whatever spelling of the board name you asked for. GET /openai returns jobUrls
-- under /openai, GET /OpenAI returns the same 833 jobs with jobUrls under /OpenAI. So a
-- correction to a company's stored board spelling would rewrite every one of its job
-- URLs and every job would look brand new.
--
-- The job id inside that URL is a stable UUID and is what we diff on instead. Same
-- intent, an identity that cannot drift. The URL stays for display.
--
-- Two useful side effects. If two spellings of one board ever survive discovery's
-- case-collapse as separate companies, the unique job id merges their jobs instead of
-- storing each twice. And a job is now identified independently of its board, so
-- re-pointing a job at a corrected company row is an update, not a duplicate.
--
-- jobs is empty at this point (phase 1 wrote no jobs), so this needs no backfill.

alter table jobs add column ashby_job_id uuid;

update jobs
   set ashby_job_id = nullif(split_part(ashby_job_url, '/', 5), '')::uuid
 where ashby_job_id is null;

delete from jobs where ashby_job_id is null;

alter table jobs alter column ashby_job_id set not null;
alter table jobs add constraint jobs_ashby_job_id_key unique (ashby_job_id);

-- The URL is derived from a mutable board spelling, so it can no longer carry a unique
-- constraint. Keep it indexed for lookups.
alter table jobs drop constraint jobs_ashby_job_url_key;
create index jobs_ashby_job_url_idx on jobs (ashby_job_url);
