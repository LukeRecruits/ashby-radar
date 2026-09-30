/**
 * CSV exports, on manual trigger only.
 *
 * Two files, written to the directory in config and uploaded by the workflow as run
 * artifacts:
 *
 *   companies.csv  every active company with its latest snapshot
 *   triggers.csv   every trigger fired in a date range, with its evidence summary
 *
 * Dates come from the workflow inputs as RADAR_EXPORT_FROM / RADAR_EXPORT_TO, both
 * YYYY-MM-DD. Unset means the last 30 days.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../config.ts';
import { boardPageUrl, companyLabel } from '../lib/company.ts';
import { log } from '../lib/log.ts';
import { fetchAllPages } from '../lib/paginate.ts';
import { finishRun, startRun } from '../lib/runs.ts';
import { supabase } from '../lib/supabase.ts';
import { loadTriggers, triggerView } from '../triggers/read.ts';
import { summarise } from '../triggers/summary.ts';

const WORKFLOW = 'export';

/** RFC 4180: quote everything, double the quotes inside. Board names contain commas. */
function csv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`)
        .join(','),
    )
    .join('\n');
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateInput(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${name} must be YYYY-MM-DD, got "${raw}"`);
  }
  return raw;
}

type CompanyExportRow = {
  id: string;
  board_name: string;
  display_name: string | null;
  domain: string | null;
  status: string;
  discovered_via: string | null;
  first_seen_at: string;
  last_checked_at: string | null;
  last_active_at: string | null;
};

type SnapshotRow = {
  company_id: string;
  snapshot_date: string;
  open_role_count: number;
  recruiter_role_count: number;
  comp_published_count: number;
};

/**
 * The latest snapshot per company. Pulled as a window rather than the whole table:
 * a company checked successfully at any point in the last week has one in here, and a
 * company that has not been checked in a week has nothing current worth exporting.
 */
async function latestSnapshots(): Promise<Map<string, SnapshotRow>> {
  const since = isoDate(new Date(Date.now() - 7 * 86_400_000));
  const rows = await fetchAllPages<SnapshotRow>(
    'snapshots',
    config.exports.pageSize,
    (from, to) =>
      supabase()
        .from('snapshots')
        .select(
          'company_id, snapshot_date, open_role_count, recruiter_role_count, comp_published_count',
        )
        .gte('snapshot_date', since)
        .order('company_id')
        .order('snapshot_date')
        .range(from, to),
  );

  const latest = new Map<string, SnapshotRow>();
  // Ordered ascending by date, so the last write per company wins.
  for (const row of rows) latest.set(row.company_id, row);
  return latest;
}

async function exportCompanies(dir: string): Promise<number> {
  const companies = await fetchAllPages<CompanyExportRow>(
    'companies',
    config.exports.pageSize,
    (from, to) =>
      supabase()
        .from('companies')
        .select(
          'id, board_name, display_name, domain, status, discovered_via, first_seen_at, last_checked_at, last_active_at',
        )
        .eq('status', 'active')
        .order('board_name')
        .order('id')
        .range(from, to),
  );

  const snapshots = await latestSnapshots();

  const rows: (string | number | null)[][] = [
    [
      'company',
      'board_name',
      'board_url',
      'domain',
      'status',
      'discovered_via',
      'first_seen_at',
      'last_checked_at',
      'last_active_at',
      'snapshot_date',
      'open_roles',
      'recruiter_roles',
      'roles_with_pay',
    ],
  ];

  for (const company of companies) {
    const snapshot = snapshots.get(company.id);
    rows.push([
      companyLabel(company),
      company.board_name,
      boardPageUrl(company.board_name),
      company.domain,
      company.status,
      company.discovered_via,
      company.first_seen_at,
      company.last_checked_at,
      company.last_active_at,
      snapshot?.snapshot_date ?? null,
      snapshot?.open_role_count ?? null,
      snapshot?.recruiter_role_count ?? null,
      snapshot?.comp_published_count ?? null,
    ]);
  }

  await writeFile(join(dir, 'companies.csv'), csv(rows), 'utf8');
  return companies.length;
}

async function exportTriggers(dir: string, from: string, to: string): Promise<number> {
  // `to` is inclusive of the whole day, so the upper bound is the following midnight.
  const until = new Date(`${to}T00:00:00.000Z`);
  until.setUTCDate(until.getUTCDate() + 1);

  const triggers = await loadTriggers({
    since: new Date(`${from}T00:00:00.000Z`).toISOString(),
    until: until.toISOString(),
  });

  const rows: (string | number | null)[][] = [
    [
      'fired_at',
      'trigger_type',
      'company',
      'board_name',
      'board_url',
      'domain',
      'open_roles',
      'evidence_summary',
      'reviewed',
      'exported_at',
      'evidence_json',
    ],
  ];

  for (const trigger of triggers) {
    const view = triggerView(trigger);
    rows.push([
      view.firedAt,
      view.type,
      view.company,
      view.boardName,
      view.boardUrl,
      view.domain,
      view.openRoles,
      summarise(view.type, view.evidence),
      String(trigger.reviewed),
      trigger.exported_at,
      JSON.stringify(view.evidence),
    ]);
  }

  await writeFile(join(dir, 'triggers.csv'), csv(rows), 'utf8');
  return triggers.length;
}

async function main(): Promise<void> {
  const runId = await startRun(WORKFLOW);

  try {
    const today = isoDate(new Date());
    const from = dateInput(
      'RADAR_EXPORT_FROM',
      isoDate(new Date(Date.now() - 30 * 86_400_000)),
    );
    const to = dateInput('RADAR_EXPORT_TO', today);

    const dir = config.exports.outputDir;
    await mkdir(dir, { recursive: true });

    const companies = await exportCompanies(dir);
    const triggers = await exportTriggers(dir, from, to);

    const notes = JSON.stringify({ from, to, companies, triggers, dir }, null, 2);
    await finishRun(runId, {
      checked: companies + triggers,
      succeeded: companies + triggers,
      failed: 0,
      notes,
    });
    log.info('export complete', { companies, triggers, from, to, dir });
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
  log.error('export failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
