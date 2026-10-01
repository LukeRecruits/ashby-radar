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
 *
 * Three further faults showed up once the first full pass had run, all of which split or
 * polluted the city filter the console is built on:
 *
 *   - The same city under two names. "New York City" on 425 companies and "New York" on
 *     485 are one market, and a filter that shows either half is wrong both times. Same
 *     for Bangalore/Bengaluru, München/Munich, Zürich/Zurich, Sao Paulo/São Paulo and
 *     four spellings of Washington DC.
 *   - A country in the city field. "United States" was the fifth most common locality,
 *     on 170 companies. It is not a city and it tells you nothing the country does not.
 *   - A continent in the city field. "Europe" and "Latin America" are not places you can
 *     filter a prospect list by.
 *
 * The country case has a real exception. Singapore, Hong Kong, Luxembourg, Gibraltar and
 * Monaco are city-states, where the city genuinely is the country, and dropping those
 * would lose 74 companies in Singapore alone. They are allowlisted.
 */

const COUNTRY_ALIASES = new Map<string, string>([
  ['usa', 'United States'],
  ['us', 'United States'],
  ['u.s.', 'United States'],
  ['u.s', 'United States'],
  ['u.s.a.', 'United States'],
  ['u.s.a', 'United States'],
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
  ["people's republic of china", 'China'],
  ['prc', 'China'],
  ['france, metropolitan', 'France'],
  ['korea, republic of', 'South Korea'],
  ['russian federation', 'Russia'],
  ['viet nam', 'Vietnam'],
  ['czech republic', 'Czechia'],
  ['swaziland', 'Eswatini'],
]);

/**
 * One city, one spelling. Keys are lowercased; values are the spelling we keep.
 *
 * Only pairs actually present in the data, plus the obvious diacritic and
 * native-language forms that will arrive as the board list grows. Deliberately absent:
 * boroughs and suburbs. Brooklyn is not folded into New York, and South San Francisco is
 * not folded into San Francisco, because those are answers in their own right and
 * merging them would lose information rather than recover it.
 */
const LOCALITY_ALIASES = new Map<string, string>([
  ['new york city', 'New York'],
  ['nyc', 'New York'],
  ['new york, ny', 'New York'],
  ['manhattan', 'New York'],
  ['washington dc', 'Washington'],
  ['washington d.c', 'Washington'],
  ['washington d.c.', 'Washington'],
  ['washington, dc', 'Washington'],
  ['washington, d.c', 'Washington'],
  ['washington, d.c.', 'Washington'],
  // A metro area, not a city. Everyone writing it means the city at its centre.
  ['san francisco bay area', 'San Francisco'],
  ['sf', 'San Francisco'],
  ['saint louis', 'St. Louis'],
  ['st louis', 'St. Louis'],
  ['bangalore', 'Bengaluru'],
  ['bombay', 'Mumbai'],
  ['calcutta', 'Kolkata'],
  ['madras', 'Chennai'],
  ['gurgaon', 'Gurugram'],
  ['bogota', 'Bogotá'],
  ['sao paulo', 'São Paulo'],
  ['ciudad de méxico', 'Mexico City'],
  ['ciudad de mexico', 'Mexico City'],
  ['cdmx', 'Mexico City'],
  ['münchen', 'Munich'],
  ['muenchen', 'Munich'],
  ['köln', 'Cologne'],
  ['koeln', 'Cologne'],
  ['zürich', 'Zurich'],
  ['zuerich', 'Zurich'],
  ['genève', 'Geneva'],
  ['geneve', 'Geneva'],
  ['wien', 'Vienna'],
  ['praha', 'Prague'],
  ['warszawa', 'Warsaw'],
  ['lisboa', 'Lisbon'],
  ['milano', 'Milan'],
  ['roma', 'Rome'],
  ['torino', 'Turin'],
  ['napoli', 'Naples'],
  ['firenze', 'Florence'],
  ['bruxelles', 'Brussels'],
  ['brussel', 'Brussels'],
  ['den haag', 'The Hague'],
  ["'s-gravenhage", 'The Hague'],
  ['københavn', 'Copenhagen'],
  ['kobenhavn', 'Copenhagen'],
  ['göteborg', 'Gothenburg'],
  ['goteborg', 'Gothenburg'],
  ['kiev', 'Kyiv'],
  ['moskva', 'Moscow'],
  ['tel aviv-yafo', 'Tel Aviv'],
  ['tel-aviv', 'Tel Aviv'],
  ['peking', 'Beijing'],
  ['bengaluru, karnataka', 'Bengaluru'],
]);

/**
 * Continents, trading blocs and sales regions. Real values in the data, and none of them
 * is somewhere you can filter a prospect list by.
 */
const NON_CITY_LOCALITIES = new Set([
  'europe', 'eu', 'european union', 'emea', 'apac', 'latam', 'latin america',
  'north america', 'south america', 'americas', 'asia', 'asia pacific', 'africa',
  'middle east', 'oceania', 'caribbean', 'nordics', 'benelux', 'dach', 'anz',
  'international', 'united states and canada',
]);

/**
 * Countries where the city genuinely is the country, so locality equal to country is
 * correct rather than a leak. Without this, Singapore loses 74 companies and Hong Kong
 * loses 11, for the sake of tidying a field that was already right.
 */
const CITY_STATES = new Set([
  'singapore', 'hong kong', 'macau', 'macao', 'monaco', 'gibraltar', 'luxembourg',
  'vatican city', 'san marino', 'liechtenstein', 'andorra', 'malta', 'bahrain', 'brunei',
]);

/**
 * Country names that turn up in the locality field when no country is given alongside,
 * so the equal-to-country check has nothing to compare against. Drawn from the canonical
 * values above plus the ones actually seen in the data. Not a world list, and it does not
 * need to be: anything missed is a country name left in a city field on a handful of
 * companies, which the console shows plainly enough to be caught by eye.
 */
const COUNTRY_LIKE = new Set([
  ...[...COUNTRY_ALIASES.values()].map((name) => name.toLowerCase()),
  'india', 'australia', 'israel', 'poland', 'brazil', 'colombia', 'argentina', 'ukraine',
  'china', 'indonesia', 'ireland', 'italy', 'kenya', 'portugal', 'taiwan', 'ghana',
  'latvia', 'japan', 'singapore', 'philippines', 'mexico', 'canada', 'germany', 'france',
  'spain', 'switzerland', 'netherlands', 'new zealand', 'south africa', 'nigeria',
  'sweden', 'norway', 'denmark', 'finland', 'austria', 'belgium', 'greece', 'turkey',
  'romania', 'bulgaria', 'serbia', 'croatia', 'hungary', 'czechia', 'czech republic',
  'slovakia', 'slovenia', 'estonia', 'lithuania', 'vietnam', 'thailand', 'malaysia',
  'south korea', 'korea', 'pakistan', 'bangladesh', 'egypt', 'morocco', 'chile', 'peru',
  'uruguay', 'costa rica', 'panama', 'ecuador', 'united arab emirates', 'saudi arabia',
  'qatar', 'kuwait', 'jordan', 'lebanon', 'armenia', 'georgia', 'cyprus', 'iceland',
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
  const trimmed = value
    .replace(/[\s ]+/g, ' ')
    // A trailing qualifier in brackets is never part of the name. "Europe (CET +/- 1h)"
    // is Europe, which the lists below then reject as a continent rather than a country.
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .replace(/^[,;.\-–—]+|[,;.\-–—]+$/g, '')
    .trim();
  if (!trimmed || trimmed.length > 120) return null;
  if (NOT_A_PLACE.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/**
 * Values that arrive in the country field and name no country: continents, sales
 * regions, and the handful of companies that type their remote policy into it. Dropping
 * them leaves the company with no country, which is honest, rather than offering
 * "Remote - Global" as a choice in a country filter.
 */
const NON_COUNTRY = new Set([
  ...NON_CITY_LOCALITIES,
  'any location', 'remote', 'remote - global', 'global', 'worldwide', 'anywhere',
  'multiple', 'various', 'distributed',
]);

export function normaliseCountry(value: string | null | undefined): string | null {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const alias = COUNTRY_ALIASES.get(cleaned.toLowerCase());
  if (alias) return alias;
  if (NON_COUNTRY.has(cleaned.toLowerCase())) return null;
  // Leave the company's own spelling alone otherwise. An unknown country name is far
  // more likely to be a country we have no alias for than a mistake.
  return cleaned;
}

/**
 * A city name we are prepared to put in a filter.
 *
 * Returns null rather than a bad answer in three cases: a continent, a country with no
 * city-state claim, and anything `clean` already rejected. A null locality still leaves
 * the company filterable by country, so refusing costs far less than a wrong city.
 */
export function normaliseLocality(value: string | null | undefined): string | null {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const key = cleaned.toLowerCase();

  const alias = LOCALITY_ALIASES.get(key);
  if (alias) return alias;

  if (NON_CITY_LOCALITIES.has(key)) return null;
  // A country in the city field, with no country alongside to compare it against.
  // City-states are the legitimate exception and keep their name.
  if (COUNTRY_LIKE.has(key) && !CITY_STATES.has(key)) return null;

  return cleaned;
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
  const country = normaliseCountry(postal?.addressCountry);
  let locality = normaliseLocality(postal?.addressLocality);

  // The country leaking into the city field, caught by comparison rather than by the
  // country list, which is the reliable way round. Singapore and the other city-states
  // keep both, because there the two fields agreeing is the truth.
  if (locality && country && locality.toLowerCase() === country.toLowerCase()) {
    if (!CITY_STATES.has(locality.toLowerCase())) locality = null;
  }

  return { country, region: normaliseRegion(postal?.addressRegion), locality };
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
 *
 * `remoteShare` reads `workplaceType`, not `isRemote`. Ashby sets `isRemote` true for
 * Hybrid as well as Remote: across 64,827 open roles, 35,102 have `isRemote` true while
 * only 18,448 are Remote and 16,678 are Hybrid. Deriving the share from `isRemote` made a
 * company posting nothing but hybrid roles read as 100% remote, which is the opposite of
 * what it is. Migration 0011 recomputed the history on this definition.
 *
 * The denominator is the roles that state a workplace type rather than all of them, and a
 * company whose roles all stay silent gets null instead of 0%. 8,667 open roles say
 * nothing about workplace at all, and reading silence as "not remote" is the same mistake
 * pointing the other way.
 */
export function companyLocation(
  jobs: {
    address: NormalisedAddress;
    isRemote: boolean | null;
    workplaceType: string | null;
  }[],
): { country: string | null; locality: string | null; remoteShare: number | null } {
  if (!jobs.length) return { country: null, locality: null, remoteShare: null };
  const stated = jobs.filter((job) => job.workplaceType).length;
  const remote = jobs.filter((job) => job.workplaceType === 'Remote').length;
  const remoteShare = stated === 0 ? null : Math.round((remote / stated) * 100);

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
