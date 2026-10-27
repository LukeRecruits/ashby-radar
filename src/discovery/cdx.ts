import { config } from '../config.ts';
import { fetchWithRetry } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { sleep } from '../lib/sleep.ts';

/** board name -> first URL we saw it in, plus how many times it appeared. */
export type BoardHits = Map<string, { sourceUrl: string; hitCount: number }>;

/** Turns one crawled URL into a board name, or null when it does not name a board. */
export type Extractor = (rawUrl: string) => string | null;

/**
 * Optional bounds on a sweep. Ashby passes none of these and behaves exactly as it
 * always has. Greenhouse's sweep is several times larger, so it needs a clock to stop
 * against and a way to give up gracefully when an index server starts refusing us.
 */
export type SweepLimits = {
  /** Gap between requests. Defaults to config.discovery.cdxRequestDelayMs. */
  delayMs?: number;
  /** Epoch ms. No new request is started after this. */
  deadline?: number;
  /** Stop the sweep after this many failed requests in a row. */
  maxConsecutiveFailures?: number;
  /** Cap on pages per query. Dry runs use it to sample rather than sweep. */
  maxPages?: number;
  /** First page of each Common Crawl query. Dry runs use it to sample mid-index. */
  firstPage?: number;
  /** How many Common Crawl indexes to read. */
  indexCount?: number;
};

function record(hits: BoardHits, rawUrl: string, extract: Extractor): void {
  const name = extract(rawUrl);
  if (!name) return;
  const existing = hits.get(name);
  if (existing) existing.hitCount += 1;
  else hits.set(name, { sourceUrl: rawUrl, hitCount: 1 });
}

const pastDeadline = (limits: SweepLimits) =>
  limits.deadline !== undefined && Date.now() > limits.deadline;

// Common Crawl ---------------------------------------------------------------

type CollInfo = { id: string; 'cdx-api': string };

/** The N most recent monthly crawl indexes, newest first. */
async function recentCommonCrawlIndexes(count: number): Promise<CollInfo[]> {
  const response = await fetchWithRetry('https://index.commoncrawl.org/collinfo.json');
  const all = (await response.json()) as CollInfo[];
  // collinfo.json is already ordered newest first.
  return all.slice(0, count);
}

// pageSize=1 is deliberate. Common Crawl's index server returns 502/504 on the default
// 5-block page for a prefix this wide; one block per request completes reliably.
// encodeURIComponent leaves the * alone, so jobs.ashbyhq.com gives exactly the query
// string Ashby discovery has always sent.
const ccQuery = (host: string) =>
  `url=${encodeURIComponent(`${host}/*`)}&output=json&fl=url&filter=!status:404&pageSize=1`;

async function crawlIndexPageCount(cdxApi: string, host: string): Promise<number> {
  const response = await fetchWithRetry(`${cdxApi}?${ccQuery(host)}&showNumPages=true`, {
    passThroughStatuses: [404],
  });
  if (response.status === 404) return 0; // Index holds no matches for this prefix.
  const body = (await response.json()) as { pages?: number };
  return typeof body.pages === 'number' ? body.pages : 0;
}

/**
 * Sweeps the recent Common Crawl indexes for every host, one prefix query per host per
 * index. Ashby has one host; Greenhouse has four, and its job-boards.greenhouse.io prefix
 * alone is about ten times Ashby's whole page count.
 */
export async function commonCrawlBoardNames(
  hits: BoardHits,
  hosts: readonly string[],
  extract: Extractor,
  limits: SweepLimits = {},
): Promise<{
  indexesQueried: number;
  pagesQueried: number;
  failures: string[];
  stoppedEarly: string | null;
}> {
  const delayMs = limits.delayMs ?? config.discovery.cdxRequestDelayMs;
  const indexes = await recentCommonCrawlIndexes(
    limits.indexCount ?? config.discovery.commonCrawlIndexCount,
  );
  const failures: string[] = [];
  let pagesQueried = 0;
  let consecutiveFailures = 0;
  let stoppedEarly: string | null = null;

  const failed = (message: string) => {
    failures.push(message);
    consecutiveFailures += 1;
    if (
      limits.maxConsecutiveFailures !== undefined &&
      consecutiveFailures >= limits.maxConsecutiveFailures
    ) {
      stoppedEarly = `${consecutiveFailures} failures in a row, last: ${message}`;
    }
  };

  sweep: for (const index of indexes) {
    const cdxApi = index['cdx-api'];
    for (const host of hosts) {
      if (pastDeadline(limits)) {
        stoppedEarly = `time budget spent before ${index.id} ${host}`;
        break sweep;
      }

      let pages = 0;
      try {
        await sleep(delayMs);
        pages = await crawlIndexPageCount(cdxApi, host);
        consecutiveFailures = 0;
      } catch (error) {
        failed(`${index.id} ${host}: page count failed (${errText(error)})`);
        if (stoppedEarly) break sweep;
        continue;
      }

      const first = Math.min(limits.firstPage ?? 0, pages);
      const cap = Math.min(
        config.discovery.maxPagesPerCommonCrawlIndex,
        limits.maxPages ?? Number.POSITIVE_INFINITY,
      );
      const end = Math.min(pages, first + cap);
      if (pages > end && limits.maxPages === undefined) {
        failures.push(`${index.id} ${host}: truncated at ${end} of ${pages} pages`);
      }
      log.info('common crawl index', { id: index.id, host, pages, querying: end - first });

      for (let page = first; page < end; page++) {
        if (pastDeadline(limits)) {
          stoppedEarly = `time budget spent at ${index.id} ${host} page ${page} of ${pages}`;
          break sweep;
        }
        await sleep(delayMs);
        try {
          const response = await fetchWithRetry(`${cdxApi}?${ccQuery(host)}&page=${page}`, {
            passThroughStatuses: [404],
            extraRetryStatuses: [400],
            timeoutMs: config.discovery.commonCrawlPageTimeoutMs,
          });
          pagesQueried += 1;
          if (response.status === 404) continue;
          const text = await response.text();
          // A page inside the reported page count is never empty. An empty 200 is how
          // the index server says it is throttling us, so it counts as a failure.
          if (!text.trim()) {
            failed(`${index.id} ${host} page ${page}: empty body`);
            if (stoppedEarly) break sweep;
            continue;
          }
          consecutiveFailures = 0;
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
              const row = JSON.parse(line) as { url?: string };
              if (row.url) record(hits, row.url, extract);
            } catch {
              // A truncated line at the tail of a page. Skip it.
            }
          }
        } catch (error) {
          failed(`${index.id} ${host} page ${page}: ${errText(error)}`);
          if (stoppedEarly) break sweep;
        }
      }

      log.info('common crawl index done', { id: index.id, host, boardsSoFar: hits.size });
    }
  }

  if (stoppedEarly) failures.push(`common crawl stopped early: ${stoppedEarly}`);
  return { indexesQueried: indexes.length, pagesQueried, failures, stoppedEarly };
}

// Internet Archive (Wayback) --------------------------------------------------

const WAYBACK_BASE = 'https://web.archive.org/cdx/search/cdx';

/**
 * The Ashby sweep: one query over the whole host, walked with resume keys. Fine for a
 * host this size; see waybackPagedBoardNames for why Greenhouse cannot do the same.
 */
export async function waybackBoardNames(
  hits: BoardHits,
  host: string,
  extract: Extractor,
): Promise<{
  pagesQueried: number;
  failures: string[];
}> {
  const failures: string[] = [];
  let pagesQueried = 0;
  let resumeKey: string | null = null;
  // Declared outside the loop so the check after it distinguishes "walked every page"
  // from "ran out of page budget with more to fetch".
  let nextResumeKey: string | null = null;

  for (let page = 0; page < config.discovery.maxWaybackPages; page++) {
    const params = new URLSearchParams({
      url: host,
      matchType: 'domain',
      fl: 'original',
      collapse: 'urlkey',
      output: 'json',
      filter: '!statuscode:404',
      limit: String(config.discovery.waybackPageSize),
      showResumeKey: 'true',
    });
    if (resumeKey) params.set('resumeKey', resumeKey);

    await sleep(config.discovery.cdxRequestDelayMs);

    let rows: string[][];
    try {
      const response = await fetchWithRetry(`${WAYBACK_BASE}?${params}`);
      const text = await response.text();
      if (!text.trim()) break;
      rows = JSON.parse(text) as string[][];
      pagesQueried += 1;
    } catch (error) {
      failures.push(`wayback page ${page}: ${errText(error)}`);
      nextResumeKey = null;
      break;
    }

    if (rows.length <= 1) {
      nextResumeKey = null;
      break; // Header row only.
    }

    // With showResumeKey the response ends with a blank row then [resumeKey].
    nextResumeKey = null;
    const last = rows.at(-1);
    const secondLast = rows.at(-2);
    if (last?.length === 1 && secondLast?.length === 0) {
      nextResumeKey = last[0] ?? null;
      rows = rows.slice(0, -2);
    }

    // Row 0 is the header ("original") when we did not resume.
    for (const row of rows.slice(resumeKey ? 0 : 1)) {
      const url = row[0];
      if (url && url !== 'original') record(hits, url, extract);
    }

    log.info('wayback page', { page, boardsSoFar: hits.size });

    if (!nextResumeKey) break;
    resumeKey = nextResumeKey;
  }

  if (nextResumeKey) {
    failures.push(`wayback: stopped at the ${config.discovery.maxWaybackPages}-page cap`);
  }

  return { pagesQueried, failures };
}

/** Where a paged Wayback sweep stopped, so the next run can carry on from there. */
export type WaybackCursor = { host: string; page: number };

/**
 * The Greenhouse sweep, in the CDX server's page mode.
 *
 * Greenhouse's hosts hold every job URL ever archived: on 2026-10-27 Wayback reported
 * 298 pages for boards.greenhouse.io, 198 for job-boards.greenhouse.io, 14 for
 * job-boards.eu and 8 for boards.eu, against 53 for jobs.ashbyhq.com. The resume-key walk Ashby uses asks the
 * server to scan and collapse from an arbitrary key, and over a prefix this wide it
 * 504s at the gateway after 60 seconds. Page mode instead reads one fixed range of index
 * blocks per request, which answered in 10 to 45 seconds, and the page count is known
 * up front. That makes the walk resumable with nothing more than (host, page).
 *
 * collapse=urlkey still applies inside a page, so a job URL captured a hundred times
 * arrives once. A board's URLs are contiguous in the index (it is sorted by SURT key),
 * so most pages hold a few dozen boards and thousands of their job URLs.
 */
export async function waybackPagedBoardNames(
  hits: BoardHits,
  hosts: readonly string[],
  extract: Extractor,
  start: WaybackCursor | null,
  limits: SweepLimits = {},
): Promise<{
  pagesQueried: number;
  pageCounts: Record<string, number>;
  failures: string[];
  /** Null when every host was walked to the end. */
  nextCursor: WaybackCursor | null;
}> {
  const delayMs = limits.delayMs ?? config.discovery.greenhouseWaybackDelayMs;
  const failures: string[] = [];
  const pageCounts: Record<string, number> = {};
  let pagesQueried = 0;
  let consecutiveFailures = 0;
  // The first page of a run of failures. If we give up, the next run starts here rather
  // than skipping the pages that were refused.
  let firstFailed: WaybackCursor | null = null;

  const startHost = start ? Math.max(0, hosts.indexOf(start.host)) : 0;

  for (let h = startHost; h < hosts.length; h++) {
    const host = hosts[h]!;
    const prefix = { url: `${host}/`, matchType: 'prefix' };
    const pageQuery = (page: number) =>
      `${WAYBACK_BASE}?${new URLSearchParams({
        ...prefix,
        fl: 'original',
        collapse: 'urlkey',
        filter: '!statuscode:404',
        page: String(page),
      })}`;
    const first = start && h === startHost && start.host === host ? start.page : 0;

    let pages: number;
    try {
      await sleep(delayMs);
      // The count must be asked without fl or collapse: with them the server answers
      // "-" instead of a number. The page boundaries are the same either way, because
      // pages are ranges of index blocks and the other parameters only shape the rows.
      const countUrl = `${WAYBACK_BASE}?${new URLSearchParams({ ...prefix, showNumPages: 'true' })}`;
      const text = (await (await fetchWithRetry(countUrl)).text()).trim();
      if (!/^\d+$/.test(text)) throw new Error(`page count was not a number: ${text.slice(0, 80)}`);
      pages = Number(text);
    } catch (error) {
      failures.push(`wayback ${host}: page count failed (${errText(error)})`);
      return { pagesQueried, pageCounts, failures, nextCursor: { host, page: first } };
    }
    pageCounts[host] = pages;

    const end = Math.min(pages, first + (limits.maxPages ?? Number.POSITIVE_INFINITY));
    log.info('wayback host', { host, pages, from: first, to: end });

    for (let page = first; page < end; page++) {
      if (pastDeadline(limits)) {
        failures.push(`wayback: time budget spent at ${host} page ${page} of ${pages}`);
        return { pagesQueried, pageCounts, failures, nextCursor: firstFailed ?? { host, page } };
      }
      await sleep(delayMs);
      try {
        const text = await (await fetchWithRetry(pageQuery(page))).text();
        // When the Archive is overloaded it answers 200 with an HTML "Temporarily
        // Offline" page rather than an error status. That is a refusal, not an empty page.
        if (text.trimStart().startsWith('<')) throw new Error('html instead of cdx rows');
        pagesQueried += 1;
        consecutiveFailures = 0;
        firstFailed = null;
        for (const line of text.split('\n')) {
          const url = line.trim();
          if (url) record(hits, url, extract);
        }
      } catch (error) {
        failures.push(`wayback ${host} page ${page}: ${errText(error)}`);
        consecutiveFailures += 1;
        firstFailed ??= { host, page };
        if (consecutiveFailures >= (limits.maxConsecutiveFailures ?? Infinity)) {
          failures.push(`wayback: stopped after ${consecutiveFailures} failures in a row`);
          return { pagesQueried, pageCounts, failures, nextCursor: firstFailed };
        }
      }
      if (page % 10 === 0) log.info('wayback page', { host, page, boardsSoFar: hits.size });
    }

    // A dry run that sampled part of a host has not finished it.
    if (end < pages) {
      return { pagesQueried, pageCounts, failures, nextCursor: { host, page: end } };
    }
  }

  return { pagesQueried, pageCounts, failures, nextCursor: null };
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
