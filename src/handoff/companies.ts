/**
 * Pushes qualified companies to Clay, which is where contacts live.
 *
 * The division of labour, decided 2026-09-30: Radar knows which companies are worth
 * talking to and why. Clay finds the person to talk to. Radar never stores a person,
 * so it never becomes a UK GDPR processing activity in its own right, and the contact
 * data sits in the tool that is built for it and already covered for it.
 *
 * What goes over is everything Clay needs to key on and everything Luke needs to judge
 * the row without opening Radar: the domain, where they actually hire, how much they
 * are hiring, whether they already have in-house TA, and whether they publish pay.
 *
 * A company goes once. `exported_at` is set only for rows Clay accepted, so a failure
 * mid-run leaves the rest for tomorrow rather than losing them.
 */

import { config } from '../config.ts';
import { boardPageUrl, companyLabel } from '../lib/company.ts';
import { log } from '../lib/log.ts';
import { chunk, fetchAllPages, type PageResult } from '../lib/paginate.ts';
import { finishRun, startRun } from '../lib/runs.ts';
import { sleep } from '../lib/sleep.ts';
import { supabase } from '../lib/supabase.ts';
import { postToClay } from './post.ts';

const WORKFLOW = 'clay_companies';

type Row = {
  id: string;
  board_name: string;
  display_name: string | null;
  domain: string | null;
  domain_confidence: number | null;
  domain_source: string | null;
  top_country: string | null;
  top_locality: string | null;
  remote_share: number | null;
  first_seen_at: string;
  snapshots: { open_role_count: number; recruiter_role_count: number; comp_published_count: number }[];
};

const SELECT =
  'id, board_name, display_name, domain, domain_confidence, domain_source, ' +
  'top_country, top_locality, remote_share, first_seen_at, ' +
  'snapshots(open_role_count, recruiter_role_count, comp_published_count)';

/**
 * Companies worth Clay's time: live on Ashby, with a domain Clay can key on, not
 * parked by hand, not already sent.
 *
 * A company with no domain is deliberately excluded rather than sent for Clay to
 * resolve. Clay matches on domain, and feeding it a bare company name is how
 * `omnea.com` became an Australian cemetery-software firm.
 */
async function pending(limit: number): Promise<Row[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await fetchAllPages<Row>('companies', config.exports.pageSize, (from, to) =>
    // Cast because the embedded snapshots(...) select defeats the client's row typing.
    supabase()
      .from('companies')
      .select(SELECT)
      .eq('status', 'active')
      .not('domain', 'is', null)
      .is('parked_at', null)
      .is('exported_at', null)
      .gte('snapshots.snapshot_date', today)
      .order('first_seen_at')
      .order('id')
      .range(from, to) as unknown as PageResult<Row>,
  );
  return rows.slice(0, limit);
}

async function markExported(ids: string[]): Promise<void> {
  const now = new Date().toISOString();
  for (const batch of chunk(ids, config.clay.markBatchSize)) {
    const { error } = await supabase()
      .from('companies')
      .update({ exported_at: now })
      .in('id', batch);
    if (error) throw new Error(`exported_at update failed: ${error.message}`);
  }
}

async function main(): Promise<void> {
  const webhook = process.env.CLAY_WEBHOOK_URL?.trim();
  if (!webhook) {
    log.warn('CLAY_WEBHOOK_URL is not set, no companies pushed');
    return;
  }

  const runId = await startRun(WORKFLOW);
  const exported: string[] = [];
  const failures: string[] = [];

  try {
    const rows = await pending(config.clay.maxPerRun);
    log.info('company push starting', { pending: rows.length });

    for (const row of rows) {
      const snapshot = row.snapshots?.[0];
      try {
        await postToClay(webhook, {
          record_type: 'company',
          company_name: companyLabel(row),
          domain: row.domain,
          domain_confidence: row.domain_confidence,
          domain_source: row.domain_source,
          ashby_board: row.board_name,
          board_url: boardPageUrl(row.board_name),
          hiring_country: row.top_country,
          hiring_locality: row.top_locality,
          remote_share_pct: row.remote_share,
          open_roles: snapshot?.open_role_count ?? null,
          recruiter_roles: snapshot?.recruiter_role_count ?? null,
          roles_with_pay: snapshot?.comp_published_count ?? null,
          first_seen_at: row.first_seen_at,
        });
        exported.push(row.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${row.board_name}: ${message}`);
        log.warn('company push failed', { board: row.board_name, error: message });
      }
      await sleep(config.clay.requestDelayMs);
    }

    if (exported.length) await markExported(exported);

    await finishRun(runId, {
      checked: rows.length,
      succeeded: exported.length,
      failed: failures.length,
      notes: JSON.stringify(
        { pending: rows.length, exported: exported.length, failures: failures.slice(0, 50) },
        null,
        2,
      ),
    });
    log.info('company push complete', { exported: exported.length, failed: failures.length });
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (exported.length) await markExported(exported);
    await finishRun(runId, {
      checked: 0,
      succeeded: exported.length,
      failed: 1,
      notes: JSON.stringify({ fatal: message, exported: exported.length }, null, 2),
    });
    throw error;
  }
}

main().catch((error) => {
  log.error('company push failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
