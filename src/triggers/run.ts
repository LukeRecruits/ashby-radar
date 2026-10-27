/**
 * Daily trigger evaluation, straight after the refresh.
 *
 * Reads the day's snapshots and the job history, applies the six rules in rules.ts, and
 * writes a row to `triggers` for every company that qualifies. Nothing is sent from
 * here: the Slack digest and the Clay push read the rows this leaves behind.
 *
 * Safe to run twice in a day. Each rule excludes any company that already has a trigger
 * of that type inside the dedupe window, so a second run finds nothing new.
 */

import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { chunk } from '../lib/paginate.ts';
import { finishRun, startRun } from '../lib/runs.ts';
import { workflowName } from '../ats/clients.ts';
import { SOURCES, type Source } from '../ats/types.ts';
import { backfillKey, getTimestamp, setSetting } from '../lib/settings.ts';
import { supabase } from '../lib/supabase.ts';
import { RULES, type Candidate, type TriggerType } from './rules.ts';

const WORKFLOW = 'triggers';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A source's backfill is over the moment none of its discovered boards is still waiting
 * for a first check. Marking it here rather than by hand means new_to_ashby cannot be
 * armed early, and because it only fires for companies first seen *after* the marker,
 * setting it can never retroactively flag the companies the backfill just verified.
 *
 * One marker per source. A source with no companies at all is not "backfilled", it is
 * not started: arming it then would let its whole first discovery fire as new.
 */
async function backfillMarker(source: Source): Promise<string | null> {
  const key = backfillKey(source);
  const existing = await getTimestamp(key);
  if (existing) return existing;

  const db = supabase();
  const total = await db
    .from('companies')
    .select('id', { count: 'exact', head: true })
    .eq('source', source);
  if (total.error) throw new Error(`${source} company count failed: ${total.error.message}`);
  const waiting = await db
    .from('companies')
    .select('id', { count: 'exact', head: true })
    .eq('source', source)
    .eq('status', 'unverified');
  if (waiting.error) throw new Error(`${source} unverified count failed: ${waiting.error.message}`);

  // Greenhouse's Wayback sweep is too big for one run and resumes from a cursor, so its
  // first discovery spans about two weeks. Arming on the first week's names would let
  // the second week's arrive as thousands of companies "new" to Greenhouse. A source
  // other than Ashby therefore also waits for a finished discovery run whose cursor
  // says the sweep went all the way round.
  const swept = source === 'ashby' || (await discoveryCycleComplete(source));

  if ((total.count ?? 0) === 0 || (waiting.count ?? 0) > 0 || !swept) {
    log.info('backfill not finished, new_to_ashby stays off for this source', {
      source,
      companies: total.count,
      unverified: waiting.count,
      discoveryCycleComplete: swept,
    });
    return null;
  }

  const now = new Date().toISOString();
  await setSetting(key, now);
  log.info('backfill complete, new_to_ashby armed for companies found after', { source, at: now });
  return now;
}

/** True once some finished discovery run for this source left no Wayback cursor. */
async function discoveryCycleComplete(source: Source): Promise<boolean> {
  const { data, error } = await supabase()
    .from('runs')
    .select('notes')
    .eq('workflow', workflowName('discovery', source))
    .not('finished_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`${source} discovery runs read failed: ${error.message}`);
  return (data ?? []).some((row) => {
    try {
      const notes = JSON.parse(String(row.notes ?? '')) as {
        fatal?: unknown;
        wayback?: { nextCursor?: unknown };
      };
      return !notes.fatal && notes.wayback !== undefined && notes.wayback.nextCursor === null;
    } catch {
      return false;
    }
  });
}

async function insertTriggers(type: TriggerType, found: Candidate[]): Promise<number> {
  let written = 0;
  for (const batch of chunk(found, config.triggers.insertBatchSize)) {
    const { data, error } = await supabase()
      .from('triggers')
      .insert(
        batch.map((candidate) => ({
          company_id: candidate.companyId,
          type,
          evidence: candidate.evidence,
        })),
      )
      .select('id');
    if (error) throw new Error(`${type} insert failed: ${error.message}`);
    written += data?.length ?? 0;
  }
  return written;
}

async function main(): Promise<void> {
  const runId = await startRun(WORKFLOW);
  const runDate = todayUtc();
  const fired: Record<string, number> = {};
  const problems: string[] = [];

  try {
    const backfillMarkers: Partial<Record<Source, string>> = {};
    for (const source of SOURCES) {
      const marker = await backfillMarker(source);
      if (marker) backfillMarkers[source] = marker;
    }
    const ctx = { runDate, backfillMarkers };

    // Sequential on purpose. Each rule is one heavy query over every active company,
    // and running them one at a time keeps the database out of trouble for the sake of
    // a few seconds on a job that runs once a day.
    for (const rule of RULES) {
      try {
        const found = await rule.find(ctx);
        const written = found.length ? await insertTriggers(rule.type, found) : 0;
        fired[rule.type] = written;
        log.info('rule evaluated', { type: rule.type, fired: written });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fired[rule.type] = 0;
        problems.push(`${rule.type}: ${message}`);
        log.error('rule failed', { type: rule.type, error: message });
      }
    }

    const total = Object.values(fired).reduce((sum, n) => sum + n, 0);
    const notes = JSON.stringify(
      {
        runDate,
        backfillMarkers,
        fired,
        total,
        problems,
      },
      null,
      2,
    );

    await finishRun(runId, {
      checked: RULES.length,
      succeeded: RULES.length - problems.length,
      failed: problems.length,
      notes,
    });
    log.info('triggers complete', { total, ...fired });

    // A rule that threw left the day unevaluated for that signal. Fail the workflow so
    // it is visible rather than quietly missing from tomorrow's digest.
    if (problems.length) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, {
      checked: 0,
      succeeded: 0,
      failed: 1,
      notes: JSON.stringify({ fatal: message, fired, problems }, null, 2),
    });
    throw error;
  }
}

main().catch((error) => {
  log.error('triggers failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
