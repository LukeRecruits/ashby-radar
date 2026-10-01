/**
 * The funnel as a strip of numbers, not a chart.
 *
 * Seven stages with single-digit counts in them do not need a shape drawn round them;
 * they need to be readable in one glance from across the desk. The live stages run left
 * to right in ladder order, with the two terminals set apart after them, because Customer
 * and No are outcomes rather than places anybody is sitting.
 *
 * Zero is printed rather than hidden. Where people stop is the question a funnel answers,
 * and an empty stage is the answer.
 */

import type { FunnelRow } from '@/lib/queue';

export function Funnel({ rows }: { rows: FunnelRow[] }) {
  const live = rows.filter((r) => !r.is_terminal);
  const terminal = rows.filter((r) => r.is_terminal);
  const inPlay = live.reduce((sum, r) => sum + r.contacts, 0);

  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      {live.map((row) => (
        <div key={row.stage}>
          <div className="nums text-lg font-semibold leading-tight">{row.contacts}</div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">
            {row.label}
          </div>
        </div>
      ))}

      <div className="ml-2 border-l border-[var(--line)] pl-6 flex flex-wrap items-end gap-x-6 gap-y-3">
        {terminal.map((row) => (
          <div key={row.stage}>
            <div
              className="nums text-lg font-semibold leading-tight"
              style={{ color: row.stage === 'customer' ? 'var(--good)' : 'var(--ink-soft)' }}
            >
              {row.contacts}
            </div>
            <div className="text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">
              {row.label}
            </div>
          </div>
        ))}
        <div>
          <div className="nums text-lg font-semibold leading-tight text-[var(--ink-soft)]">
            {inPlay}
          </div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">
            In play
          </div>
        </div>
      </div>
    </div>
  );
}
