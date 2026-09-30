/**
 * One line of evidence per trigger, for the Slack digest and the Clay row.
 *
 * The standard the build pack sets is that Luke can check a trigger in under ten
 * seconds. That means the line has to carry the numbers that made it fire, not just
 * the fact that it did, and the board link has to be one click away.
 */

import type { TriggerType } from './rules.ts';

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

type EvidenceJob = { title?: unknown; url?: unknown; ageDays?: unknown };

function jobs(value: unknown): EvidenceJob[] {
  return Array.isArray(value) ? (value as EvidenceJob[]) : [];
}

function roles(count: number | null): string {
  if (count === null) return 'roles';
  return count === 1 ? '1 role' : `${count} roles`;
}

export function summarise(type: TriggerType, evidence: Record<string, unknown>): string {
  const open = num(evidence.openRoles);

  switch (type) {
    case 'new_to_ashby': {
      const via = str(evidence.discoveredVia);
      return `First check: ${roles(open)} open${via ? `, found via ${via}` : ''}`;
    }

    case 'hiring_spike': {
      const before = num(evidence.baselineOpenRoles);
      const increase = num(evidence.increase);
      const since = str(evidence.baselineDate);
      const newest = jobs(evidence.newJobs)[0];
      const title = str(newest?.title);
      return [
        `${before ?? '?'} to ${open ?? '?'} roles (+${increase ?? '?'}) since ${since ?? 'the baseline'}`,
        title ? `latest: ${title}` : null,
      ]
        .filter(Boolean)
        .join(', ');
    }

    case 'first_recruiter': {
      const first = jobs(evidence.jobs)[0];
      const title = str(first?.title) ?? 'a recruiting role';
      const count = num(evidence.recruiterRoles);
      return `${title} open${count && count > 1 ? ` (${count} recruiting roles)` : ''}, none seen before`;
    }

    case 'sweet_spot': {
      const before = num(evidence.baselineOpenRoles);
      const band = str(evidence.band);
      return `${before ?? '?'} to ${open ?? '?'} roles, now inside the ${band ?? 'target'} band`;
    }

    case 'long_open': {
      const stale = num(evidence.staleRoles);
      const oldest = num(evidence.oldestDays);
      const minAge = num(evidence.minAgeDays);
      return `${stale ?? '?'} of ${open ?? '?'} roles open ${minAge ?? 60}+ days, oldest ${oldest ?? '?'} days`;
    }

    case 'publishes_comp': {
      const comp = num(evidence.compRoles);
      const first = jobs(evidence.jobs)[0];
      const title = str(first?.title);
      return `Pay now shown on ${comp ?? '?'} of ${open ?? '?'} roles${title ? `, e.g. ${title}` : ''}`;
    }
  }
}

/** A job URL a reader can open to see the evidence for themselves, if there is one. */
export function firstEvidenceUrl(evidence: Record<string, unknown>): string | null {
  const candidates = [...jobs(evidence.jobs), ...jobs(evidence.newJobs)];
  for (const job of candidates) {
    const url = str(job.url);
    if (url) return url;
  }
  return null;
}
