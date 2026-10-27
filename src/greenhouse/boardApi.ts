/**
 * Greenhouse's public Job Board API.
 *
 *   GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?pay_transparency=true
 *   GET https://boards-api.greenhouse.io/v1/boards/{token}/departments
 *
 * Two calls per board rather than one. The jobs list without `content=true` carries no
 * departments, and `content=true` adds every job description, which makes the response
 * around sixteen times larger. The departments endpoint returns the same jobs again,
 * grouped, at roughly the size of the plain list, so the pair costs about an eighth of
 * the single heavy call. No pagination, no auth. A 404 means the token is not (or is no
 * longer) a Greenhouse board.
 *
 * What live probing showed that the docs do not say. Measured 2026-10-27 over 195
 * tokens from Common Crawl (155 live boards, 6,372 jobs) plus Carta, Anthropic and Adyen:
 *
 * 1. The API is case-insensitive on the token (ADYEN = adyen) and, unlike Ashby, does
 *    not echo your spelling back: absolute_url always carries Greenhouse's own lowercase
 *    token. Jobs are still keyed on the numeric id, never the URL.
 * 2. A 404 means no such board, with a JSON body ("Job board not found"). An empty board
 *    is a 200 with `jobs: []`: 3 of the 155 live boards. EU boards
 *    (job-boards.eu.greenhouse.io) are served by this same US host.
 * 3. company_name is on every job on the plain list, no content=true needed: present on
 *    all 6,372. It is the board's display name, which is sometimes a sub-board label
 *    ("WellPower - Administrative", "CTC Lateral - Website & LinkedIn") rather than the
 *    legal company. An empty board has no jobs and so no name: fetchBoardName covers it.
 * 4. Departments and offices are absent from the plain list; they arrive only with
 *    content=true, which is about sixteen times the bytes (Carta: 45KB to 707KB). The
 *    departments endpoint lists every job exactly once under its department, in Carta's
 *    case all 73 matching content=true exactly, at roughly the plain list's size. Jobs a
 *    company never assigned sit under a "No Department" entry, read here as null.
 * 5. pay_input_ranges appears only with pay_transparency=true, and then on every job,
 *    as an empty array when no pay is published. The departments endpoint ignores the
 *    flag, so pay has to come from the jobs list. 15% of sampled jobs publish a range,
 *    though it is concentrated: Anthropic 595 of 679, most small boards none.
 * 6. first_published was null on 2 of 6,372 jobs. Those get a null publishedAt rather
 *    than updated_at, which moves on any edit and would make old roles look new.
 * 7. No duplicate ids within a board, and meta.total always equalled the array length.
 *    But one requisition is often posted several times: 21% of postings share an
 *    internal_job_id with another, sometimes for different cities, sometimes under
 *    different titles. Each posting is its own job here, as Greenhouse publishes it, so
 *    an open-role count is a count of postings.
 * 8. No rate-limit headers on any response and no 429 in 350 requests at one a second.
 *    Responses take about 140ms; the median board is 9KB, the largest seen 1MB.
 * 9. Custom fields come back in `metadata` on the plain list, and many companies use one
 *    to state the workplace ("Location Type: On-Site", "Work Archetype: Hybrid",
 *    "Remote Position: Yes") or employment type. Those outrank the location text.
 * 10. Companies that embed the board on their own site get absolute_urls on their own
 *    host (www.charliehealth.com/careers/current-openings?gh_jid=...). 14 of 155 boards
 *    did. Against company_name, pickDomain accepted 13 at 90 or 100 and refused the
 *    fourteenth (cclgroup.com for "Connor, Clark & Lunn Financial Group Ltd.", right but
 *    unprovable by name), which is the refusal working as designed.
 */

import { config } from '../config.ts';
import type { BoardJob, BoardResult } from '../ats/types.ts';
import { candidatesFromDescriptions } from '../enrich/domainGuess.ts';
import { fetchWithRetry, HttpError } from '../lib/http.ts';
import { inferWorkplaceType, parseGreenhouseLocation, workplaceFromField } from './location.ts';

export type { BoardJob, BoardResult };

type MetadataField = {
  id?: number;
  name?: string | null;
  value?: unknown;
  value_type?: string | null;
};

type PayRange = {
  min_cents?: number | null;
  max_cents?: number | null;
  currency_type?: string | null;
  title?: string | null;
};

export type RawGreenhouseJob = {
  id?: number | string;
  internal_job_id?: number | null;
  absolute_url?: string | null;
  title?: string | null;
  location?: { name?: string | null } | null;
  first_published?: string | null;
  updated_at?: string | null;
  company_name?: string | null;
  requisition_id?: string | null;
  metadata?: MetadataField[] | null;
  pay_input_ranges?: PayRange[] | null;
};

export type RawDepartment = {
  id?: number;
  name?: string | null;
  parent_id?: number | null;
  child_ids?: number[] | null;
  jobs?: { id?: number | string }[] | null;
};

export type RawJobsBody = { jobs?: unknown; meta?: { total?: number } | null };
export type RawDepartmentsBody = { departments?: unknown };

const JOB_ID = /^\d{1,20}$/;

/** Greenhouse sends offset timestamps. A malformed one must not poison the row. */
function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * True when a pay range is actually populated. `pay_input_ranges` is an empty array on a
 * job that publishes no pay, and a range with neither bound tells a candidate nothing.
 */
function publishesCompensation(job: RawGreenhouseJob): boolean {
  return (job.pay_input_ranges ?? []).some(
    (range) =>
      (typeof range.min_cents === 'number' && range.min_cents > 0) ||
      (typeof range.max_cents === 'number' && range.max_cents > 0),
  );
}

/** A metadata field's text value, when the company has filled it in. */
function metadataText(job: RawGreenhouseJob, pattern: RegExp): string | null {
  for (const field of job.metadata ?? []) {
    if (!field?.name || !pattern.test(field.name)) continue;
    const value = Array.isArray(field.value) ? field.value[0] : field.value;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Many companies add a custom "Location Type", "Work Archetype" or "Remote Position"
 * field to their jobs, and Greenhouse returns custom fields in `metadata` on the cheap
 * path. Where one is filled in it is the company's own statement and outranks anything
 * read out of the location text. workplaceFromField decides which fields count.
 */
function statedWorkplace(job: RawGreenhouseJob): 'Remote' | 'Hybrid' | 'OnSite' | null {
  for (const field of job.metadata ?? []) {
    if (!field?.name) continue;
    const value = Array.isArray(field.value) ? field.value[0] : field.value;
    const stated = workplaceFromField(field.name, value);
    if (stated) return stated;
  }
  return null;
}

/** Same idea for employment type. Greenhouse has no field of its own for it. */
const EMPLOYMENT_FIELD = /^(employment|job|position|contract|time)[\s_-]*type$/i;

function employmentTypeFrom(value: string | null): string | null {
  if (!value) return null;
  const v = value.toLowerCase();
  // Ashby's vocabulary, so the column reads the same whichever ATS filled it.
  if (/intern/.test(v)) return 'Intern';
  if (/part[\s-]?time/.test(v)) return 'PartTime';
  if (/contract|freelance/.test(v)) return 'Contract';
  if (/temporary|\btemp\b|fixed[\s-]?term|seasonal/.test(v)) return 'Temporary';
  if (/full[\s-]?time|permanent|regular/.test(v)) return 'FullTime';
  return null;
}

/**
 * Department ids to their top-level name, walking parent_id. Greenhouse departments
 * nest (Carta Law > Carta Law Contracts), and jobs hang off whichever level the company
 * chose. Grouping by the top level keeps the department breakdown to a handful of real
 * functions instead of every sub-team, and the leaf goes in `team`, the same split Ashby
 * makes between department and team.
 */
function departmentIndex(body: RawDepartmentsBody | null): Map<string, { top: string; leaf: string }> {
  const byJob = new Map<string, { top: string; leaf: string }>();
  if (!body || !Array.isArray(body.departments)) return byJob;
  const departments = body.departments as RawDepartment[];
  const byId = new Map<number, RawDepartment>();
  for (const dept of departments) if (typeof dept.id === 'number') byId.set(dept.id, dept);

  const topOf = (dept: RawDepartment): RawDepartment => {
    let current = dept;
    // Bounded, because a parent cycle in someone's data must not hang the refresh.
    for (let depth = 0; depth < 10 && current.parent_id != null; depth++) {
      const parent = byId.get(current.parent_id);
      if (!parent) break;
      current = parent;
    }
    return current;
  };

  for (const dept of departments) {
    const leaf = dept.name?.trim();
    if (!leaf || !Array.isArray(dept.jobs)) continue;
    const top = topOf(dept).name?.trim() || leaf;
    for (const job of dept.jobs) {
      const id = job?.id == null ? '' : String(job.id);
      // Keep the first department a job appears under. Probing never saw a job listed
      // twice, but the first is as good an answer as any if one ever is.
      if (id && !byJob.has(id)) byJob.set(id, { top, leaf });
    }
  }
  return byJob;
}

/** "No Department" is Greenhouse's placeholder, not a department anyone chose. */
function realDepartment(name: string | null | undefined): string | null {
  if (!name) return null;
  return /^no department$/i.test(name.trim()) ? null : name.trim();
}

function normalise(
  raw: RawGreenhouseJob,
  token: string,
  departments: Map<string, { top: string; leaf: string }>,
): BoardJob | null {
  const id = raw.id == null ? '' : String(raw.id).trim();
  if (!JOB_ID.test(id)) return null;

  const location = raw.location?.name?.replace(/\s+/g, ' ').trim() || null;
  const workplaceType = statedWorkplace(raw) ?? inferWorkplaceType(location);
  const dept = departments.get(id);
  const department = realDepartment(dept?.top);
  const leaf = realDepartment(dept?.leaf);

  return {
    externalJobId: id,
    jobUrl:
      raw.absolute_url?.trim() ||
      `https://job-boards.greenhouse.io/${encodeURIComponent(token)}/jobs/${id}`,
    title: raw.title?.trim() || null,
    department,
    team: leaf && leaf !== department ? leaf : null,
    location,
    // Ashby's convention, so the column means the same across sources: true for Remote
    // and for Hybrid, false for OnSite, null when nothing is stated. remote_share reads
    // workplaceType, never this.
    isRemote: workplaceType ? workplaceType !== 'OnSite' : null,
    workplaceType,
    employmentType: employmentTypeFrom(metadataText(raw, EMPLOYMENT_FIELD)),
    // The board API returns only live postings, so every job here is listed.
    isListed: true,
    // first_published only. updated_at moves on any edit, so substituting it for a
    // missing first_published would make old roles look new and starve long_open.
    publishedAt: isoOrNull(raw.first_published),
    hasCompensation: publishesCompensation(raw),
    address: parseGreenhouseLocation(location),
  };
}

/**
 * Turns the two raw bodies into the shared board shape. Exported so it can be exercised
 * against saved responses without touching the network. `departmentsBody` may be null:
 * jobs then carry no department rather than the board failing.
 */
export function parseBoard(
  token: string,
  jobsBody: RawJobsBody,
  departmentsBody: RawDepartmentsBody | null,
): Extract<BoardResult, { found: true }> {
  if (!Array.isArray(jobsBody.jobs)) {
    throw new HttpError(200, `${token}: response had no jobs array`);
  }
  const departments = departmentIndex(departmentsBody);

  const jobs: BoardJob[] = [];
  const urls: string[] = [];
  const names = new Map<string, number>();
  const seen = new Set<string>();
  for (const raw of jobsBody.jobs as RawGreenhouseJob[]) {
    const job = normalise(raw, token, departments);
    // Ids are unique per board in every response probed, but a duplicate would break
    // the upsert batch, so keep the first and drop the rest.
    if (!job || seen.has(job.externalJobId)) continue;
    seen.add(job.externalJobId);
    jobs.push(job);
    if (raw.absolute_url) urls.push(raw.absolute_url);
    const name = raw.company_name?.trim();
    if (name) names.set(name, (names.get(name) ?? 0) + 1);
  }

  // The most common company_name wins. Every job on a board carried the same one in
  // probing, but a board shared by two brands should still get a single answer.
  let companyName: string | null = null;
  let best = 0;
  for (const [name, count] of names) {
    if (count > best) {
      companyName = name;
      best = count;
    }
  }

  return {
    found: true,
    jobs,
    // A company that embeds its board on its own site gets absolute_urls on its own
    // host (https://www.example.com/careers?gh_jid=123). Greenhouse's own hosts are
    // already on the not-a-company list, so only those embedding hosts survive, folded
    // to the registrable domain and counted per job, exactly as Ashby's advert links are.
    domainCandidates: candidatesFromDescriptions(urls),
    companyName,
  };
}

function encodeToken(token: string): string {
  return encodeURIComponent(token.trim());
}

export function boardUrl(token: string): string {
  return `${config.greenhouse.boardApiBase}/${encodeToken(token)}/jobs?pay_transparency=true`;
}

export function departmentsUrl(token: string): string {
  return `${config.greenhouse.boardApiBase}/${encodeToken(token)}/departments`;
}

export function boardInfoUrl(token: string): string {
  return `${config.greenhouse.boardApiBase}/${encodeToken(token)}`;
}

type FetchOptions = {
  /**
   * Awaited before every request this client makes. The refresh passes its shared
   * Greenhouse limiter here instead of awaiting a slot itself, because one board is two
   * requests and both have to be paced.
   */
  pace?: () => Promise<void>;
};

async function get(url: string, pace?: () => Promise<void>): Promise<Response> {
  if (pace) await pace();
  return fetchWithRetry(url, {
    timeoutMs: config.refresh.requestTimeoutMs,
    maxRetries: config.refresh.maxRetries,
    retryBaseDelayMs: config.refresh.retryBaseDelayMs,
    passThroughStatuses: [404],
  });
}

/**
 * Fetches one board. Returns `found: false` on a 404, which is the signal that the token
 * is not a Greenhouse board today. Anything else throws, so the caller records a failure
 * and leaves the company's status alone rather than mislabelling it.
 *
 * A failure on the departments call does not fail the board. The jobs are the thing the
 * snapshot and every trigger need; a missing department costs one breakdown chart a day.
 */
export async function fetchBoard(token: string, options: FetchOptions = {}): Promise<BoardResult> {
  const response = await get(boardUrl(token), options.pace);
  if (response.status === 404) return { found: false };
  const jobsBody = (await response.json()) as RawJobsBody;

  let departmentsBody: RawDepartmentsBody | null = null;
  if (config.greenhouse.fetchDepartments && Array.isArray(jobsBody.jobs) && jobsBody.jobs.length) {
    try {
      const deps = await get(departmentsUrl(token), options.pace);
      if (deps.ok) departmentsBody = (await deps.json()) as RawDepartmentsBody;
    } catch {
      departmentsBody = null;
    }
  }

  return parseBoard(token, jobsBody, departmentsBody);
}

/**
 * The board's own name, from `/v1/boards/{token}`. Needed only where the jobs list
 * cannot supply one: company_name rides on every job, so an empty board is the one case
 * with no name in it. Returns null on a 404, and throws on anything else.
 *
 * The response also carries the board's intro HTML, which companies fill with links to
 * their own site, so its hostnames are returned as domain candidates too.
 */
export async function fetchBoardName(
  token: string,
  options: FetchOptions = {},
): Promise<{ name: string | null; domainCandidates: ReturnType<typeof candidatesFromDescriptions> } | null> {
  const response = await get(boardInfoUrl(token), options.pace);
  if (response.status === 404) return null;
  const body = (await response.json()) as { name?: string | null; content?: string | null };
  return {
    name: body.name?.trim() || null,
    domainCandidates: candidatesFromDescriptions(body.content ? [body.content] : []),
  };
}
