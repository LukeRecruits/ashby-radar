/**
 * The two ends of a board: the roles that have been sat there longest, and the ones posted
 * most recently.
 *
 * Twelve of each rather than all of them. The oldest twelve is the conversation ("you have
 * had a Senior Backend Engineer open since April"); the newest twelve is what the company
 * is doing right now. The 800 in between are on the Ashby board, which is one click away
 * and is the authoritative place to read them.
 */

import type { Role } from '@/lib/company';
import { WORKPLACE_LABELS } from '@/lib/company';

function Age({ days }: { days: number | null }) {
  if (days === null) return <span className="text-[var(--ink-faint)]">&ndash;</span>;
  // 120 days is the long_open threshold, so it is the line that means something here
  // rather than a round number chosen for looking tidy.
  const stale = days >= 120;
  return (
    <span
      className={stale ? 'font-medium' : undefined}
      style={stale ? { color: 'var(--warm)' } : undefined}
      title={stale ? 'Past the 120-day mark that fires the stalling signal' : undefined}
    >
      {days}d
    </span>
  );
}

function Place({ role }: { role: Role }) {
  const parts = [role.address_locality, role.address_country].filter(Boolean);
  const workplace = role.workplace_type
    ? (WORKPLACE_LABELS[role.workplace_type] ?? role.workplace_type)
    : null;

  if (!parts.length && !workplace) {
    return <span className="text-[var(--ink-faint)]">Not stated</span>;
  }
  return (
    <span>
      {parts.join(', ')}
      {parts.length && workplace ? (
        <span className="text-[var(--ink-faint)]"> · {workplace}</span>
      ) : null}
      {!parts.length && workplace ? workplace : null}
    </span>
  );
}

const TH =
  'px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--ink-faint)] whitespace-nowrap';
const TD = 'px-3 py-2 align-top';

export function RoleList({
  title,
  note,
  roles,
}: {
  title: string;
  note: string;
  roles: Role[];
}) {
  return (
    <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-3 pt-4">
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        <span className="text-[11px] text-[var(--ink-faint)]">{note}</span>
      </div>

      {roles.length ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-y border-[var(--line)]">
                <th className={TH}>Role</th>
                <th className={TH}>Where</th>
                <th className={`${TH} text-right`}>Age</th>
                <th className={`${TH} text-right`}>Pay</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr
                  key={role.ashby_job_id}
                  className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--bg)]"
                >
                  <td className={TD}>
                    <a
                      href={role.ashby_job_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-medium hover:text-[var(--accent)] hover:underline"
                    >
                      {role.title ?? 'Untitled role'}
                    </a>
                    {role.department ? (
                      <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">
                        {role.department}
                        {role.team && role.team !== role.department
                          ? ` · ${role.team}`
                          : ''}
                      </div>
                    ) : null}
                  </td>
                  <td className={`${TD} text-[var(--ink-soft)]`}>
                    <Place role={role} />
                  </td>
                  <td className={`${TD} nums text-right`}>
                    <Age days={role.age_days} />
                  </td>
                  <td className={`${TD} text-right text-[var(--ink-soft)]`}>
                    {role.has_compensation ? (
                      'Shown'
                    ) : (
                      <span className="text-[var(--ink-faint)]">&ndash;</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-4 pb-4 text-[13px] text-[var(--ink-soft)]">
          No open roles on the board today. An empty Ashby board is an ordinary state, not
          a company that has left.
        </p>
      )}
    </section>
  );
}
