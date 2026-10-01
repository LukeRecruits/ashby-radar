/**
 * Open roles over time, as a sparkline.
 *
 * One series, so there is no legend: the heading names it. Inline SVG rather than a chart
 * library, because a library would be the console's first client-side dependency for a
 * line with at most 120 points on it, and the whole app is server components.
 *
 * The y axis spans the series rather than starting at zero, which is right for a trend
 * and wrong for a bar, and both end values are printed so the span is never implied. The
 * per-point tooltip is a plain SVG <title>, which the browser renders on hover with no
 * JavaScript at all.
 *
 * Today this draws two points for every company, because the snapshot history started on
 * 2026-09-30. It says so rather than drawing a confident line through two dots.
 */

import type { Day } from '@/lib/company';

const W = 640;
const H = 132;
const PAD = { top: 14, right: 16, bottom: 20, left: 16 };

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function Trend({ history }: { history: Day[] }) {
  if (!history.length) {
    return (
      <p className="text-[13px] text-[var(--ink-soft)]">
        No snapshots yet. The daily refresh writes one per company per morning.
      </p>
    );
  }

  const first = history[0];
  const last = history[history.length - 1];

  if (history.length === 1) {
    return (
      <p className="text-[13px] text-[var(--ink-soft)]">
        One snapshot so far, <span className="nums">{last.open_role_count}</span> open
        roles on {shortDate(last.snapshot_date)}. A trend needs a second morning.
      </p>
    );
  }

  const values = history.map((d) => d.open_role_count);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series would divide by zero and, drawn against its own min and max, would also
  // be a line of dramatic noise. Flat gets drawn flat, down the middle.
  const span = max - min || 1;
  const flat = max === min;

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const x = (i: number) =>
    PAD.left + (history.length === 1 ? innerW / 2 : (i / (history.length - 1)) * innerW);
  const y = (value: number) =>
    flat ? PAD.top + innerH / 2 : PAD.top + innerH - ((value - min) / span) * innerH;

  const points = history.map((d, i) => ({ d, cx: x(i), cy: y(d.open_role_count) }));
  const line = points.map((p) => `${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(' ');
  const baseline = (H - PAD.bottom).toFixed(1);
  const area = [
    `M ${points[0].cx.toFixed(1)},${baseline}`,
    ...points.map((p) => `L ${p.cx.toFixed(1)},${p.cy.toFixed(1)}`),
    `L ${points[points.length - 1].cx.toFixed(1)},${baseline}`,
    'Z',
  ].join(' ');

  // Markers only while they are still individually hittable. Past that the line is the
  // thing being read and a dot every four pixels is texture, not information.
  const showDots = history.length <= 45;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Open roles from ${shortDate(first.snapshot_date)} to ${shortDate(
          last.snapshot_date,
        )}, ${first.open_role_count} to ${last.open_role_count}`}
        className="block h-auto w-full overflow-visible"
      >
        {/* A single recessive baseline. No grid: the end labels carry the scale. */}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          stroke="var(--line)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />

        <path d={area} fill="var(--accent)" opacity={0.1} />
        <polyline
          points={line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        {points.map((p) => (
          <g key={p.d.snapshot_date}>
            {showDots ? (
              <circle
                cx={p.cx}
                cy={p.cy}
                r={3}
                fill="var(--panel)"
                stroke="var(--accent)"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            {/* The hit target, deliberately bigger than the mark and invisible. */}
            <circle cx={p.cx} cy={p.cy} r={9} fill="transparent">
              <title>
                {shortDate(p.d.snapshot_date)}: {p.d.open_role_count} open,{' '}
                {p.d.recruiter_role_count} recruiting, {p.d.comp_published_count} with pay
              </title>
            </circle>
          </g>
        ))}

        {/* Direct labels on the two ends only, never a number on every point. */}
        <text
          x={PAD.left}
          y={H - 6}
          fill="var(--ink-faint)"
          fontSize={11}
          className="nums"
        >
          {shortDate(first.snapshot_date)}
        </text>
        <text
          x={W - PAD.right}
          y={H - 6}
          textAnchor="end"
          fill="var(--ink-faint)"
          fontSize={11}
          className="nums"
        >
          {shortDate(last.snapshot_date)}
        </text>
        <text
          x={points[points.length - 1].cx}
          y={Math.max(points[points.length - 1].cy - 10, 11)}
          textAnchor="end"
          fill="var(--ink)"
          fontSize={12}
          fontWeight={600}
          className="nums"
        >
          {last.open_role_count}
        </text>
      </svg>

      <figcaption className="mt-1 text-[11px] text-[var(--ink-faint)]">
        {flat ? (
          <>
            Flat at <span className="nums">{last.open_role_count}</span> across{' '}
            <span className="nums">{history.length}</span>{' '}
            {history.length === 1 ? 'snapshot' : 'snapshots'}.
          </>
        ) : (
          <>
            <span className="nums">{min}</span> to <span className="nums">{max}</span> open
            roles across <span className="nums">{history.length}</span> snapshots.
          </>
        )}
        {history.length < 30 ? ' History is still filling; 30-day comparisons start once it is a month deep.' : ''}
      </figcaption>
    </figure>
  );
}
