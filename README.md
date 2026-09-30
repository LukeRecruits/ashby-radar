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
| `triggers` | Daily, 07:15 UTC | Evaluates the six rules, pushes to Clay, sends the Monday digest |
| `export` | Manual only | Writes companies.csv and triggers.csv as run artifacts |

## Build status

- [x] Phase 1: foundations and discovery
- [x] Phase 2: verify and daily refresh
- [x] Phase 3: triggers and hand-off
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

Seven tables, defined in `supabase/migrations/`.

| Table | Holds |
| --- | --- |
| `companies` | One row per board name. Unique on `(source, board_name)`. `source` leaves the door open for other ATSs later |
| `jobs` | One row per Ashby job id. Unique on `ashby_job_id`, which is why the daily diff cannot drift. Jobs are closed, never deleted |
| `snapshots` | One row per company per day. The basis for every trigger |
| `triggers` | One row per company per type per 30 days, with evidence |
| `runs` | One row per workflow run, for health checks |
| `discovery_log` | Where each board name came from, for debugging coverage |
| `settings` | Key/value state that is not about a company: the backfill marker and the last digest timestamp |

Nothing is ever hard-deleted. Jobs get a `closed_at`, companies get an `inactive` status.

## Triggers

Six rules, evaluated every morning after the refresh. Each one writes a row to
`triggers` with evidence attached, and fires at most once per company per type per 30
days. The rules themselves are Postgres functions in migration 0005, because each is a
set comparison across every active company at once and doing that in TypeScript would
be thousands of round trips a day. Every threshold is a function parameter passed from
`src/config.ts`, so that file is still the only place anything is tuned.

| Trigger | Fires when |
| --- | --- |
| `new_to_ashby` | A company's first successful check, if it was discovered after the initial backfill |
| `hiring_spike` | Open roles up 5 or more on 30 days ago |
| `first_recruiter` | A recruiting hire appears where there was none in the previous 90 days |
| `sweet_spot` | Open roles enter the 5-50 band from outside it |
| `long_open` | A role published 60+ days ago is still open |
| `publishes_comp` | Pay is shown on a job for the first time |

### Warm-up, and why silence is not a bug

Four of the six compare today against our own history, so they return nothing until
that history exists. None of them is date-gated. Each enforces its own precondition, so
they start firing the day the data supports them:

- `new_to_ashby` needs the backfill marker, described below.
- `hiring_spike` and `sweet_spot` need a snapshot from about 30 days ago. Both take the
  latest snapshot inside a window ending 30 days back rather than demanding one dated
  exactly 30 days back, so a missed morning degrades the comparison instead of
  silencing the rule.
- `first_recruiter` and `publishes_comp` need at least one earlier snapshot, because
  "there was no recruiter before" is not a claim we can make about a company we had not
  yet seen. Both would otherwise fire for every company on the board the day history
  starts.

`long_open` is the exception. It reads `publishedAt` from Ashby rather than from our
own history, so it is true from day one. That also makes it by far the loudest rule:
on the first evaluation roughly three quarters of active boards qualify, because most
companies have something stale. If the weekly digest is nothing but `long_open`, raise
`minAgeDays` in `src/config.ts`.

### The backfill marker

`settings.initial_backfill_completed_at` is set automatically, by the trigger run, the
first time no company is left in `unverified`. Two things follow from that:

- It cannot be armed early, so `new_to_ashby` cannot fire for all 5,731 discovered
  companies at once.
- Setting it is never retroactive either, because the rule only fires for companies
  whose `first_seen_at` is later than the marker.

### Hand-off

The Clay push sends one row per unexported trigger to the table webhook and sets
`exported_at` only for the rows Clay accepted, so a failure mid-run loses nothing. It
is capped per run (`config.clay.maxPerRun`), which drains the first evaluation's
backlog over a few days rather than dumping thousands of rows into Clay at once.

The Slack digest goes out on Mondays as part of the same workflow, rather than on its
own schedule, so it can never run before the day's triggers have been evaluated. Its
window runs from the last digest sent, not a fixed seven days, so a missed Monday is
caught up rather than skipped. Inside each type the most useful entries come first:
companies in the 5-50 band outrank a 3,000-role job marketplace, which is otherwise
what sorting on size alone puts at the top of every list.

## Running it

There is no local development environment. Every change is committed and pushed, then
verified on the deployed output: the Actions run log, and the Supabase tables.

To run anything by hand: Actions tab, pick the workflow, Run workflow. `triggers` takes
a `digest` checkbox that sends the Slack digest whatever day it is. `export` takes a
date range and leaves `companies.csv` and `triggers.csv` as artifacts on the run.

The refresh is safe to run twice in a day. A company whose `last_checked_at` already
falls inside the current run date is skipped, so a rerun after a failure resumes where
the last one stopped and snapshots can never double up. Ashby is paced by a single
shared rate limiter rather than by the loop, so database writes for one company overlap
the next company's request while Ashby still sees one request per second.

The trigger run is safe to repeat too. Every rule excludes companies that already have
a trigger of that type inside the dedupe window, so a second run the same day finds
nothing new.

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
| `SLACK_WEBHOOK_URL` | the weekly digest. Without it the digest logs a warning and sends nothing |
| `CLAY_WEBHOOK_URL` | the Clay hand-off. Without it nothing is pushed and nothing is marked exported |

The service-role key never leaves GitHub Actions and server-side env vars.

## Config

Every threshold and rate limit lives in `src/config.ts`. Tune there, not in the logic.

## Out of scope

Other ATSs (Greenhouse, Lever, Workable) are designed for as a future `source` value but
not built. Finding people or emails is Clay's job downstream. Radar never sends email.
