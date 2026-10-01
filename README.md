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
| `retention` | Monthly, 1st 04:00 UTC | Deletes contacts past the 24-month retention period |
| `export` | Manual only | Writes companies.csv and triggers.csv as run artifacts |

## Build status

- [x] Phase 1: foundations and discovery
- [x] Phase 2: verify and daily refresh
- [x] Phase 3: triggers and hand-off
- [x] Console 1: clean locations and the `lead_list` read surface
- [x] Console 2: the lead list page
- [x] Console 3: the company page
- [x] Console 4: contacts, found on demand
- [x] Console 5: the outreach funnel and the daily work queue
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

Eleven tables, defined in `supabase/migrations/`.

| Table | Holds |
| --- | --- |
| `companies` | One row per board name. Unique on `(source, board_name)`. `source` leaves the door open for other ATSs later |
| `jobs` | One row per Ashby job id. Unique on `ashby_job_id`, which is why the daily diff cannot drift. Jobs are closed, never deleted |
| `snapshots` | One row per company per day. The basis for every trigger |
| `triggers` | One row per company per type per 30 days, with evidence |
| `runs` | One row per workflow run, for health checks |
| `discovery_log` | Where each board name came from, for debugging coverage |
| `settings` | Key/value state that is not about a company: the backfill marker, the last digest timestamp, and the SHA-256 of the console's write token |
| `contacts` | One row per person. Four fields and some dates, nothing else. Unique on the normalised LinkedIn URL |
| `contact_suppressions` | Profile URLs that must never be stored again. The only table kept indefinitely |
| `contact_stages` | The ladder: stage, position, label, whether it is terminal, whether the ball is with us |
| `contact_stage_events` | One row per transition. A contact id, a stage and a timestamp. The id goes null when the contact is deleted, so the invitation count survives an erasure |

**`has_in_house_ta` is a misnomer and the console no longer repeats it.** It is true when
a *recruiting role is open* on the board, which is not the same claim as "they have no
talent team", and the console used to render it as "In-house TA: Nobody". The first live
contact lookup disproved the inference on the first company tried: Synthesia is flagged
false and has a Head of Talent of eighteen months plus ten others. Every label now says
"recruiter req", and the 1,489 companies qualified on it are "not hiring a recruiter
today", which is a weaker and more useful claim. The column keeps its name, because
renaming it means recreating `lead_list` for no behavioural gain; it carries a comment in
the database saying this.

`companies` carries the lead fields: `display_name`, `domain` with a `domain_confidence`
and `domain_source`, `top_country` / `top_locality` / `remote_share` derived from where
the open roles actually are, and `parked_at` for companies set aside by hand.

Nothing is ever hard-deleted. Jobs get a `closed_at`, companies get an `inactive` status.

### The ten views the console reads

The console never touches a base table. Ten views are its entire read surface, each one
granted `select` to `anon` and nothing more. Its writes are five named functions, not a
view and not a key; see **The console's write path**.

| View | Holds | Read by |
| --- | --- | --- |
| `lead_list` | One row per company: latest snapshot, stale-role counts, signal timestamps, role band | The lead list, and the company page header |
| `lead_facets` | Country and city filter options with company counts | The filter bar |
| `lead_roles` | Open roles, one per row, with an `age_days` | The longest-open and newest-posted tables |
| `lead_role_groups` | Open roles rolled up by department, city, country and workplace, each with stale and paid counts | The four breakdown charts |
| `lead_history` | Up to 120 days of daily snapshots per company | The trend sparkline |
| `lead_signals` | Fired triggers with their jsonb evidence | The signals panel |
| `lead_contacts` | The people on the list for a company, with their stage | The contacts panel |
| `work_queue` | Every live contact with its next action and the company context | The work queue |
| `funnel_counts` | Contacts per stage, including the empty stages | The funnel strip, and the stage picker |
| `invite_usage` | Invitations sent in the rolling 7 days, 24 hours and 30 days | The invitation meter |

`remote_share` counts only roles whose `workplaceType` is `Remote`, over the roles that
state one. Until migration 0011 it counted Ashby's `isRemote`, which is true for Hybrid
as well: 35,102 of 64,827 open roles have `isRemote` true, but only 18,448 are Remote and
16,678 are Hybrid, so a company posting nothing but hybrid roles read as 100% remote. The
denominator excludes the 8,667 roles that say nothing about workplace at all, and a
company whose roles are all silent gets null rather than 0%. `src/enrich/location.ts` and
migration 0011 implement the same definition and have to stay in step, the same way the
location cleanup does.

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

**Access is HTTP Basic auth in `web/proxy.ts`, and it fails closed.**

The first deployment of this app was publicly readable. Vercel reported the project as
protected (`ssoProtection: enabled`, `deploymentType: all_except_custom_domains`) and the
production `.vercel.app` URL still answered 200 to an anonymous `curl` and served the
entire lead list. It was taken down within a minute. Whatever the cause (plan tier, or
that setting not covering production aliases), the conclusion stands: protection that
lives in a dashboard is protection you cannot test from inside the application, and in
this case could not reliably be read back either.

So the gate is code now. `proxy.ts` checks a password from `CONSOLE_PASSWORD` on every
path, static chunks included, and denies when that variable is unset or empty. A
misconfiguration therefore produces a console nobody can reach rather than a lead list
anyone can read. Any username is accepted; on a single-operator tool a username is a
field to remember rather than a second factor.

Verify it after any change to the gate, because this is the one thing that has already
gone wrong once:

```
curl -s -o /dev/null -w '%{http_code}\n' https://ashby-radar-console.vercel.app/
curl -s -o /dev/null -w '%{http_code}\n' -u "luke:$CONSOLE_PASSWORD" https://ashby-radar-console.vercel.app/
```

401 then 200. Rotate the password in the Vercel project's environment variables; nothing
in the repo needs to change.

Routes: `/` the work queue, `/leads` the lead list, `/company/{id}` one company. The
`from` parameter on a company link carries the whole path back rather than a query string,
so "back" returns to whichever of the two you came from, and it is validated as a local
path at the other end.

Five environment variables: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`CONSOLE_PASSWORD`, `CONSOLE_WRITE_TOKEN` and `EXA_API_KEY`. All three are set on Production and Development. Preview has none, so
a PR preview will answer 401 and could not read the database anyway: the same trap
CandidHQ has, and here it fails safe.

**Root Directory must be `web` in the project's build settings.** Without it a git push
builds from the repo root, finds no Next.js, and fails with "No Next.js version
detected". That is a dashboard field; the API token available here cannot write project
settings.

**It reads seven views, and its only writes are four named functions.** The read half
only became true in migration 0012.
Every base table keeps RLS enabled with no policies, so the anon role returns zero rows
from `companies`, `jobs`, `snapshots`, `triggers` and `runs`. Writes the console needs
(parking a company, moving a contact through the funnel) go through server actions with a
narrow key, not through a view.

The views are plain views rather than `security_invoker`, deliberately. They run with the
owner's rights and so read through the base tables' RLS, which means a handful of shaped
read-only surfaces are exposed instead of granting `anon` direct select on five tables and
trying to narrow it back down afterwards.

**The write hole that was open until 2026-10-01.** Supabase ships `alter default
privileges in schema public grant all on tables to anon, authenticated`, so every view
created in `public` arrives with insert, update, delete and truncate already granted to
anon. The `grant select on lead_list to anon` lines in migrations 0008, 0010 and 0011 did
nothing: they granted a privilege anon already held, and read like a restriction while
restricting nothing.

On the base tables that was survivable, because RLS outranks a grant. On these views it
was not, because a view has no RLS of its own and a plain view's writes execute with the
owner's rights, which is to say they bypass the base tables' RLS entirely. The property
that makes a plain view a safe read surface is exactly what makes a write through one
unsafe. And three of the four views added in 0011 are simple single-table selects, which
Postgres makes automatically updatable: `information_schema.views` reported `is_updatable`
YES for `lead_roles`, `lead_history` and `lead_signals`, and `update lead_signals set
reviewed = true` run as anon was accepted rather than refused. The publishable key is a
browser-grade credential and it could have rewritten the jobs table.

`lead_list`, `lead_facets` and `lead_role_groups` were never writable, but only because
aggregates and unions make a view non-auto-updatable. That is luck, not design. Migration
0012 revokes every write privilege from anon and authenticated on all six views, revokes
everything on all seven base tables, and takes the write privileges out of the schema's
default privileges so the next view added does not arrive wide open.

This is the second control in this project that turned out not to be doing its job the
first time anyone tested it from the outside; the console being publicly readable while
Vercel reported it protected was the first. Run this after any migration that adds a view:

```sql
select table_name, string_agg(privilege_type, ',')
  from information_schema.role_table_grants
 where grantee in ('anon','authenticated') and table_schema = 'public'
 group by table_name;
```

Every row should read `SELECT` and nothing else.

A realistic filtered query over the full 5,731 rows (UK, 5-50 roles, no open recruiter
req, sorted by open roles) plans in 3ms and executes in 34ms, all from shared
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

### The company page

`/company/{id}`, reached by clicking a company name in the list. It answers the question
after "who looks interesting", which is the one that costs something: LinkedIn allows
roughly a hundred invitations a rolling week, so every company opened here is a decision.

Six reads in parallel, all keyed on `company_id`, nothing written. The page carries a stat
strip (open roles and band, 30-day change, open recruiter reqs, pay published, stalling count,
oldest open role), the open-role trend, signals with their evidence, four breakdowns
(department, city, country, workplace), the twelve longest-open and twelve newest roles,
and a provenance panel saying how we came to believe the domain belongs to the company.

Three things worth knowing before changing it:

- **The trend is a hand-drawn inline SVG, not a chart library.** One series with at most
  120 points did not justify the console's first client-side dependency, and the whole app
  is server components. Per-point tooltips are plain SVG `<title>` elements, so hover works
  with no JavaScript at all. The y axis spans the series rather than starting at zero,
  which is right for a trend line and wrong for a bar, and both end values are printed so
  the span is never merely implied.
- **`lead_role_groups` repeats `from jobs where closed_at is null` four times on purpose.**
  The first version shared one CTE, which is tidier and was 25 times slower: a CTE is an
  optimisation fence, so Postgres materialised all 64,827 open roles, scanned that four
  times and discarded 64,797 rows each time. 83ms, with `jobs_company_open_idx` never
  touched. Repeating the from-clause lets the `company_id` predicate push into each branch:
  index scan, 3.2ms for OpenAI's 836 roles. Do not refactor the repetition away.
- **Breakdowns fold the tail into "Other" past eight groups**, and the bars plus Other
  always sum to the open-role count, so a chart cannot quietly disagree with the number in
  the header. OpenAI has 33 departments; a chart of 33 bars answers nothing.

Signal evidence has been stored as jsonb on every trigger row since phase 3 and nothing
ever read it back until now. Each rule gets its own sentence rather than a key/value dump,
because the sentence is the usable thing: "four roles open 120+ days, the oldest 214" is an
opener. There is a generic branch underneath, so a rule added later renders something
useful on the day it fires rather than on the day somebody remembers to come back here.

The link out to LinkedIn is a company name search, not a person. Finding the person is
the contacts panel below it.

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

Built, and the paperwork came first. The panel sits on the company page and does three
things: shows who is already on the list, finds the talent lead on demand, and records an
objection permanently.

**Finding is not storing.** Pressing "Find the talent lead" runs one Exa search in that
render and shows what came back. Nothing is written. A person reaches the database only
when Add is pressed, which is the whole basis of the minimisation claim in
`docs/prospecting-lia.md`: Radar holds somebody only once Luke has decided to approach
them.

**Two filters, because the search alone is not trustworthy.** A people search for Vertice
returned people at STRATOS, CUBE and BigID. So a candidate is kept only if Exa's
structured work history shows an open-ended role at this company (`lib/employer.ts`,
matching on the company name and the domain label, conservatively: shared tokens have to
include one of four characters or more, otherwise "Atlas" matches "Atlas Copco"), and
only if the title is a talent, people or recruiting one (`lib/titles.ts`, which also
ranks them, seniority first, with coordinators and sourcers last rather than excluded).
Everyone dropped is counted and the reason is printed, so an empty result is never just
empty.

**Remove and Objected are different buttons on purpose.** Remove takes a row out and a
later search can find them again, which is right for somebody added by mistake. Objected
records the profile URL on the suppression list for good, deletes them, and makes any
future insert fail. That is the Article 21(2) path and it is the one that has to be
irreversible.

Four fields are stored: name, current job title, profile URL, employer. Exa returns
location, seniority band, time in post and a biography; those are used to rank and filter
in memory and there is nowhere in the schema to put them.

**The suppression trigger did not work the first time, and the reason is worth keeping.**
`linkedin_key` is a stored generated column, and **a generated column is computed after
BEFORE triggers run**, so `new.linkedin_key` was null inside the check, `where
linkedin_key = null` matched nothing, and a suppressed person could be re-added. Tested
from outside through PostgREST, it took one suppress and one add to see it. Migration
0015 computes the key in the trigger instead. That is three for three now: a control in
this project has never worked the first time it was asserted from outside the thing
making the claim.

### The console's write path

The console holds the publishable key, which grants `anon`, and `anon` can write nothing.
Contacts need writes, so there are four database functions and no new credential of any
power:

| Function | Does |
| --- | --- |
| `add_contact` | Upserts a person on the normalised profile URL. Refuses a suppressed one |
| `set_contact_connection` | Flips "already connected", the warm-list flag LinkedIn exposes no API for |
| `delete_contact` | Removes a row, leaving no suppression |
| `suppress_contact` | Records an objection and deletes them. Returns how many rows went |
| `set_contact_stage` | Moves somebody along the ladder, or ends it with a reason code |

Each is `security definer` and each checks a shared secret against
`settings.console_write_token_sha256` before doing anything. The secret lives in the
console's `CONSOLE_WRITE_TOKEN` and nowhere else; the database holds only its SHA-256, so
reading that row gives nobody a working credential. It fails closed: no settings row, an
empty token, or a token under 24 characters denies every write.

Why not the service-role key: one bug that leaks an environment variable or lets a
request reach an arbitrary URL would make the whole database writable. Why not an RLS
policy for `anon`: the publishable key is designed to be public, so that is a write
surface for anyone who ever sees it in a screenshot. With this arrangement, a leaked
publishable key can read the lead views, which was always true, and still cannot write a
row.

Verified from outside, as `anon`, through PostgREST:

```
select on contacts                      401, permission denied for table contacts
select on lead_contacts                 200
insert into contacts                    401, permission denied
patch lead_contacts                     401, permission denied for view lead_contacts
add_contact with a wrong token          42501 not permitted
add_contact with the right token        a uuid
add_contact for a suppressed person     23514 contact ... is suppressed
the same person, different URL spelling 23514 contact ... is suppressed
purge_expired_contacts                  401, permission denied for function
candidates_long_open                    401, permission denied for function
```

### The work queue

`/` is the work queue and `/leads` is the lead list. That is the right way round: the list
is fed weekly, the queue is worked daily.

**One ordered stage, not a row of checkboxes.** Identified, Invite sent, Connected,
Messaged, Replied, Demo booked, then two terminals, Customer and No. Checkboxes permit
states that cannot happen (customer, never contacted) and do not answer the only question
the page exists for, which is where somebody is now. The ladder is a table, so the views
order by `position` rather than repeating a CASE, and adding a stage later is an insert.

**"Already a connection" is not a stage.** It is a property of Luke's own network, it is
not exposed by any LinkedIn API on any tier, and it is a manual flag. What it changes is
the next action: somebody he is already connected to is a message from the moment they are
identified, with no invitation spent. Those are the warm list and the queue puts them
above the people who need inviting.

**Every transition is recorded by trigger, not by the caller.** So days-in-stage,
conversion between stages and the rolling invitation count are read out of the history
rather than maintained. A transition made by hand in the SQL editor is in the history too.
Setting the stage somebody is already on is allowed and restamps the clock, which is what
"Chased" does, and the trigger records no event for it, so the history stays a record of
transitions rather than of button presses.

**Deleting a contact must not delete the invitation.** The events table originally
cascaded from `contacts`, so removing somebody erased the record that an invitation had
been spent on them, and `invite_usage` reads the rolling count out of that history. Seen
while clearing a test row: the count went from 1 to 0 on the delete, and LinkedIn's count
did not. Deletions are not rare either, since the retention purge and every objection are
deletions. `contact_id` is now `on delete set null` (migration 0018), which leaves "an
invitation was sent on this date" with no subject attached. That is not personal data, so
it survives an erasure honestly, and the funnel's arithmetic outlives the retention period:
the shape of the funnel is ours, the people in it are theirs.

**The invitation budget is on the page.** LinkedIn allows roughly a hundred invitations per
rolling seven days on every tier including Sales Navigator, so the meter counts the same
rolling window rather than a calendar week, and turns warm at 75.

Sections render in priority order and an empty section does not render: Replied, To
message, To invite, Wanting a nudge, Waiting on them, Closed. Replies come first because a
reply going cold is the only thing here with a real cost to delay.

**The waiting thresholds live in `web/lib/queue.ts`, not in SQL**, because a view cannot
take a parameter and a number like "chase after seven days" buried in a view definition
stops being tunable. The view reports `days_in_stage` and the stage; the console decides
what counts as overdue. 21 days for an unanswered invitation, 7 for a message or a demo.

`no_reason` is a fixed vocabulary rather than free text, which is a data-protection choice
as much as a reporting one: a free-text note against a named person is an opinion held
indefinitely in a prospecting database, and `docs/prospecting-lia.md` says that is not
what this is.

### Retention

24 months from the last action on a contact, stated at
`candidhq.tech/privacy/prospecting` and enforced by `purge_expired_contacts()`, which the
monthly `retention` workflow calls with the figure from `src/config.ts`. It writes a run
row every month including when it deletes nothing, because a retention job that only
leaves a trace when it fires cannot be told apart from one that stopped running.

## Rules for talking to Ashby

- Max 1 request per second to `api.ashbyhq.com`
- User-Agent: `AshbyRadar/1.0 (+contact: luke.eaton.mail@gmail.com)`
- Each company checked at most once per day
- Exponential backoff on 429 and 5xx

## Data rules

**Company and job data, plus four fields about one person per company.**

Phase 3's position was that Radar never stores a person. That reversed on 2026-10-01
because an outreach funnel has to be tracked per contact, and the reversal carried five
conditions. All five exist, and they were built before the table was:

| Condition | Where |
| --- | --- |
| Legitimate interests assessment, Article 6(1)(f) | `docs/prospecting-lia.md` |
| Article 14 notice, linked in the first message | `candidhq.tech/privacy/prospecting` |
| Suppression list that survives re-discovery | migrations 0013 and 0015 |
| A stated retention period | 24 months, `src/config.ts` and the `retention` workflow |
| Record of processing, and how to answer a request | `docs/prospecting-ropa.md` |

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

The console has three of its own, on the Vercel project rather than in Actions:
`CONSOLE_PASSWORD`, `CONSOLE_WRITE_TOKEN` and `EXA_API_KEY`. The first two fail closed
when unset. The third fails soft: no key means the contacts panel offers the manual form
and says why.

The service-role key never leaves GitHub Actions and server-side env vars.

## Config

Every threshold and rate limit lives in `src/config.ts`. Tune there, not in the logic.

## Out of scope

Other ATSs (Greenhouse, Lever, Workable) are designed for as a future `source` value but
not built. Email addresses are out of scope: outreach is LinkedIn, by hand, using Luke's
own profile. Radar never sends email.
