/**
 * Pushes triggers into a Clay table through its webhook, then marks them exported.
 *
 * Clay's table webhook takes one JSON object per request, so this posts a row at a
 * time with a gap between them. `exported_at` is set only for rows Clay accepted, so a
 * failure mid-run leaves the rest to be picked up tomorrow rather than losing them.
 *
 * The first evaluation leaves a backlog in the thousands, mostly long_open. The run cap
 * in config drains that over several days instead of dumping it into Clay at once.
 *
 * Without CLAY_WEBHOOK_URL it does nothing and says so.
 */

import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { chunk } from '../lib/paginate.ts';
import { finishRun, startRun } from '../lib/runs.ts';
import { sleep } from '../lib/sleep.ts';
import { supabase } from '../lib/supabase.ts';
import { loadTriggers, triggerView } from '../triggers/read.ts';
import { firstEvidenceUrl, summarise } from '../triggers/summary.ts';
import { postToClay } from './post.ts';

const WORKFLOW = 'clay';

async function markExported(ids: string[]): Promise<void> {
  const now = new Date().toISOString();
  for (const batch of chunk(ids, config.clay.markBatchSize)) {
    const { error } = await supabase()
      .from('triggers')
      .update({ exported_at: now })
      .in('id', batch);
    if (error) throw new Error(`exported_at update failed: ${error.message}`);
  }
}

async function main(): Promise<void> {
  const webhook = process.env.CLAY_WEBHOOK_URL?.trim();
  if (!webhook) {
    log.warn('CLAY_WEBHOOK_URL is not set, nothing pushed');
    return;
  }

  const runId = await startRun(WORKFLOW);
  const exported: string[] = [];
  const failures: string[] = [];

  try {
    const pending = await loadTriggers({
      unexportedOnly: true,
      limit: config.clay.maxPerRun,
    });
    log.info('clay push starting', { pending: pending.length });

    for (const row of pending) {
      const view = triggerView(row);
      try {
        await postToClay(webhook, {
          record_type: 'trigger',
          trigger_id: view.id,
          trigger_type: view.type,
          fired_at: view.firedAt,
          company_name: view.company,
          board_name: view.boardName,
          board_url: view.boardUrl,
          domain: view.domain,
          open_roles: view.openRoles,
          evidence_summary: summarise(view.type, view.evidence),
          evidence_url: firstEvidenceUrl(view.evidence),
        });
        exported.push(view.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${view.boardName} (${view.type}): ${message}`);
        log.warn('clay push failed for one trigger', { id: view.id, error: message });
      }
      await sleep(config.clay.requestDelayMs);
    }

    if (exported.length) await markExported(exported);

    const notes = JSON.stringify(
      {
        pending: pending.length,
        exported: exported.length,
        failed: failures.length,
        cap: config.clay.maxPerRun,
        failures: failures.slice(0, 50),
      },
      null,
      2,
    );

    await finishRun(runId, {
      checked: pending.length,
      succeeded: exported.length,
      failed: failures.length,
      notes,
    });
    log.info('clay push complete', { exported: exported.length, failed: failures.length });

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
  log.error('clay push failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
