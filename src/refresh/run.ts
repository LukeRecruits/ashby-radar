/**
 * Daily refresh: verify every known board against the posting API, record its jobs, and
 * write one snapshot per company per day.
 *
 * A discovered board name is not proof that a company is on Ashby today. This is what
 * turns 5,731 unverified names into a list with a final status on each, and it is the
 * only thing that builds the day-by-day history every trigger in phase 3 reads.
 *
 * Idempotent by design. A company whose last_checked_at already falls inside today's
 * run date is skipped, so a rerun after a failure resumes rather than starting over, and
 * snapshots can never double up.
 */

import { isRecruiterRole } from '../ashby/postingApi.ts';
import { clientFor, sourceFromEnv, workflowName } from '../ats/clients.ts';
import type { BoardJob, BoardResult, Source } from '../ats/types.ts';
import { config } from '../config.ts';
import { pickDomain } from '../enrich/domainGuess.ts';
import { companyLocation } from '../enrich/location.ts';
import { log } from '../lib/log.ts';
import { chunk, fetchAllPages } from '../lib/paginate.ts';
import { createRateLimiter } from '../lib/rateLimiter.ts';
import { finishRun, startRun } from '../lib/runs.ts';
import { supabase } from '../lib/supabase.ts';

/**
 * One source per run. Each ATS has its own workflow, schedule and rate limiter, so a slow
 * Greenhouse night can never delay the Ashby refresh or share its request budget.
 */
const SOURCE: Source = sourceFromEnv();
const WORKFLOW = workflowName('refresh', SOURCE);
const client = clientFor(SOURCE);

type Company = {
  id: string;
  board_name: string;
  status: string;
  display_name: string | null;
  domain: string | null;
};

type Outcome =
  | 'active'
  | 'active_empty'
  | 'newly_not_found'
  | 'newly_inactive'
  | 'still_missing'
  | 'failed';

/** Midnight UTC of the run's date. The whole run uses one date, even across midnight. */
function startOfRunDate(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Everything due a check today:
 *  - unverified, active and inactive companies not yet checked today
 *  - not_found companies last checked more than notFoundRecheckDays ago, in case the
 *    company has come back to Ashby
 */
async function companiesDue(runStart: Date): Promise<Company[]> {
  const db = supabase();
  const notCheckedToday = `last_checked_at.is.null,last_checked_at.lt.${runStart.toISOString()}`;
  const recheckCutoff = new Date(
    runStart.getTime() - config.refresh.notFoundRecheckDays * 86_400_000,
  ).toISOString();

  const size = config.refresh.companyPageSize;

  const live = await fetchAllPages<Company>('companies', size, (from, to) =>
    db
      .from('companies')
      .select('id, board_name, status, display_name, domain')
      .eq('source', SOURCE)
      .in('status', ['unverified', 'active', 'inactive'])
      .or(notCheckedToday)
      .order('id')
      .range(from, to),
  );

  const missing = await fetchAllPages<Company>('companies', size, (from, to) =>
    db
      .from('companies')
      .select('id, board_name, status, display_name, domain')
      .eq('source', SOURCE)
      .eq('status', 'not_found')
      .or(`last_checked_at.is.null,last_checked_at.lt.${recheckCutoff}`)
      .order('id')
      .range(from, to),
  );

  return [...live, ...missing];
}

/**
 * Ashby treats board names case-insensitively, so two spellings of one board would mean
 * two API calls and two sets of snapshots for the same company. Discovery collapses them
 * before they are stored, but a name arriving from another source could reintroduce one,
 * so the run guards against it too.
 */
function dropCaseDuplicates(companies: Company[]): { unique: Company[]; skipped: string[] } {
  const seen = new Map<string, string>();
  const unique: Company[] = [];
  const skipped: string[] = [];
  for (const company of companies) {
    const key = company.board_name.toLowerCase();
    const winner = seen.get(key);
    if (winner) {
      skipped.push(`${company.board_name} (same board as ${winner})`);
      continue;
    }
    seen.set(key, company.board_name);
    unique.push(company);
  }
  return { unique, skipped };
}

/** Upserts the board's jobs, closes anything that has gone, and returns the deltas. */
async function writeJobs(
  companyId: string,
  jobs: BoardJob[],
  now: string,
): Promise<{ opened: number; closed: number }> {
  const db = supabase();

  const { data: existing, error: existingError } = await db
    .from('jobs')
    .select('id, external_job_id')
    .eq('company_id', companyId)
    .is('closed_at', null);
  if (existingError) throw new Error(`open jobs query failed: ${existingError.message}`);

  const openNow = new Map<string, string>(
    (existing ?? []).map((row) => [row.external_job_id as string, row.id as string]),
  );

  for (const batch of chunk(jobs, config.refresh.jobUpsertBatchSize)) {
    const { error } = await db.from('jobs').upsert(
      batch.map((job) => ({
        company_id: companyId,
        source: SOURCE,
        external_job_id: job.externalJobId,
        // Kept filled for Ashby, the one source whose ids are uuids. See migration 0023.
        ashby_job_id: SOURCE === 'ashby' ? job.externalJobId : null,
        ashby_job_url: job.jobUrl,
        title: job.title,
        department: job.department,
        team: job.team,
        location: job.location,
        is_remote: job.isRemote,
        workplace_type: job.workplaceType,
        employment_type: job.employmentType,
        is_listed: job.isListed,
        published_at: job.publishedAt,
        has_compensation: job.hasCompensation,
        address_country: job.address.country,
        address_region: job.address.region,
        address_locality: job.address.locality,
        last_seen_at: now,
        // A job that returns to the board reopens. first_seen_at is left out of the
        // payload on purpose so the original sighting survives the update.
        closed_at: null,
      })),
      { onConflict: 'source,external_job_id' },
    );
    if (error) throw new Error(`jobs upsert failed: ${error.message}`);
  }

  const returned = new Set(jobs.map((job) => job.externalJobId));
  const goneIds = [...openNow].filter(([jobId]) => !returned.has(jobId)).map(([, id]) => id);

  for (const batch of chunk(goneIds, config.refresh.jobUpsertBatchSize)) {
    const { error } = await db.from('jobs').update({ closed_at: now }).in('id', batch);
    if (error) throw new Error(`job close failed: ${error.message}`);
  }

  const opened = jobs.filter((job) => !openNow.has(job.externalJobId)).length;
  return { opened, closed: goneIds.length };
}

async function writeSnapshot(
  companyId: string,
  snapshotDate: string,
  jobs: BoardJob[],
): Promise<void> {
  const { error } = await supabase()
    .from('snapshots')
    .upsert(
      {
        company_id: companyId,
        snapshot_date: snapshotDate,
        open_role_count: jobs.length,
        recruiter_role_count: jobs.filter((job) => isRecruiterRole(job.title)).length,
        comp_published_count: jobs.filter((job) => job.hasCompensation).length,
      },
      { onConflict: 'company_id,snapshot_date' },
    );
  if (error) throw new Error(`snapshot upsert failed: ${error.message}`);
}

async function updateCompany(
  companyId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase().from('companies').update(patch).eq('id', companyId);
  if (error) throw new Error(`company update failed: ${error.message}`);
}

/**
 * Everything we can learn about the company itself from the board we just read:
 * where it hires, and its own domain if its adverts link to it.
 *
 * Domain is only ever written, never overwritten. A domain proved by the verifier or
 * corrected by hand outranks anything inferred from advert links, and this pass has no
 * way to tell which it is looking at.
 */
function leadFields(
  company: Company,
  board: Extract<BoardResult, { found: true }>,
  now: string,
): Record<string, unknown> {
  const { jobs, domainCandidates: candidates } = board;
  const where = companyLocation(jobs);
  const patch: Record<string, unknown> = {
    top_country: where.country,
    top_locality: where.locality,
    remote_share: where.remoteShare,
    domain_candidates: candidates,
  };

  // A name the ATS supplies fills an empty display_name and never overwrites one, for
  // the same reason as the domain below: a name corrected by hand outranks the feed.
  const displayName = company.display_name ?? board.companyName;
  if (!company.display_name && board.companyName) {
    patch.display_name = board.companyName;
    patch.name_source = `${SOURCE}_api`;
    patch.name_checked_at = now;
  }

  if (!company.domain) {
    const picked = pickDomain(candidates, displayName, config.enrich.minDomainScore);
    if (picked) {
      patch.domain = picked.domain;
      patch.domain_confidence = picked.confidence;
      patch.domain_source = 'job_description';
      patch.domain_checked_at = now;
    }
  }

  return patch;
}

async function checkCompany(
  company: Company,
  snapshotDate: string,
  now: string,
): Promise<{ outcome: Outcome; opened: number; closed: number }> {
  const board = await client.fetchBoard(company.board_name);

  if (!board.found) {
    // A 404 is not proof the name was junk. Ordinary company names 404 because they are
    // former Ashby customers. A name that was never verified is not_found; one we have
    // seen live before is a customer who has left, which is inactive.
    const wasActive = company.status === 'active';
    await updateCompany(company.id, {
      status: wasActive ? 'inactive' : 'not_found',
      last_checked_at: now,
    });
    return {
      outcome: wasActive
        ? 'newly_inactive'
        : company.status === 'not_found'
          ? 'still_missing'
          : 'newly_not_found',
      opened: 0,
      closed: 0,
    };
  }

  const { opened, closed } = await writeJobs(company.id, board.jobs, now);
  await writeSnapshot(company.id, snapshotDate, board.jobs);
  await updateCompany(company.id, {
    status: 'active',
    last_checked_at: now,
    last_active_at: now,
    ...leadFields(company, board, now),
  });

  return {
    outcome: board.jobs.length > 0 ? 'active' : 'active_empty',
    opened,
    closed,
  };
}

async function main(): Promise<void> {
  const runId = await startRun(WORKFLOW);
  const runStart = startOfRunDate(new Date());
  const snapshotDate = isoDate(runStart);
  const failures: string[] = [];
  const tally: Record<Outcome, number> = {
    active: 0,
    active_empty: 0,
    newly_not_found: 0,
    newly_inactive: 0,
    still_missing: 0,
    failed: 0,
  };
  let jobsOpened = 0;
  let jobsClosed = 0;

  try {
    const due = await companiesDue(runStart);
    const { unique: deduped, skipped } = dropCaseDuplicates(due);
    // A smoke-test valve. The workflow's optional "limit" input sets this so a change
    // can be proved on real data in a couple of minutes instead of two hours. Unset or
    // 0 means check everything.
    const limit = Number(process.env.RADAR_REFRESH_LIMIT ?? 0);
    const unique = limit > 0 ? deduped.slice(0, limit) : deduped;
    if (limit > 0) log.warn('limited run', { limit, of: deduped.length });
    if (skipped.length) {
      log.warn('skipped case duplicates of a board already in this run', {
        count: skipped.length,
      });
    }
    log.info('companies due', {
      source: SOURCE,
      due: due.length,
      checking: unique.length,
      snapshotDate,
    });

    // One shared limiter across every worker, so Ashby still sees one request per
    // second no matter how many companies are in flight.
    const atsSlot = createRateLimiter(client.requestDelayMs);
    let cursor = 0;
    let done = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        const company = unique[index];
        if (!company) return;

        await atsSlot();
        try {
          const result = await checkCompany(company, snapshotDate, new Date().toISOString());
          tally[result.outcome] += 1;
          jobsOpened += result.opened;
          jobsClosed += result.closed;
        } catch (error) {
          tally.failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          // Status is deliberately left alone. A failed check must not be mistaken for a
          // 404, and last_checked_at stays old so the next run picks the company back up.
          if (failures.length < config.refresh.maxLoggedFailures) {
            failures.push(`${company.board_name}: ${message}`);
          }
          log.warn('company check failed', { board: company.board_name, error: message });
        }

        done += 1;
        if (done % 200 === 0) {
          log.info('progress', { done, of: unique.length, ...tally });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(config.refresh.concurrency, unique.length) }, worker),
    );

    const checked = unique.length;
    const succeeded = checked - tally.failed;
    const notes = JSON.stringify(
      {
        source: SOURCE,
        snapshotDate,
        due: due.length,
        limit: limit > 0 ? limit : null,
        checked,
        caseDuplicatesSkipped: skipped.length,
        caseDuplicateSample: skipped.slice(0, 50),
        outcomes: tally,
        jobsOpened,
        jobsClosed,
        successRate: checked ? Number((succeeded / checked).toFixed(4)) : null,
        failures,
      },
      null,
      2,
    );

    await finishRun(runId, { checked, succeeded, failed: tally.failed, notes });
    log.info('refresh complete', { checked, succeeded, ...tally });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, {
      checked: 0,
      succeeded: 0,
      failed: 1,
      notes: JSON.stringify({ fatal: message, outcomes: tally, failures }, null, 2),
    });
    throw error;
  }
}

main().catch((error) => {
  log.error('refresh failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
