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
import { SETTINGS, getTimestamp, setSetting } from '../lib/settings.ts';
import { supabase } from '../lib/supabase.ts';
import { RULES, type Candidate, type TriggerType } from './rules.ts';

const WORKFLOW = 'triggers';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The backfill is over the moment no discovered board is still waiting for its first
 * check. Marking it here rather than by hand means new_to_ashby cannot be armed early,
 * and because it only fires for companies first seen *after* the marker, setting it can
 * never retroactively flag the 5,731 companies the backfill just verified.
 */
async function backfillMarker(): Promise<string | null> {
  const existing = await getTimestamp(SETTINGS.initialBackfillCompletedAt);
  if (existing) return existing;

  const { count, error } = await supabase()
    .from('companies')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'unverified');
  if (error) throw new Error(`unverified count failed: ${error.message}`);

  if ((count ?? 0) > 0) {
    log.info('initial backfill still running, new_to_ashby stays off', {
      unverified: count,
    });
    return null;
  }

  const now = new Date().toISOString();
  await setSetting(SETTINGS.initialBackfillCompletedAt, now);
  log.info('initial backfill complete, new_to_ashby armed for companies found after', {
    at: now,
  });
  return now;
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
    const backfillCompletedAt = await backfillMarker();
    const ctx = { runDate, backfillCompletedAt };

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
        backfillCompletedAt,
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
