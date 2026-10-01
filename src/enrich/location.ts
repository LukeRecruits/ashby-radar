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

/** Picks the most frequent key, ties broken by first appearance. */
function mode<T>(items: T[], key: (item: T) => string | null): T | null {
  const counts = new Map<string, { count: number; item: T }>();
  for (const item of items) {
    const k = key(item);
    if (!k) continue;
    const seen = counts.get(k);
    if (seen) seen.count += 1;
    else counts.set(k, { count: 1, item });
  }
  let best: { count: number; item: T } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.item ?? null;
}

/**
 * Where a company actually hires, from its open roles.
 *
 * Not the same thing as a head office, and deliberately so. Synthesia is registered in
 * London and posts roles across Europe and New York; for working out who to talk to,
 * where the roles are beats where the paperwork lives.
 *
 * Country and locality are picked as a pair, not separately. Picking the modal country
 * and the modal locality independently produced incoherent answers: Talentful came out
 * as "London, United States", because most of its roles are American and its single
 * largest city is London. The pair is always a place that exists.
 *
 * A company whose roles carry a country but no city still gets a country, so coverage
 * does not drop to whatever share of jobs name a city.
 */
export function companyLocation(
  jobs: { address: NormalisedAddress; isRemote: boolean | null }[],
): { country: string | null; locality: string | null; remoteShare: number | null } {
  if (!jobs.length) return { country: null, locality: null, remoteShare: null };
  const remote = jobs.filter((job) => job.isRemote === true).length;
  const remoteShare = Math.round((remote / jobs.length) * 100);

  const addresses = jobs.map((job) => job.address);
  const pair = mode(
    addresses.filter((a) => a.locality && a.country),
    (a) => `${a.locality}\u0000${a.country}`,
  );
  if (pair) return { country: pair.country, locality: pair.locality, remoteShare };

  // No job names both. Fall back to each on its own rather than returning nothing.
  const byLocality = mode(addresses, (a) => a.locality);
  const byCountry = mode(addresses, (a) => a.country);
  return {
    country: byCountry?.country ?? null,
    locality: byLocality?.locality ?? null,
    remoteShare,
  };
}
