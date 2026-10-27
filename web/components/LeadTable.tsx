/**
 * One row per company, dense enough to scan a screenful.
 *
 * Column choices follow how the list gets worked rather than what the view happens to
 * hold. The recruiter column reads as words rather than as a zero you have to interpret,
 * and it says what it measures: whether a recruiting role is open on their board today.
 * It used to say "In-house TA: Nobody", which claimed something it cannot see. The first
 * live contact lookup found ten talent people at a company the list called "Nobody". Stalled roles get their own column because that is
 * the signal with evidence behind it. The 30-day change is blank for now and will stay
 * blank until the snapshot history is a month deep, which is honest.
 */

import { SIGNALS, atsLabel, type Lead } from '@/lib/leads';

/**
 * The company name opens the company page rather than the job board, because the page is
 * where the decision gets made and the board is one click further on from there.
 *
 * `from` carries the whole path back, not just the query string, because there are two
 * places a company page can be opened from now and "back" has to mean the one you came
 * from. It is validated as a local path at the other end.
 */
function companyHref(id: string, backQuery: string): string {
  return `/company/${id}?from=${encodeURIComponent(`/leads${backQuery}`)}`;
}

function Chip({ label, title }: { label: string; title: string }) {
  return (
    <span
      title={title}
      className="rounded border border-[var(--line-strong)] px-1.5 py-0.5 text-[11px] whitespace-nowrap text-[var(--ink-soft)]"
    >
      {label}
    </span>
  );
}

function signalsOf(lead: Lead) {
  return SIGNALS.filter((s) => lead[`${s.type}_at` as keyof Lead] !== null);
}

function Where({ lead }: { lead: Lead }) {
  if (!lead.top_country && !lead.top_locality) {
    return <span className="text-[var(--ink-faint)]">Not stated</span>;
  }
  return (
    <span>
      {lead.top_locality ? <span>{lead.top_locality}</span> : null}
      {lead.top_locality && lead.top_country ? (
        <span className="text-[var(--ink-faint)]">, </span>
      ) : null}
      {lead.top_country ? (
        <span className={lead.top_locality ? 'text-[var(--ink-soft)]' : undefined}>
          {lead.top_country}
        </span>
      ) : null}
    </span>
  );
}

function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[var(--ink-faint)]">&ndash;</span>;
  if (value === 0) return <span className="text-[var(--ink-faint)]">0</span>;
  return (
    <span style={{ color: value > 0 ? 'var(--good)' : 'var(--ink-soft)' }}>
      {value > 0 ? `+${value}` : value}
    </span>
  );
}

const TH =
  'px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--ink-faint)] whitespace-nowrap';
const TD = 'px-3 py-2 align-top';

export function LeadTable({
  rows,
  backQuery = '',
}: {
  rows: Lead[];
  backQuery?: string;
}) {
  if (!rows.length) {
    return (
      <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-10 text-center text-[13px] text-[var(--ink-soft)]">
        Nothing matches that combination. Widen a filter, or clear them all.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--line)] bg-[var(--panel)]">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-[var(--line)]">
            <th className={TH}>Company</th>
            <th className={TH}>Hiring in</th>
            <th className={`${TH} text-right`}>Open</th>
            <th className={`${TH} text-right`}>30d</th>
            <th className={TH}>Recruiter req</th>
            <th className={`${TH} text-right`}>Pay shown</th>
            <th className={`${TH} text-right`}>Stalled</th>
            <th className={TH}>Signals</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((lead) => {
            const signals = signalsOf(lead);
            const ats = atsLabel(lead.source);
            return (
              <tr
                key={lead.id}
                className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--bg)]"
              >
                <td className={TD}>
                  <a
                    href={companyHref(lead.id, backQuery)}
                    className="font-medium text-[var(--ink)] hover:text-[var(--accent)] hover:underline"
                  >
                    {lead.label}
                  </a>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--ink-faint)]">
                    <a
                      href={lead.board_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="hover:text-[var(--accent)] hover:underline"
                      title={`The ${ats} job board`}
                    >
                      Board
                    </a>
                    {/* Quiet on purpose: which ATS is a fact about the row, not a signal. */}
                    <span title={`On ${ats}`}>{ats}</span>
                    {lead.domain ? (
                      <a
                        href={`https://${lead.domain}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="hover:text-[var(--accent)] hover:underline"
                        title={
                          lead.domain_confidence === 100
                            ? `Proved: their careers page links back to this ${ats} board`
                            : `Matched on name, confidence ${lead.domain_confidence}`
                        }
                      >
                        {lead.domain}
                      </a>
                    ) : (
                      <span className="text-[var(--warm)]">No domain yet</span>
                    )}
                    {lead.parked_at ? (
                      <span title={lead.parked_reason ?? undefined}>· Parked</span>
                    ) : null}
                  </div>
                </td>

                <td className={TD}>
                  <Where lead={lead} />
                  {lead.remote_share !== null && lead.remote_share >= 50 ? (
                    <div
                      className="mt-0.5 text-[11px] text-[var(--ink-faint)]"
                      title="Share of the roles that state a workplace type and say Remote. Hybrid is counted separately; see the company page."
                    >
                      {lead.remote_share}% remote
                    </div>
                  ) : null}
                </td>

                <td className={`${TD} nums text-right font-medium`}>{lead.open_roles}</td>
                <td className={`${TD} nums text-right`}>
                  <Change value={lead.open_roles_change_30d} />
                </td>

                <td className={TD}>
                  {lead.recruiter_roles > 0 ? (
                    <span className="text-[var(--ink-soft)]">
                      {lead.recruiter_roles} open
                    </span>
                  ) : (
                    <span className="font-medium text-[var(--warm)]">None open</span>
                  )}
                </td>

                <td className={`${TD} nums text-right text-[var(--ink-soft)]`}>
                  {lead.open_roles === 0
                    ? '–'
                    : `${Math.round((lead.roles_with_pay / lead.open_roles) * 100)}%`}
                </td>

                <td className={`${TD} nums text-right`}>
                  {lead.stale_roles_120 > 0 ? (
                    <span title="Roles open 120 days or more">{lead.stale_roles_120}</span>
                  ) : (
                    <span className="text-[var(--ink-faint)]">&ndash;</span>
                  )}
                </td>

                <td className={TD}>
                  <div className="flex flex-wrap gap-1">
                    {signals.length ? (
                      signals.map((s) => <Chip key={s.type} label={s.label} title={s.hint} />)
                    ) : (
                      <span className="text-[var(--ink-faint)]">&ndash;</span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
