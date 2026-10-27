/**
 * The shape every ATS client hands the refresh.
 *
 * Radar started as Ashby only. Greenhouse is the second source, and the refresh, the
 * snapshots and the six trigger rules are all source-agnostic: they need a list of open
 * jobs with a title, a publish date, a place and a workplace type, and they do not care
 * which ATS produced it. Each client's job is to turn its own API into this shape, and
 * every source-specific oddity stays inside that client.
 */

import type { DomainCandidate } from '../enrich/domainGuess.ts';
import type { NormalisedAddress } from '../enrich/location.ts';

/** The value in companies.source and jobs.source. Unique keys are (source, x). */
export type Source = 'ashby' | 'greenhouse';

export const SOURCES: readonly Source[] = ['ashby', 'greenhouse'];

export function isSource(value: string | undefined): value is Source {
  return (SOURCES as readonly string[]).includes(value ?? '');
}

export type BoardJob = {
  /**
   * The ATS's own job id, as text. Ashby's is a UUID, Greenhouse's an integer. Jobs are
   * keyed on (source, externalJobId), never on the URL: see migration 0004 for why a
   * URL is not a stable identity.
   */
  externalJobId: string;
  /** The public posting URL. Stored in jobs.ashby_job_url, which is every source's URL. */
  jobUrl: string;
  title: string | null;
  department: string | null;
  team: string | null;
  /** The ATS's own location string, verbatim. */
  location: string | null;
  isRemote: boolean | null;
  /**
   * 'Remote', 'Hybrid' or 'OnSite', or null when the posting does not say. Ashby states
   * it; Greenhouse has no such field and its client infers it from the location text.
   * remote_share is computed from this alone, so null must mean "not stated", never
   * "not remote".
   */
  workplaceType: string | null;
  employmentType: string | null;
  isListed: boolean | null;
  /** When the role was first published, ISO. Drives long_open. */
  publishedAt: string | null;
  hasCompensation: boolean;
  /** Structured address, normalised with the helpers in enrich/location.ts. */
  address: NormalisedAddress;
};

export type BoardResult =
  | {
      found: true;
      jobs: BoardJob[];
      /**
       * Company domains linked from the board, most-linked first. Descriptions are read
       * and thrown away: only hostnames are kept, so "no job descriptions stored" holds.
       */
      domainCandidates: DomainCandidate[];
      /**
       * The company's own name, when the ATS supplies one. Ashby never does; Greenhouse
       * does. Written to display_name only when display_name is empty.
       */
      companyName: string | null;
    }
  | { found: false };
