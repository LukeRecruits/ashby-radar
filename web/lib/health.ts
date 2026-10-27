/**
 * Is the thing still working?
 *
 * Everything in Radar runs unattended, and the failure that matters is not the loud one.
 * A crashed workflow turns the Actions run red and sends an email. The dangerous failure
 * is the one where every run succeeds and nothing happens: the sibling project in this
 * repo's history spent sixteen days reporting "active" while writing no rows, because a
 * model id it called had been retired. Nothing failed. Nothing happened either.
 *
 * So the page is built around two questions a green tick cannot answer. When did each
 * workflow last *succeed*, against how often it is supposed to run? And are the numbers
 * it maintains still the right shape?
 *
 * The expected cadences live here rather than in the views, for the same reason the
 * queue's waiting thresholds do: a view cannot take a parameter, and the schedule is a
 * fact about the workflow files, which are also code.
 */

import { db } from './supabase';

/**
 * Hours between runs that each workflow is supposed to manage, with a margin. A workflow
 * is late when its last success is older than this, which is a different and much more
 * useful question than whether the last run passed.
 *
 * `export` is manual, so it has no expectation at all. `digest` and the Clay push are
 * retired and should never run again: if either one reports a recent run, something has
 * been scheduled that should not be.
 */
export const CADENCE: Record<string, { label: string; hours: number | null; note: string }> = {
  discovery: { label: 'Ashby discovery', hours: 24 * 9, note: 'Weekly, Sunday 03:00 UTC' },
  'discovery-greenhouse': {
    label: 'Greenhouse discovery',
    hours: 24 * 9,
    note: 'Weekly, Saturday 03:00 UTC',
  },
  enrich: { label: 'Enrich', hours: 24 * 9, note: 'Weekly, Sunday 06:30 UTC' },
  refresh: { label: 'Ashby refresh', hours: 30, note: 'Daily, 05:00 UTC' },
  'refresh-greenhouse': { label: 'Greenhouse refresh', hours: 30, note: 'Daily, 00:30 UTC' },
  triggers: { label: 'Triggers', hours: 30, note: 'Daily, 07:15 UTC' },
  retention: { label: 'Retention', hours: 24 * 35, note: 'Monthly, 1st 04:00 UTC' },
  export: { label: 'Export', hours: null, note: 'Manual only' },
  digest: { label: 'Digest', hours: null, note: 'Retired. Should not run' },
};

/**
 * One row per ATS (migration 0024). Every number is the 0021 definition restricted to
 * that source. `suppressions` and `contacts_unattached` are not about a company, so they
 * are the same global count on every row and the page prints them once.
 */
export type Summary = {
  source: string;
  companies: number;
  active: number;
  inactive: number;
  not_found: number;
  unverified: number;
  named: number;
  with_domain: number;
  with_country: number;
  parked: number;
  open_roles: number;
  evergreen_roles: number;
  stale_roles: number;
  jobs_ever: number;
  snapshot_days: number;
  first_snapshot: string | null;
  last_snapshot: string | null;
  companies_in_last_snapshot: number;
  signals: number;
  companies_with_signal: number;
  contacts: number;
  contacts_unattached: number;
  suppressions: number;
  prospects: number;
  in_band: number;
  in_band_no_recruiter_req: number;
  fully_qualified: number;
};

export type Workflow = {
  workflow: string;
  runs_30d: number;
  last_run_at: string | null;
  last_success_at: string | null;
  hours_since_run: number | null;
  hours_since_success: number | null;
  checked_30d: number;
  failed_30d: number;
};

export type Run = {
  id: string;
  workflow: string;
  started_at: string;
  finished_at: string | null;
  seconds: number | null;
  checked: number;
  succeeded: number;
  failed: number;
  outcome: 'ok' | 'partial' | 'failed' | 'running';
  notes: string | null;
};

export const RUN_SAMPLE = 25;

export async function fetchHealth(): Promise<{
  summaries: Summary[];
  workflows: Workflow[];
  runs: Run[];
}> {
  const [summary, workflows, runs] = await Promise.all([
    // Alphabetical puts Ashby first, which is the column order the page wants.
    db().from('health_summary').select('*').order('source', { ascending: true }),
    db()
      .from('health_workflows')
      .select(
        'workflow, runs_30d, last_run_at, last_success_at, hours_since_run, ' +
          'hours_since_success, checked_30d, failed_30d',
      )
      .order('workflow', { ascending: true }),
    db()
      .from('health_runs')
      .select(
        'id, workflow, started_at, finished_at, seconds, checked, succeeded, failed, ' +
          'outcome, notes',
      )
      .order('started_at', { ascending: false })
      .limit(RUN_SAMPLE),
  ]);

  for (const [name, result] of [
    ['health_summary', summary],
    ['health_workflows', workflows],
    ['health_runs', runs],
  ] as const) {
    if (result.error) throw new Error(`${name} read failed: ${result.error.message}`);
  }

  return {
    summaries: (summary.data ?? []) as unknown as Summary[],
    workflows: (workflows.data ?? []) as unknown as Workflow[],
    runs: (runs.data ?? []) as unknown as Run[],
  };
}

/**
 * Late, or never seen succeed. Both are states the green tick on a run row hides: a
 * workflow that has run five times today and last succeeded on Sunday reads as healthy
 * everywhere except here.
 */
export function isLate(row: Workflow): boolean {
  const cadence = CADENCE[row.workflow]?.hours;
  if (cadence === null || cadence === undefined) return false;
  if (row.hours_since_success === null) return true;
  return row.hours_since_success > cadence;
}

/** Workflows that are configured to run and have never been seen at all. */
export function missing(workflows: Workflow[]): string[] {
  const seen = new Set(workflows.map((w) => w.workflow));
  return Object.entries(CADENCE)
    .filter(([name, c]) => c.hours !== null && !seen.has(name))
    .map(([name]) => name);
}
