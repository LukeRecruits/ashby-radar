/**
 * The people sweep: who is on the talent and people team at every in-band prospect.
 *
 * Until 2026-11-05 a person was looked up only when Luke pressed "Find the talent lead" on
 * one company page. This runs the same search for every in-band prospect on a schedule
 * and stores what survives the filters in `company_people`, so the lead list and the
 * company page show names before anybody clicks.
 *
 * It imports the console's own lookup (web/lib/exa.ts) rather than keeping a copy, because
 * the employer filter is the one thing that cannot be allowed to drift: a second version
 * that let STRATOS staff through as Vertice staff would put wrong names in front of Luke.
 *
 * Each company is replaced whole by replace_company_people(), which also records the
 * search in `people_lookups`, so a company where nobody survived is not searched again
 * tomorrow. Suppressed profiles are skipped in that function and refused by trigger.
 */

import { findTalentContacts } from '../../web/lib/exa.ts';
import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { finishRun, startRun } from '../lib/runs.ts';
import { supabase } from '../lib/supabase.ts';

type QueueRow = { company_id: string; label: string; domain: string | null };

async function sweepOne(row: QueueRow): Promise<{ kept: number } | { error: string }> {
  const result = await findTalentContacts(row.label, row.domain);
  if (result.state === 'unconfigured') return { error: 'EXA_API_KEY is not set' };
  if (result.state === 'error') return { error: result.message };

  const people = result.candidates.map((c) => ({
    full_name: c.name,
    job_title: c.title,
    linkedin_url: c.linkedinUrl,
    started_at: c.startedAt,
    seniority_band: c.read.band,
    rank: c.read.score,
  }));

  const { data, error } = await supabase().rpc('replace_company_people', {
    p_company_id: row.company_id,
    p_people: people,
    p_returned: result.returned,
    p_dropped: result.dropped,
  });
  if (error) return { error: error.message };
  return { kept: typeof data === 'number' ? data : 0 };
}

async function main(): Promise<void> {
  const { companiesPerRun, refreshDays, concurrency, retentionMonths } = config.people;
  const runId = await startRun('people');

  try {
    const { data: queue, error } = await supabase().rpc('people_sweep_queue', {
      p_limit: companiesPerRun,
      p_stale_days: refreshDays,
    });
    if (error) throw new Error(error.message);
    const rows = (queue ?? []) as QueueRow[];
    log.info('people: sweeping', { companies: rows.length });

    let succeeded = 0;
    let failed = 0;
    let people = 0;
    const errors: string[] = [];
    let next = 0;

    // A fixed pool of workers pulling from one index: simple, and never more than
    // `concurrency` searches in flight.
    async function worker(): Promise<void> {
      while (next < rows.length) {
        const row = rows[next++];
        if (!row) return;
        const outcome = await sweepOne(row);
        if ('error' in outcome) {
          failed += 1;
          if (errors.length < 20) errors.push(`${row.label}: ${outcome.error}`);
          // A missing key or an exhausted balance fails every search the same way.
          // Stop rather than spend the run writing the same error 500 times.
          if (/EXA_API_KEY|402|insufficient|credit/i.test(outcome.error)) next = rows.length;
        } else {
          succeeded += 1;
          people += outcome.kept;
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));

    const { data: purged, error: purgeError } = await supabase().rpc(
      'purge_stale_company_people',
      { p_retention_months: retentionMonths },
    );
    if (purgeError) throw new Error(purgeError.message);

    log.info('people: done', { succeeded, failed, people, purged });
    await finishRun(runId, {
      checked: rows.length,
      succeeded,
      failed,
      notes: [
        `Searched ${succeeded} of ${rows.length} companies, stored ${people} people. Purged ${purged ?? 0} not seen in ${retentionMonths} months.`,
        ...errors,
      ].join('\n'),
    });
    if (failed > succeeded) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('people: failed', { message });
    await finishRun(runId, { checked: 0, succeeded: 0, failed: 1, notes: message });
    process.exitCode = 1;
  }
}

await main();
