/**
 * Enrichment: turn tracked boards into rows you can prospect from.
 *
 * Two passes, in order, because the second depends on the first.
 *
 *   1. NAME. Read the company's real name off its Ashby board page. Once per company,
 *      not daily: a company renames itself rarely, and the daily refresh has 4,167
 *      boards to get through already.
 *
 *   2. DOMAIN. For companies the refresh could not read a domain out of their own job
 *      adverts, guess the obvious ones and prove them by looking for a link back to
 *      this exact Ashby board.
 *
 * Neither pass ever overwrites. A name or domain already recorded is left alone, so a
 * hand correction survives every later run and re-running is always safe.
 *
 * The order matters across runs too, not just within one. Domain scoring needs the
 * company name to score against, so the first run names everything, and the refresh
 * that night picks up domains from advert links for free. Only what is still missing
 * after that reaches the verifier.
 */

import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { chunk, fetchAllPages } from '../lib/paginate.ts';
import { createRateLimiter } from '../lib/rateLimiter.ts';
import { finishRun, startRun } from '../lib/runs.ts';
import { supabase } from '../lib/supabase.ts';
import { fetchCompanyName } from './boardPage.ts';
import { pickDomain, type DomainCandidate } from './domainGuess.ts';
import { verifyDomain } from './verifyDomain.ts';

const WORKFLOW = 'enrich';

type Company = {
  id: string;
  board_name: string;
  display_name: string | null;
  domain: string | null;
  domain_candidates: DomainCandidate[] | null;
};

const SELECT = 'id, board_name, display_name, domain, domain_candidates';

function limitFrom(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? 0);
  return raw > 0 ? Math.min(raw, fallback) : fallback;
}

/** Companies we have never successfully read a name for. */
async function needingName(): Promise<Company[]> {
  return fetchAllPages<Company>('companies', config.enrich.companyPageSize, (from, to) =>
    supabase()
      .from('companies')
      .select(SELECT)
      .in('status', ['active', 'unverified'])
      .is('display_name', null)
      .is('name_checked_at', null)
      .order('id')
      .range(from, to),
  );
}

/** Active companies with no domain, after the refresh has had its go at the adverts. */
async function needingDomain(): Promise<Company[]> {
  return fetchAllPages<Company>('companies', config.enrich.companyPageSize, (from, to) =>
    supabase()
      .from('companies')
      .select(SELECT)
      .eq('status', 'active')
      .is('domain', null)
      .is('domain_checked_at', null)
      .order('id')
      .range(from, to),
  );
}

async function applyUpdates(
  rows: { id: string; patch: Record<string, unknown> }[],
): Promise<void> {
  // PostgREST has no multi-row update with different values per row, so these go one
  // at a time, batched only to bound how many are in flight at once.
  for (const batch of chunk(rows, config.enrich.updateBatchSize)) {
    await Promise.all(
      batch.map(async ({ id, patch }) => {
        const { error } = await supabase().from('companies').update(patch).eq('id', id);
        if (error) throw new Error(`company update failed: ${error.message}`);
      }),
    );
  }
}

type NameTally = { named: number; noName: number; gone: number; failed: number };
type DomainTally = {
  fromAdverts: number; backlink: number; nameMatch: number;
  unresolved: number; failed: number;
};

/** Pass 1: company names from board pages, paced at one request per second. */
async function nameCompanies(): Promise<NameTally> {
  const all = await needingName();
  const due = all.slice(0, limitFrom('RADAR_ENRICH_NAME_LIMIT', config.enrich.maxNamesPerRun));
  log.info('naming companies', { needing: all.length, thisRun: due.length });

  const slot = createRateLimiter(config.enrich.boardPageDelayMs);
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const tally: NameTally = { named: 0, noName: 0, gone: 0, failed: 0 };
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const company = due[cursor++];
      if (!company) return;
      await slot();
      const now = new Date().toISOString();
      try {
        const page = await fetchCompanyName(company.board_name);
        if (!page.found) {
          // The board has gone since the last refresh. Leave status to the refresh,
          // which is the only thing allowed to decide that, but do not ask again.
          tally.gone += 1;
          updates.push({ id: company.id, patch: { name_checked_at: now } });
        } else if (page.name) {
          tally.named += 1;
          updates.push({
            id: company.id,
            patch: { display_name: page.name, name_source: 'board_page', name_checked_at: now },
          });
        } else {
          tally.noName += 1;
          updates.push({ id: company.id, patch: { name_checked_at: now } });
        }
      } catch (error) {
        // No name_checked_at, so the next run tries again.
        tally.failed += 1;
        log.warn('name lookup failed', {
          board: company.board_name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if ((tally.named + tally.noName + tally.gone) % 250 === 0) {
        log.info('naming progress', { ...tally, of: due.length });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(6, due.length || 1) }, worker),
  );
  await applyUpdates(updates);
  log.info('naming done', tally);
  return tally;
}

/**
 * Pass 2: domains.
 *
 * Rescore the candidates the refresh already collected first, because a company named
 * in pass 1 above may now have a match it could not score before. Only what is still
 * unresolved costs a fetch.
 */
async function resolveDomains(): Promise<DomainTally> {
  const all = await needingDomain();
  const due = all.slice(0, limitFrom('RADAR_ENRICH_DOMAIN_LIMIT', config.enrich.maxVerifiesPerRun));
  log.info('resolving domains', { needing: all.length, thisRun: due.length });

  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const tally: DomainTally = { fromAdverts: 0, backlink: 0, nameMatch: 0, unresolved: 0, failed: 0 };
  const toVerify: Company[] = [];

  for (const company of due) {
    const picked = pickDomain(
      company.domain_candidates ?? [],
      company.display_name,
      config.enrich.minDomainScore,
    );
    if (picked) {
      tally.fromAdverts += 1;
      updates.push({
        id: company.id,
        patch: {
          domain: picked.domain,
          domain_confidence: picked.confidence,
          domain_source: 'job_description',
          domain_checked_at: new Date().toISOString(),
        },
      });
    } else {
      toVerify.push(company);
    }
  }

  log.info('rescored advert links', { resolved: tally.fromAdverts, toVerify: toVerify.length });

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const company = toVerify[cursor++];
      if (!company) return;
      const now = new Date().toISOString();
      try {
        const found = await verifyDomain(company.board_name, company.display_name);
        if (found) {
          if (found.source === 'careers_backlink') tally.backlink += 1;
          else tally.nameMatch += 1;
          updates.push({
            id: company.id,
            patch: {
              domain: found.domain,
              domain_confidence: found.confidence,
              domain_source: found.source,
              domain_checked_at: now,
            },
          });
        } else {
          // Checked and not found. Marked so the next run does not repeat the work;
          // these are the rows worth spending Clay credits on.
          tally.unresolved += 1;
          updates.push({ id: company.id, patch: { domain_checked_at: now } });
        }
      } catch (error) {
        tally.failed += 1;
        log.warn('domain verification failed', {
          board: company.board_name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const done = tally.backlink + tally.nameMatch + tally.unresolved;
      if (done && done % 200 === 0) log.info('verify progress', { ...tally, of: toVerify.length });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(config.enrich.verifyConcurrency, toVerify.length || 1) }, worker),
  );

  await applyUpdates(updates);
  log.info('domains done', tally);
  return tally;
}

async function main(): Promise<void> {
  const runId = await startRun(WORKFLOW);
  const only = process.env.RADAR_ENRICH_ONLY?.trim();

  try {
    const names = only === 'domains' ? null : await nameCompanies();
    const domains = only === 'names' ? null : await resolveDomains();

    const checked =
      (names ? names.named + names.noName + names.gone : 0) +
      (domains ? domains.fromAdverts + domains.backlink + domains.nameMatch + domains.unresolved : 0);
    const failed = (names?.failed ?? 0) + (domains?.failed ?? 0);

    await finishRun(runId, {
      checked,
      succeeded: checked,
      failed,
      notes: JSON.stringify({ only: only || 'all', names, domains }, null, 2),
    });
    log.info('enrich complete', { checked, failed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, {
      checked: 0,
      succeeded: 0,
      failed: 1,
      notes: JSON.stringify({ fatal: message }, null, 2),
    });
    throw error;
  }
}

main().catch((error) => {
  log.error('enrich failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
