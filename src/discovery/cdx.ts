import { config } from '../config.ts';
import { fetchWithRetry } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { sleep } from '../lib/sleep.ts';
import { extractBoardName } from './boardName.ts';

/** board name -> first URL we saw it in, plus how many times it appeared. */
export type BoardHits = Map<string, { sourceUrl: string; hitCount: number }>;

function record(hits: BoardHits, rawUrl: string): void {
  const name = extractBoardName(rawUrl);
  if (!name) return;
  const existing = hits.get(name);
  if (existing) existing.hitCount += 1;
  else hits.set(name, { sourceUrl: rawUrl, hitCount: 1 });
}

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
const CC_QUERY =
  'url=jobs.ashbyhq.com%2F*&output=json&fl=url&filter=!status:404&pageSize=1';

async function crawlIndexPageCount(cdxApi: string): Promise<number> {
  const response = await fetchWithRetry(`${cdxApi}?${CC_QUERY}&showNumPages=true`, {
    passThroughStatuses: [404],
  });
  if (response.status === 404) return 0; // Index holds no matches for this prefix.
  const body = (await response.json()) as { pages?: number };
  return typeof body.pages === 'number' ? body.pages : 0;
}

export async function commonCrawlBoardNames(hits: BoardHits): Promise<{
  indexesQueried: number;
  pagesQueried: number;
  failures: string[];
}> {
  const indexes = await recentCommonCrawlIndexes(config.discovery.commonCrawlIndexCount);
  const failures: string[] = [];
  let pagesQueried = 0;

  for (const index of indexes) {
    const cdxApi = index['cdx-api'];
    let pages = 0;
    try {
      await sleep(config.discovery.cdxRequestDelayMs);
      pages = await crawlIndexPageCount(cdxApi);
    } catch (error) {
      failures.push(`${index.id}: page count failed (${errText(error)})`);
      continue;
    }

    const limit = Math.min(pages, config.discovery.maxPagesPerCommonCrawlIndex);
    if (pages > limit) {
      failures.push(`${index.id}: truncated at ${limit} of ${pages} pages`);
    }
    log.info('common crawl index', { id: index.id, pages, querying: limit });

    for (let page = 0; page < limit; page++) {
      await sleep(config.discovery.cdxRequestDelayMs);
      try {
        const response = await fetchWithRetry(`${cdxApi}?${CC_QUERY}&page=${page}`, {
          passThroughStatuses: [404],
          extraRetryStatuses: [400],
          timeoutMs: config.discovery.commonCrawlPageTimeoutMs,
        });
        pagesQueried += 1;
        if (response.status === 404) continue;
        const text = await response.text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line) as { url?: string };
            if (row.url) record(hits, row.url);
          } catch {
            // A truncated line at the tail of a page. Skip it.
          }
        }
      } catch (error) {
        failures.push(`${index.id} page ${page}: ${errText(error)}`);
      }
    }

    log.info('common crawl index done', { id: index.id, boardsSoFar: hits.size });
  }

  return { indexesQueried: indexes.length, pagesQueried, failures };
}

// Internet Archive (Wayback) --------------------------------------------------

const WAYBACK_BASE = 'https://web.archive.org/cdx/search/cdx';

export async function waybackBoardNames(hits: BoardHits): Promise<{
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
      url: 'jobs.ashbyhq.com',
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
      if (url && url !== 'original') record(hits, url);
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

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
