import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { chunk } from '../lib/paginate.ts';
import { finishRun, startRun } from '../lib/runs.ts';
import { supabase } from '../lib/supabase.ts';
import { collapseCaseVariants } from './boardName.ts';
import { commonCrawlBoardNames, waybackBoardNames, type BoardHits } from './cdx.ts';

const WORKFLOW = 'discovery';

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
          source: 'ashby',
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
    board_name,
    source_url: hit.sourceUrl,
    discovered_via: discoveredVia,
    hit_count: hit.hitCount,
    last_seen_at: new Date().toISOString(),
  }));

  for (const batch of chunk(rows, config.discovery.upsertBatchSize)) {
    const { error } = await db
      .from('discovery_log')
      .upsert(batch, { onConflict: 'board_name,discovered_via' });
    if (error) throw new Error(`discovery_log upsert failed: ${error.message}`);
  }
}

async function main(): Promise<void> {
  const runId = await startRun(WORKFLOW);
  const failures: string[] = [];

  try {
    const commonCrawl: BoardHits = new Map();
    const wayback: BoardHits = new Map();

    log.info('sweeping common crawl');
    const cc = await commonCrawlBoardNames(commonCrawl);
    failures.push(...cc.failures);
    log.info('common crawl done', { boards: commonCrawl.size, pages: cc.pagesQueried });

    log.info('sweeping wayback');
    const wb = await waybackBoardNames(wayback);
    failures.push(...wb.failures);
    log.info('wayback done', { boards: wayback.size, pages: wb.pagesQueried });

    await writeDiscoveryLog(commonCrawl, 'common_crawl');
    await writeDiscoveryLog(wayback, 'wayback');

    // Merge both sources, summing hit counts, then keep one spelling per board.
    const merged: BoardHits = new Map(commonCrawl);
    for (const [name, hit] of wayback) {
      const existing = merged.get(name);
      if (existing) existing.hitCount += hit.hitCount;
      else merged.set(name, { ...hit });
    }

    const { canonical, variants } = collapseCaseVariants(merged);
    const names = [...canonical.keys()].sort();
    const inserted = await upsertCompanies(names);

    if (variants.length) {
      log.warn('board names differing only by case, collapsed to one each', {
        groups: variants.length,
      });
    }

    const notes = JSON.stringify(
      {
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
      },
      null,
      2,
    );

    await finishRun(runId, {
      checked: names.length,
      succeeded: names.length,
      failed: failures.length,
      notes,
    });

    log.info('discovery complete', {
      uniqueBoards: names.length,
      newCompanies: inserted,
      failures: failures.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, {
      checked: 0,
      succeeded: 0,
      failed: 1,
      notes: JSON.stringify({ fatal: message, failures: failures.slice(0, 100) }, null, 2),
    });
    throw error;
  }
}

main().catch((error) => {
  log.error('discovery failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
