/**
 * Where a company's open roles sit: by department, by city, by country, by workplace.
 *
 * A horizontal bar per group, because the labels are words of wildly different length
 * ("Engineering", "Go To Market", "Customer Experience & Support") and vertical bars would
 * either truncate them or rotate them. Length is the comparison; the count is printed
 * beside it so nothing has to be read off a bar.
 *
 * Each bar carries two segments, open roles and the stale part of them, because "nine
 * engineering roles" and "nine engineering roles, six of them open since the spring" are
 * different companies. Two segments means a legend, which sits once at the top of the
 * section, and both numbers are written out per row so identity never rests on colour.
 */

import type { Group } from '@/lib/company';

function Legend() {
  return (
    <div className="flex items-center gap-4 text-[11px] text-[var(--ink-faint)]">
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: 'var(--accent)' }}
        />
        Open
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: 'var(--warm)' }}
        />
        Open 120+ days
      </span>
    </div>
  );
}

function Bar({ group, scale }: { group: Group; scale: number }) {
  const stale = Math.min(group.stale_roles, group.roles);
  const fresh = group.roles - stale;
  const pct = (n: number) => `${(n / scale) * 100}%`;

  return (
    <div className="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-3 py-[3px]">
      <div className="truncate text-[13px]" title={group.value}>
        {group.value}
      </div>

      {/* A 2px gap between the two fills, so the boundary is read as a boundary rather
          than as a colour change inside one shape. */}
      <div className="flex h-[10px] items-center gap-[2px]" aria-hidden>
        {fresh > 0 ? (
          <span
            className="h-full rounded-sm"
            style={{ width: pct(fresh), background: 'var(--accent)' }}
          />
        ) : null}
        {stale > 0 ? (
          <span
            className="h-full rounded-sm"
            style={{ width: pct(stale), background: 'var(--warm)' }}
          />
        ) : null}
      </div>

      <div className="nums whitespace-nowrap text-[12px] text-[var(--ink-soft)]">
        <span className="font-medium text-[var(--ink)]">{group.roles}</span>
        {stale > 0 ? <span className="text-[var(--warm)]"> · {stale} stalling</span> : null}
      </div>
    </div>
  );
}

export function Breakdown({
  title,
  rows,
  total,
  empty,
  legend = true,
}: {
  title: string;
  rows: Group[];
  total: number;
  empty: string;
  legend?: boolean;
}) {
  // Bars are scaled to the biggest group rather than to the total, so a company with one
  // dominant department still shows the shape of the long tail instead of eight slivers.
  const scale = Math.max(1, ...rows.map((r) => r.roles));

  return (
    <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        {legend && rows.some((r) => r.stale_roles > 0) ? <Legend /> : null}
      </div>

      {rows.length ? (
        <>
          <div>
            {rows.map((row) => (
              <Bar key={`${row.kind}:${row.value}`} group={row} scale={scale} />
            ))}
          </div>
          <p className="mt-3 border-t border-[var(--line)] pt-2 text-[11px] text-[var(--ink-faint)]">
            <span className="nums">{total.toLocaleString('en-GB')}</span> open{' '}
            {total === 1 ? 'role' : 'roles'} in total.
          </p>
        </>
      ) : (
        <p className="text-[13px] text-[var(--ink-soft)]">{empty}</p>
      )}
    </section>
  );
}
