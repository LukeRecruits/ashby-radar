/**
 * Normalising the structured address Ashby returns on every job.
 *
 * The posting API carries `address.postalAddress` with addressLocality, addressRegion
 * and addressCountry, plus a `secondaryLocations` array. Radar stored only the flat
 * `location` string, which meant segmenting by location would have meant parsing 4,826
 * distinct freeform strings. Over 658 sampled jobs the structured fields cover country
 * on 83%, region on 57% and locality on 60%.
 *
 * They still need cleaning. The same country arrives as "United States" and "USA", a
 * locality arrives as "Palo Alto " with a trailing space, and companies sometimes put a
 * region where a locality belongs ("California" as addressLocality). This handles the
 * first two properly. The third is left alone: guessing that "California" is not a city
 * requires a gazetteer, and a wrong guess loses real data.
 */

const COUNTRY_ALIASES = new Map<string, string>([
  ['usa', 'United States'],
  ['us', 'United States'],
  ['u.s.', 'United States'],
  ['u.s.a.', 'United States'],
  ['united states of america', 'United States'],
  ['america', 'United States'],
  ['uk', 'United Kingdom'],
  ['u.k.', 'United Kingdom'],
  ['gb', 'United Kingdom'],
  ['great britain', 'United Kingdom'],
  ['england', 'United Kingdom'],
  ['scotland', 'United Kingdom'],
  ['wales', 'United Kingdom'],
  ['northern ireland', 'United Kingdom'],
  ['uae', 'United Arab Emirates'],
  ['ca', 'Canada'],
  ['de', 'Germany'],
  ['deutschland', 'Germany'],
  ['nl', 'Netherlands'],
  ['the netherlands', 'Netherlands'],
  ['holland', 'Netherlands'],
  ['fr', 'France'],
  ['es', 'Spain'],
  ['españa', 'Spain'],
  ['it', 'Italy'],
  ['italia', 'Italy'],
  ['ch', 'Switzerland'],
  ['schweiz', 'Switzerland'],
  ['in', 'India'],
  ['sg', 'Singapore'],
  ['au', 'Australia'],
  ['nz', 'New Zealand'],
  ['jp', 'Japan'],
  ['br', 'Brazil'],
  ['brasil', 'Brazil'],
  ['pl', 'Poland'],
  ['polska', 'Poland'],
  ['pt', 'Portugal'],
  ['ie', 'Ireland'],
  ['il', 'Israel'],
  ['ph', 'Philippines'],
  ['mx', 'Mexico'],
  ['méxico', 'Mexico'],
]);

/** Strings that name no place. Ashby lets companies type anything here. */
const NOT_A_PLACE = new Set([
  'remote', 'anywhere', 'global', 'worldwide', 'n/a', 'na', 'none', 'tbd',
  'various', 'multiple', 'flexible', 'distributed', '-', '--',
]);

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  // Collapse runs of whitespace, including the non-breaking spaces that arrive pasted
  // out of documents, and strip stray punctuation from the ends.
  const trimmed = value.replace(/[\s ]+/g, ' ').trim().replace(/^[,;.\-–—]+|[,;.\-–—]+$/g, '').trim();
  if (!trimmed || trimmed.length > 120) return null;
  if (NOT_A_PLACE.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

export function normaliseCountry(value: string | null | undefined): string | null {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const alias = COUNTRY_ALIASES.get(cleaned.toLowerCase());
  if (alias) return alias;
  // Leave the company's own spelling alone otherwise. An unknown country name is far
  // more likely to be a country we have no alias for than a mistake.
  return cleaned;
}

export function normaliseLocality(value: string | null | undefined): string | null {
  return clean(value);
}

export function normaliseRegion(value: string | null | undefined): string | null {
  return clean(value);
}

type PostalAddress = {
  addressLocality?: string | null;
  addressRegion?: string | null;
  addressCountry?: string | null;
};

export type RawAddress = { postalAddress?: PostalAddress | null } | null | undefined;

export type SecondaryLocation = {
  location?: string | null;
  address?: PostalAddress | { postalAddress?: PostalAddress | null } | null;
};

export type NormalisedAddress = {
  country: string | null;
  region: string | null;
  locality: string | null;
};

function fromPostal(postal: PostalAddress | null | undefined): NormalisedAddress {
  return {
    country: normaliseCountry(postal?.addressCountry),
    region: normaliseRegion(postal?.addressRegion),
    locality: normaliseLocality(postal?.addressLocality),
  };
}

/**
 * The job's primary address. Secondary locations are deliberately not merged in: a job
 * open in four cities has one place it is anchored, and flattening them would make a
 * company look like it hires everywhere.
 */
export function normaliseAddress(address: RawAddress): NormalisedAddress {
  return fromPostal(address?.postalAddress);
}

/** Picks the most common non-null value, ties broken by first appearance. */
function mode(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Where a company actually hires, from its open roles.
 *
 * Not the same thing as a head office, and deliberately so. Synthesia is registered in
 * London and posts roles across Europe and New York; for working out who to talk to,
 * where the roles are beats where the paperwork lives.
 */
export function companyLocation(
  jobs: { address: NormalisedAddress; isRemote: boolean | null }[],
): { country: string | null; locality: string | null; remoteShare: number | null } {
  if (!jobs.length) return { country: null, locality: null, remoteShare: null };
  const remote = jobs.filter((job) => job.isRemote === true).length;
  return {
    country: mode(jobs.map((job) => job.address.country)),
    locality: mode(jobs.map((job) => job.address.locality)),
    remoteShare: Math.round((remote / jobs.length) * 100),
  };
}
