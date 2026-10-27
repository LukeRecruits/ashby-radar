/**
 * A fired signal, with the evidence that made it fire.
 *
 * The lead list can only show that a signal exists. The evidence is the part that decides
 * whether it is worth acting on, and it has been stored as jsonb on every trigger row
 * since phase 3 without anything ever reading it back.
 *
 * Each rule gets its own sentence rather than a key/value dump, because the sentence is
 * the thing Luke can use: "four roles open 120+ days, the oldest 214" is an opener, and
 * `{"staleRoles": 4, "oldestDays": 214}` is a debugging aid. The generic branch at the
 * bottom exists so a rule added later still renders something useful on the day it fires
 * rather than on the day somebody remembers to come back here.
 *
 * Evidence is written by our own Postgres functions in migration 0005, so the shapes are
 * known. They are still read defensively: a trigger row written months ago by an earlier
 * version of a rule is exactly the kind of thing that returns a string where a number was
 * expected, and a company page is not worth a crash.
 */

import type { Signal } from '@/lib/company';
import { SIGNALS, type SignalType } from '@/lib/leads';

type Job = { title?: unknown; url?: unknown; ageDays?: unknown };

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function jobs(value: unknown): Job[] {
  return Array.isArray(value) ? (value as Job[]) : [];
}

function day(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const date = new Date(raw.length <= 10 ? `${raw}T00:00:00Z` : raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The sentence. Null when the evidence does not carry enough to make one honestly. */
function summarise(type: SignalType, e: Record<string, unknown>): string | null {
  const open = num(e.openRoles);

  switch (type) {
    case 'long_open': {
      const stale = num(e.staleRoles);
      const oldest = num(e.oldestDays);
      if (stale === null) return null;
      const roles = `${stale} ${stale === 1 ? 'role has' : 'roles have'} been open`;
      const since = num(e.minAgeDays) ?? 120;
      return oldest === null
        ? `${roles} ${since} days or more.`
        : `${roles} ${since} days or more. The oldest has been live for ${oldest} days.`;
    }

    case 'hiring_spike': {
      const increase = num(e.increase);
      const base = num(e.baselineOpenRoles);
      const on = day(e.baselineDate);
      if (increase === null || base === null || open === null) return null;
      return `Open roles went from ${base} to ${open}, up ${increase}${
        on ? `, against the snapshot of ${on}` : ''
      }.`;
    }

    case 'sweet_spot': {
      const base = num(e.baselineOpenRoles);
      const band = str(e.band);
      if (open === null || base === null) return null;
      return `Open roles moved from ${base} to ${open}${
        band ? `, into the ${band} band` : ''
      }.`;
    }

    case 'first_recruiter': {
      const recruiters = num(e.recruiterRoles);
      const quiet = day(e.quietSince);
      if (recruiters === null) return null;
      return `${recruiters} recruiting ${recruiters === 1 ? 'role is' : 'roles are'} open${
        quiet ? `, with none on the board since ${quiet}` : ' where there were none before'
      }.`;
    }

    case 'publishes_comp': {
      const comp = num(e.compRoles);
      if (comp === null) return null;
      return `Pay is now shown on ${comp} ${comp === 1 ? 'role' : 'roles'}${
        open ? ` of ${open}` : ''
      }, for the first time since we started watching.`;
    }

    case 'new_to_ashby': {
      const via = str(e.discoveredVia);
      const firstSeen = day(e.firstSeenAt) ?? day(e.firstSnapshot);
      if (open === null) return null;
      return `First successful check, ${open} open ${open === 1 ? 'role' : 'roles'}${
        firstSeen ? `, found ${firstSeen}` : ''
      }${via ? ` via ${via}` : ''}.`;
    }

    default:
      return null;
  }
}

function JobList({ list, label }: { list: Job[]; label: string }) {
  if (!list.length) return null;
  return (
    <div className="mt-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">
        {label}
      </div>
      <ul className="mt-1 space-y-0.5">
        {list.slice(0, 6).map((job, i) => {
          const title = str(job.title) ?? 'Untitled role';
          const url = str(job.url);
          const age = num(job.ageDays);
          return (
            <li key={`${title}:${i}`} className="text-[13px]">
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:text-[var(--accent)] hover:underline"
                >
                  {title}
                </a>
              ) : (
                title
              )}
              {age !== null ? (
                <span className="nums text-[var(--ink-faint)]"> · {age} days</span>
              ) : null}
            </li>
          );
        })}
        {list.length > 6 ? (
          <li className="nums text-[12px] text-[var(--ink-faint)]">
            and {list.length - 6} more
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** Last resort, so an unrecognised shape is still visible rather than silently dropped. */
function RawEvidence({ evidence }: { evidence: Record<string, unknown> }) {
  const pairs = Object.entries(evidence).filter(
    ([, v]) => v !== null && typeof v !== 'object',
  );
  if (!pairs.length) return null;
  return (
    <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
      {pairs.map(([key, value]) => (
        <div key={key} className="flex gap-1.5">
          <dt className="text-[var(--ink-faint)]">{key}</dt>
          <dd className="nums">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * `new_to_ashby` keeps its internal name and means "new to its ATS" for every source, so
 * its label names the company's actual ATS rather than saying "New" with no object.
 */
function labelOf(type: SignalType, fallback: string, ats: string): string {
  return type === 'new_to_ashby' ? `New to ${ats}` : fallback;
}

export function Evidence({ signals, ats }: { signals: Signal[]; ats: string }) {
  if (!signals.length) {
    return (
      <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
        <h2 className="text-[13px] font-semibold tracking-tight">Signals</h2>
        <p className="mt-2 text-[13px] text-[var(--ink-soft)]">
          Nothing has fired for this company. Four of the six rules compare today against
          our own history and stay silent until that history exists, so silence this early
          is the expected answer rather than a verdict.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
      <h2 className="mb-3 text-[13px] font-semibold tracking-tight">
        Signals
        <span className="nums ml-2 font-normal text-[var(--ink-faint)]">
          {signals.length}
        </span>
      </h2>

      <div className="space-y-3">
        {signals.map((signal) => {
          const meta = SIGNALS.find((s) => s.type === signal.type);
          const evidence = (signal.evidence ?? {}) as Record<string, unknown>;
          const sentence = summarise(signal.type, evidence);
          const fired = day(signal.fired_at);
          const newJobs = jobs(evidence.newJobs);
          const staleJobs = jobs(evidence.jobs);

          return (
            <article
              key={signal.id}
              className="rounded-md border border-[var(--line)] p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[13px] font-medium">
                  {labelOf(signal.type, meta?.label ?? signal.type, ats)}
                  <span className="ml-2 font-normal text-[var(--ink-faint)]">
                    {meta?.hint ?? signal.type}
                  </span>
                </h3>
                {fired ? (
                  <span className="nums text-[11px] text-[var(--ink-faint)]">{fired}</span>
                ) : null}
              </div>

              {sentence ? (
                <p className="mt-1.5 text-[13px] text-[var(--ink-soft)]">{sentence}</p>
              ) : (
                <RawEvidence evidence={evidence} />
              )}

              <JobList
                list={staleJobs}
                label={signal.type === 'long_open' ? 'The stalled roles' : 'The roles'}
              />
              <JobList list={newJobs} label="New since the baseline" />
            </article>
          );
        })}
      </div>
    </section>
  );
}
