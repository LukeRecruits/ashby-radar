# Ashby Radar

Finds every company using Ashby as its ATS, reads their open jobs every day, and flags
hiring signals.

It is a prospecting tool for CandidHQ, but it is a completely separate product: its own
repo, its own Supabase project, its own Vercel project. No CandidHQ code, packages, env
vars or design tokens are shared, in either direction.

## How it works

Ashby has no endpoint that lists its customers, so discovery is the core problem. Every
Ashby customer does have a public job board at `jobs.ashbyhq.com/{BOARD_NAME}`, and both
Common Crawl and the Internet Archive index those URLs. Radar mines those indexes for
board names, then verifies each one against Ashby's public Job Postings API:

```
GET https://api.ashbyhq.com/posting-api/job-board/{BOARD_NAME}?includeCompensation=true
```

One call returns every published job on a board. A 404 means the name is not an Ashby
board. Board names are case-sensitive and are stored exactly as found.

Three scheduled GitHub Actions workflows do all the work. Supabase holds all state.

| Workflow | Schedule | Does |
| --- | --- | --- |
| `discovery` | Weekly, Sun 03:00 UTC | Mines Common Crawl and Wayback for new board names |
| `refresh` | Daily, 05:00 UTC | Calls the posting API for every company, writes jobs and a daily snapshot |
| `triggers` | Daily, after refresh | Evaluates the six trigger rules, sends the digest, pushes to Clay |

`discovery` and `refresh` exist today. See Build status.

## Build status

- [x] Phase 1: foundations and discovery
- [x] Phase 2: verify and daily refresh
- [ ] Phase 3: triggers and hand-off
- [ ] Phase 4: coverage and benchmark
- [ ] Phase 5: public hiring snapshot page (stretch)

## What the live sources actually do

Nine things the public sources do that their docs do not say, each of which the code now
accounts for. Worth reading before changing discovery or the refresh.

1. **The posting API is case-insensitive on board names.** `/Linear`, `/linear` and
   `/LINEAR` all return the same 30 jobs. Crawl data contains multiple spellings of the
   same board, so discovery keeps the most-seen spelling per board. The first run saw
   8,563 spellings of 7,792 boards: 760 collapsed groups that would otherwise have been
   duplicate companies, each with its own daily API call, snapshots and triggers.
2. **Board names can contain spaces and dots.** `Local Infusion`, `the job sauce`,
   `Viz.ai` and `primer.io` are all real boards with live jobs.
3. **The board response has no company name.** Top-level keys are `jobs` and
   `apiVersion` only. The authoritative board spelling comes from each job's `jobUrl`.
4. **Common Crawl's index server 502s on wide prefix queries** at the default page size,
   and returns an intermittent 400. Requests use `pageSize=1`, a seven-step backoff
   ladder, and retry on 400.

5. **The posting API echoes your spelling back in every `jobUrl`.** `GET /openai`
   returns 833 jobs with URLs under `/openai`; `GET /OpenAI` returns the same 833 jobs
   with URLs under `/OpenAI`. The response holds no authoritative spelling anywhere, so
   the job URL is not a stable identity. Jobs are keyed on the Ashby job id instead, a
   UUID that cannot drift when a board's stored spelling is corrected. See migration
   0004.
6. **An empty board is a 200, not a 404.** Deel and Mercury are both live Ashby
   customers with nothing published today. `active` with zero open roles is an ordinary
   state, and the refresh writes a zero snapshot for it.
7. **There is no company name in the response at all.** The only two top-level keys are
   `jobs` and `apiVersion`, and no job field carries one. `display_name` therefore
   cannot be filled from the board and stays null until phase 4's careers-page scan
   supplies a real name from the company's own site. Board names are not names:
   `the job sauce` and `LIV-Golf` are what Ashby has.
8. **`isListed` is true on every job the API returns.** Unlisted jobs are absent rather
   than flagged, so `open_role_count` is simply the length of the array.
9. **With `includeCompensation=true` every job carries a `compensation` object**,
   populated or empty. Empty means the company does not publish pay on that job, and it
   agrees with `shouldDisplayCompensationOnJobPostings` exactly: 672 of OpenAI's 833.

A 404 is not evidence of junk. `Stanza` and `DECA Dental Group` are ordinary names that
404 because they are former Ashby customers. That is attrition, and the refresh records
it two ways: a name we never saw live becomes `not_found`, a company we have seen live
before becomes `inactive`. A failed check is neither. Its status is left untouched so a
network error can never be mistaken for a company leaving Ashby.

## Data model

Six tables, defined in `supabase/migrations/`.

| Table | Holds |
| --- | --- |
| `companies` | One row per board name. Unique on `(source, board_name)`. `source` leaves the door open for other ATSs later |
| `jobs` | One row per Ashby job id. Unique on `ashby_job_id`, which is why the daily diff cannot drift. Jobs are closed, never deleted |
| `snapshots` | One row per company per day. The basis for every trigger |
| `triggers` | One row per company per type per 30 days, with evidence |
| `runs` | One row per workflow run, for health checks |
| `discovery_log` | Where each board name came from, for debugging coverage |

Nothing is ever hard-deleted. Jobs get a `closed_at`, companies get an `inactive` status.

## Running it

There is no local development environment. Every change is committed and pushed, then
verified on the deployed output: the Actions run log, and the Supabase tables.

To run either workflow by hand: Actions tab, pick `discovery` or `refresh`, Run workflow.

The refresh is safe to run twice in a day. A company whose `last_checked_at` already
falls inside the current run date is skipped, so a rerun after a failure resumes where
the last one stopped and snapshots can never double up. Ashby is paced by a single
shared rate limiter rather than by the loop, so database writes for one company overlap
the next company's request while Ashby still sees one request per second.

## Rules for talking to Ashby

- Max 1 request per second to `api.ashbyhq.com`
- User-Agent: `AshbyRadar/1.0 (+contact: luke.eaton.mail@gmail.com)`
- Each company checked at most once per day
- Exponential backoff on 429 and 5xx

## Data rules

Company and job data only. No personal data about anyone, ever. Job descriptions are not
stored, only the fields in the schema.

## Secrets

All secrets live in GitHub Actions secrets. `.env.example` lists every one.

| Secret | Used by |
| --- | --- |
| `SUPABASE_URL` | every workflow |
| `SUPABASE_SERVICE_ROLE_KEY` | every workflow |
| `SLACK_WEBHOOK_URL` | phase 3 |
| `CLAY_WEBHOOK_URL` | phase 3 |

The service-role key never leaves GitHub Actions and server-side env vars.

## Config

Every threshold and rate limit lives in `src/config.ts`. Tune there, not in the logic.

## Out of scope

Other ATSs (Greenhouse, Lever, Workable) are designed for as a future `source` value but
not built. Finding people or emails is Clay's job downstream. Radar never sends email.
