/**
 * Deleting contacts whose retention period has run out.
 *
 * The public notice at candidhq.tech/privacy/prospecting says 24 months from the last
 * action taken on a record. This is the thing that makes that sentence true. It runs
 * monthly, and it is the only scheduled job in Radar that touches a person.
 *
 * The work is one call to purge_expired_contacts(), because the delete is a single set
 * operation and reading candidate rows into Node first would mean pulling personal data
 * out of the database in order to decide to delete it.
 *
 * It writes a run row every time, including when it deletes nothing. A retention job
 * that only leaves a trace when it fires is indistinguishable from one that stopped
 * running, and that distinction is the whole point of having it.
 */

import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { finishRun, startRun } from '../lib/runs.ts';
import { supabase } from '../lib/supabase.ts';

async function main(): Promise<void> {
  const months = config.contacts.retentionMonths;
  const runId = await startRun('retention');
  log.info('retention: purging contacts past the retention period', { months });

  try {
    const { data, error } = await supabase().rpc('purge_expired_contacts', {
      p_retention_months: months,
    });
    if (error) throw new Error(error.message);

    const deleted = typeof data === 'number' ? data : 0;
    const { count, error: countError } = await supabase()
      .from('contacts')
      .select('id', { count: 'exact', head: true });
    if (countError) throw new Error(countError.message);

    log.info('retention: done', { deleted, remaining: count ?? 0 });
    await finishRun(runId, {
      checked: (count ?? 0) + deleted,
      succeeded: deleted,
      failed: 0,
      notes: `Retention ${months} months. Deleted ${deleted}. ${count ?? 0} contacts remain.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('retention: failed', { message });
    await finishRun(runId, { checked: 0, succeeded: 0, failed: 1, notes: message });
    process.exitCode = 1;
  }
}

await main();
