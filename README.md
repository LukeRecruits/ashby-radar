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
| `enrich` | Weekly, Sun 06:30 UTC | Company names from board pages, then domain resolution |
| `refresh` | Daily, 05:00 UTC | Calls the posting API for every company, writes jobs and a daily snapshot |
| `triggers` | Daily, 07:15 UTC | Evaluates the six rules and writes signals |
| `export` | Manual only | Writes companies.csv and triggers.csv as run artifacts |

## Build status

- [x] Phase 1: foundations and discovery
- [x] Phase 2: verify and daily refresh
- [x] Phase 3: triggers and hand-off
- [x] Console 1: clean locations and the `lead_list` read surface
- [ ] Console 2: the lead list page
- [ ] Console 3: the company page
- [ ] Console 4: contacts, found on demand
- [ ] Console 5: the outreach funnel and the daily work queue
- [ ] Console 6: health page, and a floor under `long_open`

The original build pack's phases 4 and 5 (coverage benchmark, public snapshot page) are
superseded. On 2026-09-30 the product became a lead list rather than a signal feed, and
the console is how it is worked. Coverage benchmarking is still worth doing later; the
public page is not currently planned.

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
| `lead_list` | A **view**, not a table. One row per company with its latest snapshot, stale-role counts and signals. The console's entire read surface |

`companies` carries the lead fields: `display_name`, `domain` with a `domain_confidence`
and `domain_source`, `top_country` / `top_locality` / `remote_share` derived from where
the open roles actually are, and `parked_at` for companies set aside by hand.

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
| `long_open` | A role published 120+ days ago is still open |
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
own history, so it is true from day one. That also makes it by far the loudest rule.
At the 60 days the build pack specced, the first evaluation fired it for 3,217 of the
4,167 active boards: 77%, which is a directory rather than a prospect list, because
almost every company has something stale. `minAgeDays` is now 120. If it ever goes back
down, put a floor under `staleRoles` at the same time.

### The backfill marker

`settings.initial_backfill_completed_at` is set automatically, by the trigger run, the
first time no company is left in `unverified`. Two things follow from that:

- It cannot be armed early, so `new_to_ashby` cannot fire for all 5,731 discovered
  companies at once.
- Setting it is never retroactive either, because the rule only fires for companies
  whose `first_seen_at` is later than the marker.

### Why there is no longer a Clay push or a Slack digest

Both were built in phase 3 and both are now decided against. The code and the npm
scripts remain (`npm run clay`, `npm run digest`); neither runs on a schedule.

**Clay was dropped on 2026-10-01.** It had four jobs here: hold the list, segment it,
resolve the missing domains, and find the contact. The console does the first two, the
missing domains are being filled by hand, and Exa does the fourth better than Clay did:
a single search returns the TA leader's name, exact title, seniority, LinkedIn URL and
time in post, at $4 per 1,000 searches against $167 a month for the Clay tier that would
hold 4,000 rows. Clay's free tier caps a table at 200 rows, and its API would not let us
query on job title at all, so we had never actually proved it could do the one thing it
was for.

**The digest was never wanted.** A weekly summary is the wrong shape for a list worked by
hand at twenty companies a week; the console's work queue is the right one.

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

## The console

A Next.js app in `web/`, deployed as the Vercel project `ashby-radar-console`
(`team_JHU45F3lvdghoCwutnM1jddg`), separate from every other project Luke runs. Pushes to
`main` deploy it; there is no local dev here either.

**Access is Vercel Authentication, not a password.** Every deployment URL requires being
signed into Vercel with access to the team, which for a one-person internal tool is
stronger than a shared password and has nothing to remember. Switching to a password is a
single project setting if the URL ever needs showing to someone off the team.

It needs two environment variables, `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, both
set on Production. Preview branches have none, so a PR preview will fail to read the
database until they are added: the same trap CandidHQ has.

**It reads one view and can write nothing.** `lead_list` is granted to `anon`; every base
table keeps RLS enabled with no policies, so the anon role returns zero rows from
`companies`, `jobs`, `snapshots`, `triggers` and `runs`, and cannot write to any of them.
Verified by setting the role and trying. Writes the console needs (parking a company,
moving a contact through the funnel) go through server actions with a narrow key, not
through the view.

`lead_list` is a plain view rather than `security_invoker`, deliberately. It runs with the
owner's rights and so reads through the base tables' RLS, which means one shaped read-only
surface is exposed instead of granting `anon` direct select on four tables and trying to
narrow it back down afterwards.

A realistic filtered query over the full 5,731 rows (UK, 5-50 roles, no in-house
recruiter, sorted by open roles) plans in 3ms and executes in 34ms, all from shared
buffers. No materialised view needed.

A second view, `lead_facets`, supplies the country and city filter options with company
counts. PostgREST has no distinct-with-count, and deriving 465 cities in the application
would mean reading every row to populate a dropdown. The counts are over all live unparked
companies rather than over the current filter, which keeps San Francisco, New York and
London at the top of the city list instead of Albany.

Every filter lives in the query string, so a segment is a link worth bookmarking and the
back button behaves. Sorting always puts nulls last: a company with no 30-day baseline yet
is not the fastest-growing company on the list, which is where the default would put it
while the history is still filling. Paging tiebreaks on `id`, because most companies share
an open-role count and offset paging over ties repeats and skips rows.

### Locations, and why they needed cleaning first

Country and city are the segmentation Luke asked for by name, so they had to be true
before anything was built on them. Four faults, all fixed in migrations 0008 and 0009 for
the history and in `src/enrich/location.ts` for every refresh from now on:

- **One city under two names.** "New York City" on 425 companies and "New York" on 485
  are one market shown as two. Same for Bangalore/Bengaluru, München/Munich,
  Zürich/Zurich, Sao Paulo/São Paulo and four spellings of Washington DC. New York is now
  572 companies in one place.
- **A country in the city field.** "United States" was the fifth most common *city*, on
  170 companies.
- **A continent in either field.** "Europe", "Latin America", "LATAM", "North America".
- **A remote policy in the country field.** "Any Location", "Remote - Global",
  "Europe (CET +/- 1h)".

Two things that look like the same fault and are not. Singapore, Hong Kong, Luxembourg,
Gibraltar and Monaco are city-states where locality equalling country is correct, and a
blanket rule would have binned 74 Singapore companies. And boroughs are left alone:
Brooklyn is not folded into New York, South San Francisco not into San Francisco, because
those are answers in their own right.

The first attempt at the country-in-city rule compared the two fields, which missed the
two companies whose city said "United States" while their country said "U.S.A" and
"India". A country name in a city field is wrong whatever sits beside it, so the rule
drops it outright. Worth remembering as the general shape of the mistake: the comparison
felt safer and was simply narrower.

After both migrations: 72 distinct countries, 465 distinct cities, zero junk values,
3,588 companies with a country and 3,112 with a city.

### Contacts

Not built yet, and not until the paperwork is. See **Data rules** below.

## Rules for talking to Ashby

- Max 1 request per second to `api.ashbyhq.com`
- User-Agent: `AshbyRadar/1.0 (+contact: luke.eaton.mail@gmail.com)`
- Each company checked at most once per day
- Exponential backoff on 429 and 5xx

## Data rules

**Company and job data only, until the paperwork says otherwise.**

Phase 3's position was that Radar never stores a person and Clay holds the contacts. Half
of that changed on 2026-10-01: Clay is gone, and Luke needs an outreach funnel tracked per
contact, which means Radar will store people. That is a deliberate reversal, not a drift,
and it carries conditions.

Before a contacts table exists, all of this has to:

- a written legitimate interests assessment (Article 6(1)(f))
- an Article 14 notice, discharged in the first LinkedIn message via a link to a
  prospecting privacy notice on candidhq.tech, since the data comes from a public profile
  rather than from the person
- a suppression list keyed on the LinkedIn profile URL, so a removal survives the next
  lookup re-finding them
- a stated retention period
- a line in the record of processing activities

CandidHQ's ICO registration (C1941533) covers the activity, since Radar is a CandidHQ
prospecting tool. Data minimisation does the rest of the work: name, current title,
LinkedIn URL and company, and nothing else. No email, no phone, no biography, no posts.

Contacts are found on demand through Exa rather than crawled in bulk, so Radar holds a
person only once Luke has decided to approach them.

Job descriptions are still not stored. The refresh reads them to extract the company's
own domain and discards them; only the hostname is kept.

## Secrets

All secrets live in GitHub Actions secrets. `.env.example` lists every one.

| Secret | Used by |
| --- | --- |
| `SUPABASE_URL` | every workflow |
| `SUPABASE_SERVICE_ROLE_KEY` | every workflow |
| `SLACK_WEBHOOK_URL` | the weekly digest, which no longer runs on a schedule. Never set |
| `CLAY_WEBHOOK_URL` | the Clay hand-off, now retired. Never set, and deliberately so |

The service-role key never leaves GitHub Actions and server-side env vars.

## Config

Every threshold and rate limit lives in `src/config.ts`. Tune there, not in the logic.

## Out of scope

Other ATSs (Greenhouse, Lever, Workable) are designed for as a future `source` value but
not built. Email addresses are out of scope: outreach is LinkedIn, by hand, using Luke's
own profile. Radar never sends email.
