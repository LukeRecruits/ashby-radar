/**
 * Ashby's public Job Postings API.
 *
 *   GET https://api.ashbyhq.com/posting-api/job-board/{BOARD_NAME}?includeCompensation=true
 *
 * One call returns every published job on the board. No pagination, no auth.
 * A 404 means the name is not (or is no longer) an Ashby board.
 *
 * What live probing showed that the docs do not say:
 *
 * 1. The API is case-insensitive on the board name and echoes your spelling back in
 *    every jobUrl. /openai and /OpenAI both return the same 833 jobs, with jobUrls
 *    under the spelling you asked for. The response carries no authoritative spelling,
 *    which is why jobs are keyed on the job id, not the URL. See migration 0004.
 * 2. An empty board is a 200 with `jobs: []`, not a 404. Deel and Mercury are both
 *    live Ashby customers with nothing published today. Empty is an ordinary state.
 * 3. Board names must be percent-encoded. Real boards include `Local Infusion`,
 *    `the job sauce` and `Viz.ai`.
 * 4. The response has exactly two top-level keys: `jobs` and `apiVersion`. There is no
 *    company name anywhere in it, so display_name cannot be filled from the board.
 * 5. `isListed` is true on every job the API returns. Unlisted jobs are simply absent,
 *    so open_role_count is the length of the array.
 * 6. With includeCompensation=true every job carries a `compensation` object, populated
 *    or empty. An empty one means the company does not publish pay on that job, and it
 *    tracks `shouldDisplayCompensationOnJobPostings` exactly (672 of 833 on OpenAI).
 */

import { config } from '../config.ts';
import { fetchWithRetry, HttpError } from '../lib/http.ts';

type CompensationComponent = {
  compensationType?: string | null;
  interval?: string | null;
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
};

type RawCompensation = {
  compensationTierSummary?: string | null;
  scrapeableCompensationSalarySummary?: string | null;
  compensationTiers?: unknown[] | null;
  summaryComponents?: CompensationComponent[] | null;
};

type RawJob = {
  id?: string;
  title?: string | null;
  department?: string | null;
  team?: string | null;
  location?: string | null;
  isRemote?: boolean | null;
  workplaceType?: string | null;
  employmentType?: string | null;
  isListed?: boolean | null;
  publishedAt?: string | null;
  jobUrl?: string | null;
  shouldDisplayCompensationOnJobPostings?: boolean | null;
  compensation?: RawCompensation | null;
};

export type BoardJob = {
  ashbyJobId: string;
  ashbyJobUrl: string;
  title: string | null;
  department: string | null;
  team: string | null;
  location: string | null;
  isRemote: boolean | null;
  workplaceType: string | null;
  employmentType: string | null;
  isListed: boolean | null;
  publishedAt: string | null;
  hasCompensation: boolean;
};

export type BoardResult =
  | { found: true; jobs: BoardJob[] }
  | { found: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the company actually publishes pay on this job. */
function publishesCompensation(job: RawJob): boolean {
  const comp = job.compensation;
  if (!comp) return false;
  const populated =
    Boolean(comp.compensationTierSummary) ||
    Boolean(comp.scrapeableCompensationSalarySummary) ||
    (comp.compensationTiers?.length ?? 0) > 0 ||
    (comp.summaryComponents?.length ?? 0) > 0;
  return populated && job.shouldDisplayCompensationOnJobPostings !== false;
}

/** Ashby sends ISO strings, but a malformed one must not poison the row. */
function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalise(raw: RawJob, boardName: string): BoardJob | null {
  const id = raw.id?.trim();
  if (!id || !UUID.test(id)) return null;
  return {
    ashbyJobId: id.toLowerCase(),
    ashbyJobUrl:
      raw.jobUrl?.trim() ||
      `https://jobs.ashbyhq.com/${encodeURIComponent(boardName)}/${id}`,
    title: raw.title?.trim() || null,
    department: raw.department?.trim() || null,
    team: raw.team?.trim() || null,
    location: raw.location?.trim() || null,
    isRemote: typeof raw.isRemote === 'boolean' ? raw.isRemote : null,
    workplaceType: raw.workplaceType?.trim() || null,
    employmentType: raw.employmentType?.trim() || null,
    isListed: typeof raw.isListed === 'boolean' ? raw.isListed : null,
    publishedAt: isoOrNull(raw.publishedAt),
    hasCompensation: publishesCompensation(raw),
  };
}

export function boardUrl(boardName: string): string {
  return `${config.ashby.postingApiBase}/${encodeURIComponent(boardName)}?includeCompensation=true`;
}

/**
 * Fetches one board. Returns `found: false` on a 404, which is the signal that the name
 * is not an Ashby board today. Anything else throws, so the caller records a failure and
 * leaves the company's status alone rather than mislabelling it.
 */
export async function fetchBoard(boardName: string): Promise<BoardResult> {
  const response = await fetchWithRetry(boardUrl(boardName), {
    timeoutMs: config.refresh.requestTimeoutMs,
    maxRetries: config.refresh.maxRetries,
    retryBaseDelayMs: config.refresh.retryBaseDelayMs,
    passThroughStatuses: [404],
  });

  if (response.status === 404) return { found: false };

  const body = (await response.json()) as { jobs?: unknown };
  if (!Array.isArray(body.jobs)) {
    throw new HttpError(response.status, `${boardName}: response had no jobs array`);
  }

  const jobs: BoardJob[] = [];
  const seen = new Set<string>();
  for (const raw of body.jobs as RawJob[]) {
    const job = normalise(raw, boardName);
    // A board has never repeated a job id in probing, but a duplicate would break the
    // upsert batch, so keep the first and drop the rest.
    if (!job || seen.has(job.ashbyJobId)) continue;
    seen.add(job.ashbyJobId);
    jobs.push(job);
  }

  return { found: true, jobs };
}

let recruiterPattern: RegExp | null = null;

/** Matches the recruiting-hire titles in config.refresh.recruiterTitlePatterns. */
export function isRecruiterRole(title: string | null): boolean {
  if (!title) return false;
  recruiterPattern ??= new RegExp(config.refresh.recruiterTitlePatterns.join('|'), 'i');
  return recruiterPattern.test(title);
}
