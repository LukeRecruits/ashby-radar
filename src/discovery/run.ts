import { writeFileSync } from 'node:fs';
import { isSource, type Source } from '../ats/types.ts';
import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { chunk } from '../lib/paginate.ts';
import { finishRun, startRun } from '../lib/runs.ts';
import { supabase } from '../lib/supabase.ts';
import { collapseCaseVariants, extractBoardName } from './boardName.ts';
import {
  commonCrawlBoardNames,
  waybackBoardNames,
  waybackPagedBoardNames,
  type BoardHits,
  type SweepLimits,
  type WaybackCursor,
} from './cdx.ts';
import { extractGreenhouseBoardToken } from './greenhouseToken.ts';

/**
 * RADAR_SOURCE picks the ATS. Ashby is the default, so the existing workflow, which sets
 * nothing, keeps doing exactly what it did.
 */
const sourceEnv = process.env.RADAR_SOURCE ?? 'ashby';
if (!isSource(sourceEnv)) {
  throw new Error(`RADAR_SOURCE must be one of ashby, greenhouse; got "${sourceEnv}"`);
}
const SOURCE: Source = sourceEnv;

/**
 * Run rows are keyed on the workflow name and the health page reads Ashby's as
 * "discovery", so that name stays. Greenhouse gets its own, which is also where its
 * Wayback resume cursor is read back from.
 */
const WORKFLOW = SOURCE === 'ashby' ? 'discovery' : 'discovery-greenhouse';

/**
 * RADAR_DISCOVERY_DRY_RUN=1 sweeps and counts but touches no table: no run row, no
 * writes, no resume cursor read. The other RADAR_DISCOVERY_* knobs only apply to a dry
 * run, so a stray variable in a workflow can never shrink a real sweep.
 */
const DRY_RUN = process.env.RADAR_DISCOVERY_DRY_RUN === '1';

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!DRY_RUN || raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be an integer`);
  return value;
}

/** Everything that differs between the two sources, in one place. */
type SourcePlan = {
  hosts: readonly string[];
  extract: (url: string) => string | null;
  commonCrawlLimits: SweepLimits;
  waybackLimits: SweepLimits;
};

function plan(startedAt: number): SourcePlan {
  const dryLimits: SweepLimits = {
    delayMs: envInt('RADAR_DISCOVERY_DELAY_MS'),
    maxPages: envInt('RADAR_DISCOVERY_MAX_PAGES'),
    firstPage: envInt('RADAR_DISCOVERY_FIRST_PAGE'),
    indexCount: envInt('RADAR_DISCOVERY_INDEXES'),
  };
  const defined = (limits: SweepLimits) =>
    Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined)) as SweepLimits;

  if (SOURCE === 'ashby') {
    return {
      hosts: ['jobs.ashbyhq.com'],
      extract: extractBoardName,
      commonCrawlLimits: defined(dryLimits),
      waybackLimits: {},
    };
  }

  const minutes = 60_000;
  const d = config.discovery;
  const hosts = config.greenhouse.boardHosts;
  return {
    hosts,
    extract: (url) => extractGreenhouseBoardToken(url, hosts),
    commonCrawlLimits: {
      deadline: startedAt + d.greenhouseCommonCrawlBudgetMinutes * minutes,
      maxConsecutiveFailures: d.greenhouseMaxConsecutiveFailures,
      ...defined(dryLimits),
    },
    waybackLimits: {
      deadline: startedAt + d.greenhouseRunBudgetMinutes * minutes,
      maxConsecutiveFailures: d.greenhouseMaxConsecutiveFailures,
      ...defined({ delayMs: dryLimits.delayMs, maxPages: dryLimits.maxPages }),
    },
  };
}

/**
 * Where the last Greenhouse run's Wayback walk stopped. Null means start from the top,
 * which is also the answer whenever the notes are missing or unreadable: a fresh full
 * walk is the safe failure, never a silently skipped stretch.
 */
async function lastWaybackCursor(hosts: readonly string[]): Promise<WaybackCursor | null> {
  const { data, error } = await supabase()
    .from('runs')
    .select('notes')
    .eq('workflow', WORKFLOW)
    .not('finished_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`could not read the last run: ${error.message}`);
  try {
    const notes = JSON.parse(data?.[0]?.notes ?? 'null') as {
      wayback?: { nextCursor?: WaybackCursor | null };
    } | null;
    const cursor = notes?.wayback?.nextCursor;
    if (cursor && hosts.includes(cursor.host) && Number.isInteger(cursor.page) && cursor.page >= 0) {
      return { host: cursor.host, page: cursor.page };
    }
  } catch {
    // Notes are capped at 20,000 characters, so an oversized one is cut mid-JSON.
  }
  return null;
}

function dryRunCursor(): WaybackCursor | null {
  const raw = process.env.RADAR_DISCOVERY_WAYBACK_START;
  if (!raw) return null;
  const [host, page] = raw.split(':');
  return host ? { host, page: Number(page ?? 0) } : null;
}

/**
 * Upserts names into companies. Existing rows keep their status and their original
 * discovered_via: a company already verified as active must not be reset to
 * unverified just because a later crawl mentions it again.
 */
async function upsertCompanies(names: string[]): Promise<number> {
  const db = supabase();
  let inserted = 0;

  for (const batch of chunk(names, config.discovery.upsertBatchSize)) {
    const { data, error } = await db
      .from('companies')
      .upsert(
        batch.map((board_name) => ({
          source: SOURCE,
          board_name,
          status: 'unverified',
          discovered_via: 'cdx',
        })),
        { onConflict: 'source,board_name', ignoreDuplicates: true },
      )
      .select('id');
    if (error) throw new Error(`companies upsert failed: ${error.message}`);
    inserted += data?.length ?? 0;
  }

  return inserted;
}

async function writeDiscoveryLog(hits: BoardHits, discoveredVia: string): Promise<void> {
  const db = supabase();
  const rows = [...hits].map(([board_name, hit]) => ({
    source: SOURCE,
    board_name,
    source_url: hit.sourceUrl,
    discovered_via: discoveredVia,
    hit_count: hit.hitCount,
    last_seen_at: new Date().toISOString(),
  }));

  for (const batch of chunk(rows, config.discovery.upsertBatchSize)) {
    const { error } = await db
      .from('discovery_log')
      .upsert(batch, { onConflict: 'source,board_name,discovered_via' });
    if (error) throw new Error(`discovery_log upsert failed: ${error.message}`);
  }
}

/** Boards per host, from the first URL each was seen in. Greenhouse notes only. */
function boardsByHost(hits: BoardHits): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { sourceUrl } of hits.values()) {
    let host = 'unparseable';
    try {
      host = new URL(sourceUrl.startsWith('http') ? sourceUrl : `https://${sourceUrl}`).hostname;
    } catch {
      // Counted under "unparseable".
    }
    counts[host] = (counts[host] ?? 0) + 1;
  }
  return counts;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const { hosts, extract, commonCrawlLimits, waybackLimits } = plan(startedAt);
  const sweeps = DRY_RUN
    ? (process.env.RADAR_DISCOVERY_SWEEPS ?? 'common_crawl,wayback').split(',')
    : ['common_crawl', 'wayback'];

  const runId = DRY_RUN ? null : await startRun(WORKFLOW);
  const failures: string[] = [];

  try {
    const commonCrawl: BoardHits = new Map();
    const wayback: BoardHits = new Map();

    let cc = { indexesQueried: 0, pagesQueried: 0, failures: [] as string[] };
    if (sweeps.includes('common_crawl')) {
      log.info('sweeping common crawl', { source: SOURCE, hosts });
      cc = await commonCrawlBoardNames(commonCrawl, hosts, extract, commonCrawlLimits);
      failures.push(...cc.failures);
      log.info('common crawl done', { boards: commonCrawl.size, pages: cc.pagesQueried });
    }

    let wb: { pagesQueried: number; failures: string[] } = { pagesQueried: 0, failures: [] };
    let waybackStart: WaybackCursor | null = null;
    let waybackNext: WaybackCursor | null = null;
    let waybackPageCounts: Record<string, number> = {};
    if (sweeps.includes('wayback')) {
      log.info('sweeping wayback', { source: SOURCE });
      if (SOURCE === 'ashby') {
        wb = await waybackBoardNames(wayback, hosts[0]!, extract);
      } else {
        waybackStart = DRY_RUN ? dryRunCursor() : await lastWaybackCursor(hosts);
        log.info('wayback starting at', { cursor: waybackStart ?? 'the beginning' });
        const paged = await waybackPagedBoardNames(
          wayback,
          hosts,
          extract,
          waybackStart,
          waybackLimits,
        );
        wb = paged;
        waybackNext = paged.nextCursor;
        waybackPageCounts = paged.pageCounts;
      }
      failures.push(...wb.failures);
      log.info('wayback done', { boards: wayback.size, pages: wb.pagesQueried });
    }

    // Merge both sources, summing hit counts, then keep one spelling per board. Greenhouse
    // tokens are lowercased at extraction, so for them this finds nothing to collapse.
    const merged: BoardHits = new Map(commonCrawl);
    for (const [name, hit] of wayback) {
      const existing = merged.get(name);
      if (existing) existing.hitCount += hit.hitCount;
      else merged.set(name, { ...hit });
    }

    const { canonical, variants } = collapseCaseVariants(merged);
    const names = [...canonical.keys()].sort();

    if (DRY_RUN) {
      const dump = process.env.RADAR_DISCOVERY_DUMP;
      if (dump) writeFileSync(dump, names.join('\n') + '\n');
      log.info('dry run complete, nothing written', {
        source: SOURCE,
        commonCrawl: { boards: commonCrawl.size, pages: cc.pagesQueried, byHost: boardsByHost(commonCrawl) },
        wayback: {
          boards: wayback.size,
          pages: wb.pagesQueried,
          byHost: boardsByHost(wayback),
          pageCounts: waybackPageCounts,
          nextCursor: waybackNext,
        },
        uniqueBoards: names.length,
        failures,
      });
      return;
    }

    await writeDiscoveryLog(commonCrawl, 'common_crawl');
    await writeDiscoveryLog(wayback, 'wayback');
    const inserted = await upsertCompanies(names);

    if (variants.length) {
      log.warn('board names differing only by case, collapsed to one each', {
        groups: variants.length,
      });
    }

    // Greenhouse puts the resume cursor first, so the 20,000-character cap on notes
    // would have to cut through everything else before it reached it, and caps its
    // failure list lower for the same reason.
    const notes = JSON.stringify(
      SOURCE === 'ashby'
        ? {
            commonCrawl: {
              boards: commonCrawl.size,
              indexes: cc.indexesQueried,
              pages: cc.pagesQueried,
            },
            wayback: { boards: wayback.size, pages: wb.pagesQueried },
            spellingsSeen: merged.size,
            uniqueBoards: names.length,
            newCompanies: inserted,
            caseVariantGroups: variants.length,
            caseVariantSample: variants.slice(0, 50),
            failures: failures.slice(0, 100),
          }
        : {
            wayback: {
              nextCursor: waybackNext,
              startedAt: waybackStart,
              boards: wayback.size,
              pages: wb.pagesQueried,
              pageCounts: waybackPageCounts,
              byHost: boardsByHost(wayback),
            },
            commonCrawl: {
              boards: commonCrawl.size,
              indexes: cc.indexesQueried,
              pages: cc.pagesQueried,
              byHost: boardsByHost(commonCrawl),
            },
            uniqueBoards: names.length,
            newCompanies: inserted,
            failureCount: failures.length,
            failures: failures.slice(0, 40).map((f) => f.slice(0, 300)),
          },
      null,
      2,
    );

    await finishRun(runId!, {
      checked: names.length,
      succeeded: names.length,
      failed: failures.length,
      notes,
    });

    log.info('discovery complete', {
      source: SOURCE,
      uniqueBoards: names.length,
      newCompanies: inserted,
      failures: failures.length,
      waybackNextCursor: waybackNext,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) {
      await finishRun(runId, {
        checked: 0,
        succeeded: 0,
        failed: 1,
        notes: JSON.stringify({ fatal: message, failures: failures.slice(0, 100) }, null, 2),
      });
    }
    throw error;
  }
}

main().catch((error) => {
  log.error('discovery failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
