/**
 * Health: whether the unattended half of Radar is still doing its job.
 *
 * Three blocks, in the order they fail. The workflows, because a job that stopped
 * succeeding is the thing that silently empties everything below it. The funnel of
 * qualification, because that is the number the whole console rests on and a rule
 * breaking shows up here as a collapse rather than as an error. Then the runs
 * themselves, for reading after something looks wrong.
 *
 * No charts. Nine workflows and twenty numbers per ATS do not need a shape drawn round
 * them. Ashby and Greenhouse sit side by side, one column each, never summed.
 */

import { Nav } from '@/components/Nav';
import {
  CADENCE,
  RUN_SAMPLE,
  fetchHealth,
  isLate,
  missing,
  type Summary,
  type Workflow,
} from '@/lib/health';
import { atsLabel } from '@/lib/leads';

export const dynamic = 'force-dynamic';

function when(iso: string | null): string {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function ago(hours: number | null): string {
  if (hours === null) return 'never';
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string | number;
  note?: string;
  tone?: 'warm' | 'good';
}) {
  return (
    <div>
      <div
        className="nums text-lg font-semibold leading-tight"
        style={{ color: tone === 'warm' ? 'var(--warm)' : tone === 'good' ? 'var(--good)' : undefined }}
      >
        {typeof value === 'number' ? value.toLocaleString('en-GB') : value}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">{label}</div>
      {note ? <div className="mt-0.5 text-[11px] text-[var(--ink-soft)]">{note}</div> : null}
    </div>
  );
}

function share(part: number, whole: number): string {
  return whole === 0 ? '–' : `${Math.round((part / whole) * 100)}%`;
}

function Workflows({ rows }: { rows: Workflow[] }) {
  const absent = missing(rows);

  return (
    <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">Workflows</h2>
        <span className="text-[11px] text-[var(--ink-faint)]">
          Last success against the schedule, not last run
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">
              <th className="pb-1 font-medium">Workflow</th>
              <th className="pb-1 font-medium">Last success</th>
              <th className="pb-1 font-medium">Last run</th>
              <th className="pb-1 text-right font-medium">Runs 30d</th>
              <th className="pb-1 text-right font-medium">Checked</th>
              <th className="pb-1 text-right font-medium">Failed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const cadence = CADENCE[row.workflow];
              const late = isLate(row);
              const retired = cadence?.note.startsWith('Retired') ?? false;
              return (
                <tr key={row.workflow} className="border-t border-[var(--line)]">
                  <td className="py-1.5">
                    <span className="font-medium">{cadence?.label ?? row.workflow}</span>
                    <div className="text-[11px] text-[var(--ink-faint)]">
                      {cadence?.note ?? 'No schedule recorded'}
                    </div>
                  </td>
                  <td className="py-1.5" style={{ color: late ? 'var(--warm)' : undefined }}>
                    {ago(row.hours_since_success)}
                    {late ? ' · late' : ''}
                    <div className="text-[11px] text-[var(--ink-faint)]">
                      {when(row.last_success_at)}
                    </div>
                  </td>
                  <td className="py-1.5 text-[var(--ink-soft)]">
                    {ago(row.hours_since_run)}
                    {retired && row.hours_since_run !== null && row.hours_since_run < 24 * 7 ? (
                      <div className="text-[11px]" style={{ color: 'var(--warm)' }}>
                        Retired, and it has run this week
                      </div>
                    ) : null}
                  </td>
                  <td className="nums py-1.5 text-right">{row.runs_30d}</td>
                  <td className="nums py-1.5 text-right text-[var(--ink-soft)]">
                    {row.checked_30d.toLocaleString('en-GB')}
                  </td>
                  <td
                    className="nums py-1.5 text-right"
                    style={{ color: row.failed_30d > 0 ? 'var(--warm)' : 'var(--ink-faint)' }}
                  >
                    {row.failed_30d}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {absent.length ? (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--warm)' }}>
          Not seen at all in the last 30 days: {absent.join(', ')}. A scheduled workflow
          with no run row has either never fired or cannot reach the database.
        </p>
      ) : null}
    </section>
  );
}

/**
 * One column per ATS, side by side, so the two funnels can be read against each other.
 * The numbers are per source; nothing here adds Ashby and Greenhouse together, because a
 * combined funnel would hide a collapse in the smaller one.
 */
function BySource({
  rows,
  children,
}: {
  rows: Summary[];
  children: (s: Summary) => React.ReactNode;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {rows.map((s) => (
        <div key={s.source} className="rounded-md border border-[var(--line)] p-3">
          <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
            {atsLabel(s.source)}
          </h3>
          <div className="flex flex-wrap gap-x-8 gap-y-4">{children(s)}</div>
        </div>
      ))}
    </div>
  );
}

function Qualification({ rows }: { rows: Summary[] }) {
  // Global, not per source: a suppression is a person with no employer attached.
  const suppressions = rows[0]?.suppressions ?? 0;
  const unattached = rows[0]?.contacts_unattached ?? 0;
  return (
    <section className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">The funnel of qualification</h2>
        <span className="text-[11px] text-[var(--ink-faint)]">
          Watch the last number. A rule breaking shows up here as a collapse, not an error
        </span>
      </div>
      <BySource rows={rows}>
        {(s) => (
          <>
            <Stat
              label="Discovered"
              value={s.companies}
              note={`${s.active.toLocaleString('en-GB')} still live on ${atsLabel(s.source)}`}
            />
            <Stat label="Prospects" value={s.prospects} note="Active, with a domain, not parked" />
            <Stat label="In band" value={s.in_band} note="5 to 50 open roles" />
            <Stat
              label="No recruiter req"
              value={s.in_band_no_recruiter_req}
              note="Not hiring a recruiter today"
            />
            <Stat
              label="Fully qualified"
              value={s.fully_qualified}
              note="And 3+ genuinely stale roles"
              tone={s.fully_qualified === 0 ? 'warm' : 'good'}
            />
            <Stat label="On the funnel" value={s.contacts} note="Contacts at these companies" />
          </>
        )}
      </BySource>
      <p className="mt-3 text-[12px] text-[var(--ink-soft)]">
        <span className="nums">{suppressions.toLocaleString('en-GB')}</span> suppressed, across
        every ATS.
        {unattached > 0 ? (
          <>
            {' '}
            <span className="nums">{unattached.toLocaleString('en-GB')}</span> on the funnel
            with no company attached, so counted in neither column.
          </>
        ) : null}
      </p>
    </section>
  );
}

function Data({ rows }: { rows: Summary[] }) {
  return (
    <section className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
      <h2 className="mb-3 text-[13px] font-semibold tracking-tight">The data behind it</h2>
      <BySource rows={rows}>
        {(s) => {
          const thin = s.snapshot_days < 31;
          return (
            <>
              <Stat label="Named" value={s.named} note={share(s.named, s.companies)} />
              <Stat label="With a domain" value={s.with_domain} note={share(s.with_domain, s.companies)} />
              <Stat label="With a country" value={s.with_country} note={share(s.with_country, s.companies)} />
              <Stat
                label={`Left ${atsLabel(s.source)}`}
                value={s.not_found + s.inactive}
                note="Checked and gone"
              />
              <Stat
                label="Open roles"
                value={s.open_roles}
                note={`${s.stale_roles.toLocaleString('en-GB')} stale, ${s.evergreen_roles} evergreen and not counted`}
              />
              <Stat
                label="Snapshot days"
                value={s.snapshot_days}
                note={
                  thin
                    ? 'Under 31, so the 30-day rules are still warming up'
                    : `From ${s.first_snapshot}`
                }
                tone={thin ? 'warm' : undefined}
              />
              <Stat
                label="In today's snapshot"
                value={s.companies_in_last_snapshot}
                note={
                  s.last_snapshot
                    ? `${share(s.companies_in_last_snapshot, s.active)} of active, on ${s.last_snapshot}`
                    : 'No snapshot yet'
                }
                tone={s.companies_in_last_snapshot < s.active * 0.98 ? 'warm' : undefined}
              />
              <Stat
                label="Signals"
                value={s.signals}
                note={`${s.companies_with_signal.toLocaleString('en-GB')} companies`}
              />
            </>
          );
        }}
      </BySource>
    </section>
  );
}

export default async function HealthPage() {
  const { summaries, workflows, runs } = await fetchHealth();

  return (
    <main className="mx-auto max-w-[1100px] px-4 py-6">
      <Nav current="/health" />

      <header className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Health</h1>
        <p className="mt-1 text-[13px] text-[var(--ink-soft)]">
          The loud failure sends an email. This page is for the quiet one, where everything
          succeeds and nothing happens.
        </p>
      </header>

      <Workflows rows={workflows} />
      {summaries.length ? <Qualification rows={summaries} /> : null}
      {summaries.length ? <Data rows={summaries} /> : null}

      <section className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[13px] font-semibold tracking-tight">Recent runs</h2>
          <span className="text-[11px] text-[var(--ink-faint)]">Last {RUN_SAMPLE}</span>
        </div>
        <ul className="text-[13px]">
          {runs.map((run) => (
            <li key={run.id} className="border-t border-[var(--line)] py-1.5 first:border-t-0">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span>
                  <span className="font-medium">{CADENCE[run.workflow]?.label ?? run.workflow}</span>
                  <span className="ml-2 text-[11px] text-[var(--ink-faint)]">
                    {when(run.started_at)}
                    {run.seconds !== null
                      ? ` · ${run.seconds < 120 ? `${run.seconds}s` : `${Math.round(run.seconds / 60)}m`}`
                      : ' · never finished'}
                  </span>
                </span>
                <span
                  className="nums text-[12px]"
                  style={{
                    color: run.outcome === 'ok' ? 'var(--ink-soft)' : run.outcome === 'running' ? 'var(--ink-faint)' : 'var(--warm)',
                  }}
                >
                  {run.outcome} · {run.succeeded.toLocaleString('en-GB')} of{' '}
                  {run.checked.toLocaleString('en-GB')}
                  {run.failed > 0 ? `, ${run.failed} failed` : ''}
                </span>
              </div>
              {run.notes ? (
                <div className="mt-0.5 line-clamp-2 text-[11px] text-[var(--ink-faint)]">
                  {run.notes}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
