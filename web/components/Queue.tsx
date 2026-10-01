/**
 * The queue itself: sections of people, each with the one move that is theirs to make.
 *
 * Every row carries a single primary button. The stage ladder has seven steps and a row
 * that offers all of them is a row that gets read instead of pressed, so the page decides
 * the next move from the stage (see ADVANCE in lib/queue.ts) and offers that one, plus
 * the exit. The full ladder is available on the company page for the cases the obvious
 * move does not fit.
 *
 * All plain forms posting to server actions. No client components anywhere in the
 * console, which means no loading states, no optimistic updates to reconcile, and a page
 * that is correct the moment it renders.
 */

import { setStageAction } from '@/app/actions';
import {
  ADVANCE,
  INVITE_DAILY_TARGET,
  INVITE_LIMIT_7_DAYS,
  NO_REASONS,
  WAITING_DAYS,
  type InviteUsage,
  type QueueRow,
} from '@/lib/queue';

const BUTTON =
  'rounded-md border border-[var(--line-strong)] px-2.5 py-1 text-[12px] hover:border-[var(--accent)] hover:text-[var(--accent)]';
const SELECT =
  'rounded-md border border-[var(--line)] bg-[var(--bg)] px-1.5 py-1 text-[12px]';

/**
 * The invitation budget, which is the one hard constraint on the whole operation.
 *
 * It reads as "used of about a hundred" rather than as a percentage, because the number
 * LinkedIn counts is invitations and the number Luke needs is how many he has left today.
 * The bar turns warm at 75 and stays warm: there is no sensible reason to run at the
 * limit, since an account restriction costs more than a slow week.
 */
export function InviteMeter({ usage }: { usage: InviteUsage }) {
  const used = usage.last_7_days;
  const share = Math.min(100, Math.round((used / INVITE_LIMIT_7_DAYS) * 100));
  const tight = used >= INVITE_LIMIT_7_DAYS * 0.75;

  return (
    <div className="min-w-[220px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">
          Invitations, rolling 7 days
        </span>
        <span className="nums text-[12px]" style={{ color: tight ? 'var(--warm)' : 'var(--ink-soft)' }}>
          {used} of ~{INVITE_LIMIT_7_DAYS}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-[var(--line)]">
        <div
          className="h-1.5 rounded-full"
          style={{
            width: `${share}%`,
            background: tight ? 'var(--warm)' : 'var(--accent)',
          }}
        />
      </div>
      <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
        {usage.last_24_hours} in the last day, aiming for {INVITE_DAILY_TARGET}
      </div>
    </div>
  );
}

function waited(row: QueueRow): string {
  const limit = WAITING_DAYS[row.stage as keyof typeof WAITING_DAYS];
  const days =
    row.days_in_stage === 0
      ? 'today'
      : row.days_in_stage === 1
        ? '1 day'
        : `${row.days_in_stage} days`;
  if (limit === undefined) return `${row.stage_label}, ${days}`;
  return `${row.stage_label}, ${days}${row.days_in_stage >= limit ? ', wants a nudge' : ''}`;
}

function Row({ row, back }: { row: QueueRow; back: string }) {
  const advance = ADVANCE[row.next_action];
  const chase = row.next_action === 'waiting';

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-t border-[var(--line)] py-2.5 first:border-t-0">
      <div className="min-w-[240px] flex-1">
        <a
          href={row.linkedin_url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[13px] font-medium hover:text-[var(--accent)] hover:underline"
        >
          {row.full_name}
        </a>
        {row.is_connection ? (
          <span className="ml-2 text-[11px] text-[var(--good)]" title="Already connected, so no invitation needed">
            connected
          </span>
        ) : null}
        <div className="mt-0.5 text-[12px] text-[var(--ink-soft)]">
          {row.job_title ?? 'No title'}
        </div>
        <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">
          <a
            href={`/company/${row.company_id}?from=${encodeURIComponent('/')}`}
            className="hover:text-[var(--accent)] hover:underline"
          >
            {row.company_label}
          </a>
          {' · '}
          <span className="nums">{row.open_roles}</span> open
          {row.stale_roles_120 > 0 ? (
            <>
              {', '}
              <span className="nums">{row.stale_roles_120}</span> stalling
            </>
          ) : null}
          {row.top_country ? ` · ${row.top_locality ?? row.top_country}` : ''}
          {' · '}
          {waited(row)}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {advance ? (
          <form action={setStageAction}>
            <input type="hidden" name="contact_id" value={row.contact_id} />
            <input type="hidden" name="stage" value={advance.stage} />
            <input type="hidden" name="said" value={`${row.full_name}: ${advance.label.toLowerCase()}`} />
            <input type="hidden" name="back" value={back} />
            <button type="submit" className={BUTTON} title={advance.hint}>
              {advance.label}
            </button>
          </form>
        ) : null}

        {chase ? (
          <form action={setStageAction}>
            <input type="hidden" name="contact_id" value={row.contact_id} />
            <input type="hidden" name="stage" value={row.stage} />
            <input type="hidden" name="said" value={`${row.full_name}: chased today`} />
            <input type="hidden" name="back" value={back} />
            <button
              type="submit"
              className={BUTTON}
              title="Restamps the clock on this stage. Use it when you have nudged them."
            >
              Chased
            </button>
          </form>
        ) : null}

        <form action={setStageAction} className="flex items-center gap-1">
          <input type="hidden" name="contact_id" value={row.contact_id} />
          <input type="hidden" name="stage" value="no" />
          <input type="hidden" name="said" value={`${row.full_name}: closed`} />
          <input type="hidden" name="back" value={back} />
          <select name="reason" className={SELECT} defaultValue="no_response" aria-label="Why">
            {NO_REASONS.map((reason) => (
              <option key={reason.value} value={reason.value}>
                {reason.label}
              </option>
            ))}
          </select>
          <button type="submit" className={BUTTON} style={{ color: 'var(--ink-soft)' }}>
            Close
          </button>
        </form>
      </div>
    </li>
  );
}

export function Section({
  title,
  note,
  rows,
  back,
  tone,
}: {
  title: string;
  note: string;
  rows: QueueRow[];
  back: string;
  tone?: 'warm';
}) {
  if (!rows.length) return null;
  return (
    <section className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
        <h2
          className="text-[13px] font-semibold tracking-tight"
          style={tone === 'warm' ? { color: 'var(--warm)' } : undefined}
        >
          {title} <span className="nums font-normal text-[var(--ink-faint)]">{rows.length}</span>
        </h2>
        <span className="text-[11px] text-[var(--ink-faint)]">{note}</span>
      </div>
      <ul>
        {rows.map((row) => (
          <Row key={row.contact_id} row={row} back={back} />
        ))}
      </ul>
    </section>
  );
}
