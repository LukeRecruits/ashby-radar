/**
 * The six trigger rules.
 *
 * Each rule is a Postgres function in migration 0005 that returns the companies that
 * qualify today, with evidence. Nothing here holds a threshold: every parameter comes
 * from src/config.ts, which stays the one place anything is tuned.
 *
 * Three of the six can only fire once there is history behind them, and they enforce
 * that themselves rather than being date-gated:
 *
 *   new_to_ashby     needs the initial backfill marker
 *   first_recruiter  needs at least one earlier snapshot to call a recruiter role new
 *   publishes_comp   needs at least one earlier snapshot with no published pay
 *
 * hiring_spike and sweet_spot need a snapshot from about 30 days ago and return nothing
 * until one exists. long_open is the exception: it reads publishedAt from Ashby rather
 * than our own history, so it is true from the first day.
 */

import { isRecruiterRole } from '../ashby/postingApi.ts';
import type { Source } from '../ats/types.ts';
import { config } from '../config.ts';
import { chunk, fetchAllPages } from '../lib/paginate.ts';
import { supabase } from '../lib/supabase.ts';

/** Company ids per `in (...)` filter, so the request URL stays a sane length. */
const EVIDENCE_ID_BATCH = 200;
const PAGE_SIZE = 1_000;

export const TRIGGER_TYPES = [
  'new_to_ashby',
  'hiring_spike',
  'first_recruiter',
  'sweet_spot',
  'long_open',
  'publishes_comp',
] as const;

export type TriggerType = (typeof TRIGGER_TYPES)[number];

export type Candidate = {
  companyId: string;
  evidence: Record<string, unknown>;
};

type RpcRow = { company_id: string; evidence: Record<string, unknown> | null };

/**
 * Runs one rule's Postgres function and reads every row of it.
 *
 * Paged, because PostgREST caps how many rows a single response carries and long_open
 * alone returns thousands on the first evaluation. An unpaged read would silently
 * return the first page and look like the rule simply matched fewer companies.
 */
async function candidates(
  fn: string,
  args: Record<string, unknown>,
): Promise<Candidate[]> {
  const rows = await fetchAllPages<RpcRow>(fn, PAGE_SIZE, (from, to) =>
    // The functions have no ORDER BY of their own, and offset paging over an unordered
    // result can repeat or skip rows between pages. This imposes one.
    supabase().rpc(fn, args).order('company_id', { ascending: true }).range(from, to),
  );

  // Belt and braces against a paging fault turning into two triggers for one company
  // in a single run. The dedupe in SQL only sees triggers already committed.
  const seen = new Set<string>();
  const found: Candidate[] = [];
  for (const row of rows) {
    if (seen.has(row.company_id)) continue;
    seen.add(row.company_id);
    found.push({ companyId: row.company_id, evidence: row.evidence ?? {} });
  }
  return found;
}

export type RuleContext = {
  /** The UTC date the refresh wrote today's snapshots under. */
  runDate: string;
  /** Null until the initial verification pass has finished. */
  /** Per source; a source missing here fires no new_to_ashby. See migration 0023. */
  backfillMarkers: Partial<Record<Source, string>>;
};

type Rule = {
  type: TriggerType;
  /** One line for the run log and the digest header. */
  describe: string;
  find: (ctx: RuleContext) => Promise<Candidate[]>;
};

const t = config.triggers;

export const RULES: Rule[] = [
  {
    type: 'new_to_ashby',
    describe: 'First successful check, for a company discovered after its source\'s backfill',
    find: (ctx) =>
      candidates('candidates_new_to_ats', {
        p_run_date: ctx.runDate,
        p_markers: ctx.backfillMarkers,
        p_dedupe_days: t.dedupeDays,
      }),
  },
  {
    type: 'hiring_spike',
    describe: `Open roles up ${t.hiringSpike.minIncrease}+ on ${t.hiringSpike.lookbackDays} days ago`,
    find: (ctx) =>
      candidates('candidates_hiring_spike', {
        p_run_date: ctx.runDate,
        p_lookback_days: t.hiringSpike.lookbackDays,
        p_window_days: t.hiringSpike.baselineWindowDays,
        p_min_increase: t.hiringSpike.minIncrease,
        p_max_evidence_jobs: t.hiringSpike.maxEvidenceJobs,
        p_dedupe_days: t.dedupeDays,
      }),
  },
  {
    type: 'first_recruiter',
    describe: `First recruiting hire in ${t.firstRecruiter.lookbackDays} days`,
    find: async (ctx) => {
      const found = await candidates('candidates_first_recruiter', {
        p_run_date: ctx.runDate,
        p_lookback_days: t.firstRecruiter.lookbackDays,
        p_dedupe_days: t.dedupeDays,
      });
      return attachRecruiterJobs(found);
    },
  },
  {
    type: 'sweet_spot',
    describe: `Into the ${t.sweetSpot.minRoles}-${t.sweetSpot.maxRoles} role band from outside it`,
    find: (ctx) =>
      candidates('candidates_sweet_spot', {
        p_run_date: ctx.runDate,
        p_lookback_days: t.sweetSpot.lookbackDays,
        p_window_days: t.sweetSpot.baselineWindowDays,
        p_min_roles: t.sweetSpot.minRoles,
        p_max_roles: t.sweetSpot.maxRoles,
        p_dedupe_days: t.dedupeDays,
      }),
  },
  {
    type: 'long_open',
    describe:
      `${t.longOpen.minStaleRoles}+ roles open ${t.longOpen.minAgeDays}+ days, ` +
      `on a board of ${t.longOpen.minOpenRoles}-${t.longOpen.maxOpenRoles}`,
    find: (ctx) =>
      candidates('candidates_long_open', {
        p_run_date: ctx.runDate,
        p_min_age_days: t.longOpen.minAgeDays,
        p_min_stale_roles: t.longOpen.minStaleRoles,
        p_min_open_roles: t.longOpen.minOpenRoles,
        p_max_open_roles: t.longOpen.maxOpenRoles,
        p_max_evidence_jobs: t.longOpen.maxEvidenceJobs,
        p_dedupe_days: t.dedupeDays,
      }),
  },
  {
    type: 'publishes_comp',
    describe: 'Pay published on a job for the first time',
    find: (ctx) =>
      candidates('candidates_publishes_comp', {
        p_run_date: ctx.runDate,
        p_max_evidence_jobs: t.publishesComp.maxEvidenceJobs,
        p_dedupe_days: t.dedupeDays,
      }),
  },
];

/**
 * first_recruiter is detected from snapshots.recruiter_role_count, which the refresh
 * computes with the single title pattern in src/config.ts. The evidence has to name the
 * actual job, so the titles are matched here with that same pattern rather than a second
 * copy of it in SQL.
 */
async function attachRecruiterJobs(found: Candidate[]): Promise<Candidate[]> {
  if (!found.length) return found;

  type JobRow = {
    company_id: string;
    title: string | null;
    ashby_job_url: string;
  };

  const byCompany = new Map<string, { title: string | null; url: string }[]>();

  // Chunked so the ?in=(...) filter cannot grow into a URL the server rejects, and
  // paged because one company can have thousands of open jobs.
  for (const ids of chunk(found.map((candidate) => candidate.companyId), EVIDENCE_ID_BATCH)) {
    const rows = await fetchAllPages<JobRow>('recruiter job evidence', PAGE_SIZE, (from, to) =>
      supabase()
        .from('jobs')
        .select('company_id, title, ashby_job_url')
        .in('company_id', ids)
        .is('closed_at', null)
        .order('company_id')
        .order('id')
        .range(from, to),
    );

    for (const row of rows) {
      if (!isRecruiterRole(row.title)) continue;
      const list = byCompany.get(row.company_id) ?? [];
      if (list.length >= t.firstRecruiter.maxEvidenceJobs) continue;
      list.push({ title: row.title, url: row.ashby_job_url });
      byCompany.set(row.company_id, list);
    }
  }

  return found.map((candidate) => ({
    ...candidate,
    evidence: { ...candidate.evidence, jobs: byCompany.get(candidate.companyId) ?? [] },
  }));
}
