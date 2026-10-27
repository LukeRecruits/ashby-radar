/**
 * Reading a place out of Greenhouse's free-text location.
 *
 * Ashby sends a structured postal address on every job. Greenhouse sends one string,
 * `location.name`, typed by whoever opened the role. The same board writes "London",
 * "London, UK", "London, England" and "London, England, United Kingdom" for one office,
 * and a multi-city role arrives as "San Francisco, CA | New York City, NY". This turns
 * that string into the same {country, region, locality} the Ashby path produces, using
 * the same normalise helpers, so the console's filters cannot tell the sources apart.
 *
 * The rules, in the order they bite:
 *
 *   1. First location only. A string naming several places is split on ; | / " or " and
 *      the like, and only the first is parsed, matching the Ashby rule that a job's
 *      primary address is the one it is anchored to. Comma lists are split by shape:
 *      "San Francisco, CA, New York City, New York" ends after the state.
 *   2. Remote and hybrid words are stripped before parsing, so "Remote - US" and
 *      "United States, Remote" both yield United States.
 *   3. A two-letter code after a city is a US state or Canadian province before it is a
 *      country code, because "Chicago, IL" vastly outnumbers anyone abbreviating
 *      Israel. The known-city list breaks the tie the other way: "Tel Aviv, IL" and
 *      "Toronto, CA" match a city whose country code is the same two letters.
 *   4. A bare city with no country resolves only through the known-city list, which is
 *      limited to names that mean one place in practice. Anything else keeps a null
 *      country, and with no country the locality is dropped too: a city filter fed
 *      unverified strings fills with school names and "Multiple Locations".
 *   5. A country first is a list of countries ("Australia, Singapore, Malaysia"), unless
 *      a state follows it: "Lebanon, NH" is in New Hampshire.
 *
 * Measured over 6,372 jobs on 155 boards, 84% get a country and 70% a city. Of the 16%
 * left, more than half name no place at all ("Remote", "Hybrid", "Distributed",
 * "North America") and most of the rest are buildings and schools. Every non-US result
 * and two random samples of thirty were read back by eye; none had a wrong country.
 *
 * Precision over recall throughout. A wrong country sends a prospect to the wrong
 * filter and nobody notices; a null just leaves the company out of one.
 */

import {
  normaliseCountry,
  normaliseLocality,
  normaliseRegion,
  type NormalisedAddress,
} from '../enrich/location.ts';

const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia', PR: 'Puerto Rico',
};

const CA_PROVINCES: Record<string, string> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
  SK: 'Saskatchewan', YT: 'Yukon',
};

/**
 * Australian states by their unambiguous abbreviations only. WA and SA are left out:
 * WA is Washington far more often, and SA reads as South Africa or South America.
 */
const AU_STATES: Record<string, string> = {
  NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland', TAS: 'Tasmania',
  ACT: 'Australian Capital Territory',
};

const lowerValues = (table: Record<string, string>) =>
  new Map(Object.values(table).map((name) => [name.toLowerCase(), name]));

const US_STATE_NAMES = lowerValues(US_STATES);
const CA_PROVINCE_NAMES = new Map([
  ...lowerValues(CA_PROVINCES),
  ['québec', 'Quebec'],
]);
const AU_STATE_NAMES = new Map([
  ...lowerValues(AU_STATES),
  ['western australia', 'Western Australia'],
  ['south australia', 'South Australia'],
  ['northern territory', 'Northern Territory'],
]);

/**
 * Countries, in the spelling normaliseCountry keeps. Being on this list is what makes a
 * part of the string count as a country at all; normaliseCountry by itself passes any
 * unknown string through unchanged, which is right for Ashby's structured field and
 * wrong for free text, where the last part is as likely a city as a country.
 */
const COUNTRIES = new Map(
  [
    'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Argentina', 'Armenia',
    'Australia', 'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados',
    'Belarus', 'Belgium', 'Belize', 'Benin', 'Bermuda', 'Bhutan', 'Bolivia',
    'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria', 'Burkina Faso',
    'Cambodia', 'Cameroon', 'Canada', 'Cayman Islands', 'Chile', 'China', 'Colombia',
    'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czechia', 'Denmark', 'Dominican Republic',
    'Ecuador', 'Egypt', 'El Salvador', 'Estonia', 'Eswatini', 'Ethiopia', 'Fiji',
    'Finland', 'France', 'Georgia', 'Germany', 'Ghana', 'Gibraltar', 'Greece',
    'Guatemala', 'Guernsey', 'Honduras', 'Hong Kong', 'Hungary', 'Iceland', 'India',
    'Indonesia', 'Iraq', 'Ireland', 'Isle of Man', 'Israel', 'Italy', 'Ivory Coast',
    'Jamaica', 'Japan', 'Jersey', 'Jordan', 'Kazakhstan', 'Kenya', 'Kosovo', 'Kuwait',
    'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Liechtenstein', 'Lithuania',
    'Luxembourg', 'Macau', 'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Malta',
    'Mauritius', 'Mexico', 'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco',
    'Mozambique', 'Myanmar', 'Namibia', 'Nepal', 'Netherlands', 'New Zealand',
    'Nicaragua', 'Nigeria', 'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Panama',
    'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Puerto Rico', 'Qatar',
    'Romania', 'Russia', 'Rwanda', 'Saudi Arabia', 'Senegal', 'Serbia', 'Singapore',
    'Slovakia', 'Slovenia', 'South Africa', 'South Korea', 'Spain', 'Sri Lanka',
    'Sweden', 'Switzerland', 'Taiwan', 'Tanzania', 'Thailand', 'Trinidad and Tobago',
    'Tunisia', 'Turkey', 'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom',
    'United States', 'Uruguay', 'Uzbekistan', 'Venezuela', 'Vietnam', 'Zambia', 'Zimbabwe',
  ].map((name) => [name.toLowerCase(), name] as const),
);

/**
 * Spellings normaliseCountry does not fold that turn up in Greenhouse strings. Applied
 * before it, so the result is the same canonical name the Ashby data uses.
 */
const EXTRA_COUNTRY_ALIASES = new Map<string, string>([
  ['united states (us)', 'United States'],
  ['us of a', 'United States'],
  ['can', 'Canada'],
  ['gbr', 'United Kingdom'],
  ['aus', 'Australia'],
  ['deu', 'Germany'],
  ['fra', 'France'],
  ['ind', 'India'],
  ['bra', 'Brazil'],
  ['mex', 'Mexico'],
  ['nld', 'Netherlands'],
  ['esp', 'Spain'],
  ['irl', 'Ireland'],
  ['isr', 'Israel'],
  ['jpn', 'Japan'],
  ['sgp', 'Singapore'],
  ['korea', 'South Korea'],
  ['republic of korea', 'South Korea'],
  ['türkiye', 'Turkey'],
  ['turkiye', 'Turkey'],
  ['czech republic', 'Czechia'],
  ['the philippines', 'Philippines'],
  ["côte d'ivoire", 'Ivory Coast'],
  ['uae', 'United Arab Emirates'],
  ['ksa', 'Saudi Arabia'],
  ['österreich', 'Austria'],
  ['sverige', 'Sweden'],
  ['danmark', 'Denmark'],
  ['norge', 'Norway'],
  ['suomi', 'Finland'],
  ['belgique', 'Belgium'],
  ['suisse', 'Switzerland'],
  ['nederland', 'Netherlands'],
]);

/**
 * ISO two-letter codes, consulted only when the code is neither a US state nor a
 * Canadian province (rule 3 above). Codes that collide with a state are listed anyway,
 * because the known-city list can still claim them.
 */
const ISO2: Record<string, string> = {
  US: 'United States', GB: 'United Kingdom', UK: 'United Kingdom', CA: 'Canada',
  DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', NL: 'Netherlands',
  CH: 'Switzerland', IN: 'India', SG: 'Singapore', AU: 'Australia', NZ: 'New Zealand',
  JP: 'Japan', BR: 'Brazil', PL: 'Poland', PT: 'Portugal', IE: 'Ireland', IL: 'Israel',
  PH: 'Philippines', MX: 'Mexico', SE: 'Sweden', NO: 'Norway', DK: 'Denmark',
  FI: 'Finland', AT: 'Austria', BE: 'Belgium', CZ: 'Czechia', AR: 'Argentina',
  CO: 'Colombia', CL: 'Chile', ZA: 'South Africa', KR: 'South Korea', CN: 'China',
  HK: 'Hong Kong', TW: 'Taiwan', AE: 'United Arab Emirates', RO: 'Romania',
  GR: 'Greece', HU: 'Hungary', UA: 'Ukraine', TR: 'Turkey', EE: 'Estonia',
  LT: 'Lithuania', LV: 'Latvia', BG: 'Bulgaria', HR: 'Croatia', RS: 'Serbia',
  SK: 'Slovakia', SI: 'Slovenia', LU: 'Luxembourg', CY: 'Cyprus', MT: 'Malta',
  IS: 'Iceland', MY: 'Malaysia', TH: 'Thailand', VN: 'Vietnam', ID: 'Indonesia',
  PK: 'Pakistan', NG: 'Nigeria', KE: 'Kenya', EG: 'Egypt', SA: 'Saudi Arabia',
  PE: 'Peru', UY: 'Uruguay', CR: 'Costa Rica',
};

/**
 * Bare city names that mean one country in practice, keyed by the lowercased name as it
 * arrives or as normaliseLocality spells it. Deliberately absent: names shared by two
 * real hiring markets (Cambridge, Portland, Vancouver, Birmingham, Richmond, Kingston,
 * Hamilton, Victoria, Newcastle), where any answer is a guess.
 */
const KNOWN_CITIES = new Map<string, string>(
  Object.entries({
    'United States': [
      'new york', 'san francisco', 'los angeles', 'seattle', 'chicago', 'boston',
      'austin', 'denver', 'atlanta', 'miami', 'dallas', 'houston', 'san diego',
      'san jose', 'palo alto', 'mountain view', 'menlo park', 'sunnyvale', 'redwood city',
      'santa monica', 'oakland', 'brooklyn', 'philadelphia', 'pittsburgh', 'phoenix',
      'salt lake city', 'minneapolis', 'detroit', 'nashville', 'raleigh', 'charlotte',
      'washington dc', 'washington d.c.', 'washington, d.c.', 'st. louis', 'kansas city',
      'columbus', 'indianapolis', 'baltimore', 'tampa', 'orlando', 'las vegas', 'irvine',
      'boulder', 'san mateo', 'south san francisco', 'new york city', 'nyc', 'sf',
      'san francisco bay area', 'bay area', 'silicon valley', 'cupertino', 'santa clara',
      'scottsdale', 'cincinnati', 'cleveland', 'milwaukee', 'sacramento', 'honolulu',
      'anchorage', 'jersey city', 'hoboken', 'durham', 'ann arbor', 'boise', 'omaha',
      'new orleans', 'lehi', 'provo',
    ],
    Canada: [
      'toronto', 'montreal', 'montréal', 'ottawa', 'calgary', 'edmonton', 'waterloo',
      'winnipeg', 'halifax', 'quebec city', 'mississauga', 'kitchener',
    ],
    'United Kingdom': [
      'london', 'manchester', 'edinburgh', 'glasgow', 'bristol', 'leeds', 'belfast',
      'cardiff', 'liverpool', 'oxford', 'brighton', 'sheffield', 'nottingham', 'reading',
    ],
    Ireland: ['dublin', 'cork', 'galway', 'limerick'],
    France: ['paris', 'lyon', 'marseille', 'toulouse', 'bordeaux', 'lille', 'nantes'],
    Germany: [
      'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'köln',
      'düsseldorf', 'dusseldorf', 'stuttgart', 'leipzig',
    ],
    Netherlands: ['amsterdam', 'rotterdam', 'utrecht', 'eindhoven', 'the hague'],
    Spain: ['madrid', 'barcelona', 'valencia', 'seville', 'sevilla', 'malaga', 'málaga'],
    Portugal: ['lisbon', 'lisboa', 'porto'],
    Italy: ['milan', 'milano', 'rome', 'roma', 'turin', 'torino'],
    Switzerland: ['zurich', 'zürich', 'geneva', 'genève', 'basel', 'lausanne', 'zug'],
    Austria: ['vienna', 'wien'],
    Belgium: ['brussels', 'antwerp', 'ghent'],
    Denmark: ['copenhagen', 'københavn', 'aarhus'],
    Sweden: ['stockholm', 'gothenburg', 'göteborg', 'malmö', 'malmo'],
    Norway: ['oslo', 'bergen'],
    Finland: ['helsinki', 'espoo'],
    Poland: ['warsaw', 'warszawa', 'krakow', 'kraków', 'wroclaw', 'wrocław', 'gdansk', 'poznan'],
    Czechia: ['prague', 'praha', 'brno'],
    Hungary: ['budapest'],
    Romania: ['bucharest', 'cluj-napoca'],
    Greece: ['athens'],
    Estonia: ['tallinn'],
    Lithuania: ['vilnius'],
    Latvia: ['riga'],
    Ukraine: ['kyiv', 'kiev', 'lviv', 'kharkiv'],
    Serbia: ['belgrade'],
    Georgia: ['tbilisi'],
    Bulgaria: ['sofia'],
    Croatia: ['zagreb'],
    Turkey: ['istanbul', 'ankara'],
    Israel: ['tel aviv', 'tel aviv-yafo', 'jerusalem', 'haifa', 'herzliya'],
    'United Arab Emirates': ['dubai', 'abu dhabi'],
    'Saudi Arabia': ['riyadh', 'jeddah'],
    Qatar: ['doha'],
    Egypt: ['cairo'],
    Nigeria: ['lagos', 'abuja'],
    Kenya: ['nairobi'],
    'South Africa': ['johannesburg', 'cape town', 'pretoria', 'durban'],
    India: [
      'bengaluru', 'bangalore', 'mumbai', 'bombay', 'hyderabad', 'chennai', 'pune',
      'gurugram', 'gurgaon', 'noida', 'new delhi', 'delhi', 'kolkata', 'ahmedabad',
    ],
    Pakistan: ['karachi', 'lahore', 'islamabad'],
    Singapore: ['singapore'],
    'Hong Kong': ['hong kong'],
    Japan: ['tokyo', 'osaka', 'kyoto'],
    'South Korea': ['seoul'],
    China: ['beijing', 'shanghai', 'shenzhen', 'guangzhou', 'hangzhou'],
    Taiwan: ['taipei'],
    Philippines: ['manila', 'makati', 'taguig', 'cebu'],
    Vietnam: ['ho chi minh city', 'hanoi'],
    Thailand: ['bangkok'],
    Malaysia: ['kuala lumpur'],
    Indonesia: ['jakarta'],
    Australia: ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra'],
    'New Zealand': ['auckland', 'wellington', 'christchurch'],
    Mexico: ['mexico city', 'ciudad de méxico', 'cdmx', 'guadalajara', 'monterrey'],
    Brazil: ['são paulo', 'sao paulo', 'rio de janeiro', 'belo horizonte', 'florianópolis', 'curitiba'],
    Argentina: ['buenos aires'],
    Colombia: ['bogotá', 'bogota', 'bogota d.c.', 'bogotá d.c.', 'medellín', 'medellin'],
    Chile: ['santiago'],
    Peru: ['lima'],
    Uruguay: ['montevideo'],
    'Costa Rica': ['san josé, costa rica'],
    Luxembourg: ['luxembourg city'],
  }).flatMap(([country, cities]) => cities.map((city) => [city, country] as const)),
);

function knownCityCountry(raw: string, locality: string | null): string | null {
  return KNOWN_CITIES.get(raw.toLowerCase()) ?? (locality ? KNOWN_CITIES.get(locality.toLowerCase()) : null) ?? null;
}

// Workplace words, matched as whole words so "Hybridge Ltd" is not hybrid.
// "Virtual" counts only as the whole place, because "Virtual Prep Academy of Missouri"
// is a school with a building, and a remote word inside a name is not a policy.
const REMOTE_WORDS = /\b(?:fully[\s-])?(?:remote(?:[\s-]?(?:first|friendly|eligible|based|ok|optional|only))?|work[\s-]from[\s-]home|wfh|anywhere|home[\s-]based|telecommute|distributed)\b|^\s*virtual\s*(?=$|[-,(])/i;
const HYBRID_WORDS = /\bhybrid\b/i;
const ONSITE_WORDS = /\b(?:on[\s-]?site|in[\s-]office|office[\s-]based|in[\s-]person)\b/i;

/**
 * Splits a multi-location string into its places: on ; | newlines, " or ", " & ",
 * " and ", " + ", and a slash with spaces round it. Commas are not split here, because
 * a comma joins a city to its region far more often than it joins two places.
 *
 * One exception to the slash: "Goiania / GO / Brazil" and "Mexico City / CDMX / Mexico"
 * use it the way everyone else uses a comma, which shows as a country in the last
 * piece. Those are rejoined with commas into a single place.
 */
function segments(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.split(/\s*(?:;|\||\n|\s+or\s+|\s+&\s+|\s+and\s+|\s+\+\s+)\s*/i)) {
    const slashed = piece.split(/\s+\/\s+/);
    if (slashed.length > 1 && slashed.length <= 3 && countryOf(slashed[slashed.length - 1]!)) {
      out.push(slashed.join(', '));
    } else {
      out.push(...slashed);
    }
  }
  return out.map((part) => part.trim()).filter(Boolean);
}

/**
 * Reads a custom field's value as a workplace statement. Booleans and yes/no only count
 * on a field that is plainly about being remote, and only in the positive: "Remote job:
 * false" says the role is not remote, which could still be hybrid, so it stays null. A
 * field like "Open to Remote" is the City-or-Remote choice again and is ignored.
 */
export function workplaceFromField(name: string, value: unknown): 'Remote' | 'Hybrid' | 'OnSite' | null {
  const field = name.trim();
  if (/remote/i.test(field)) {
    if (/open to|eligib|friendly|option|possible|allowed/i.test(field)) return null;
    if (value === true || (typeof value === 'string' && /^(yes|true|y)$/i.test(value.trim()))) {
      return 'Remote';
    }
    if (typeof value === 'string' && !/^(yes|no|true|false|y|n)$/i.test(value.trim())) {
      return inferWorkplaceType(value);
    }
    return null;
  }
  if (
    /^(?:job[\s_-]*)?(?:work(?:place|ing)?|location|office)[\s_-]*(?:type|model|arrangement|setting|policy|archetype|style|mode)$/i.test(field) ||
    /^(?:workplace|work arrangement|job location)$/i.test(field)
  ) {
    return typeof value === 'string' ? inferWorkplaceType(value) : null;
  }
  return null;
}

/**
 * 'Remote', 'Hybrid' or 'OnSite' when the text says so, null when it is silent or
 * mixed. Never defaults to OnSite: null means "not stated", and remote_share reads only
 * the roles that state something.
 *
 * "Remote" needs every place named to be remote. "State College, PA or Remote", and a
 * list like "Boston, MA; Remote-Friendly", are a choice offered to the candidate rather
 * than a workplace type, so they stay null. Counting them Remote would overstate
 * remote_share and counting them OnSite would understate it; null keeps them out of the
 * denominator, and the city is still kept as the job's address. "Remote - US" and
 * "United States, Remote" are one place with a remote marker, so they are Remote.
 */
export function inferWorkplaceType(text: string | null | undefined): 'Remote' | 'Hybrid' | 'OnSite' | null {
  if (!text) return null;
  // A bracket with no workplace word in it only qualifies the place: "Remote (US or
  // Canada)" is one remote role, not a choice between two places. Slashes between
  // workplace words ("Hybrid/Remote") are a choice, so split on them.
  const unbracketed = text.replace(/\(([^)]*)\)/g, (whole, inner: string) =>
    REMOTE_WORDS.test(inner) || HYBRID_WORDS.test(inner) || ONSITE_WORDS.test(inner) ? whole : ' ',
  );
  const parts = segments(unbracketed.replace(/\s*\/\s*(?=(?:remote|hybrid|on[\s-]?site)\b)/gi, '; '));
  let remote = 0;
  let hybrid = 0;
  let onsite = 0;
  let plain = 0;
  for (const part of parts) {
    const r = REMOTE_WORDS.test(part);
    const h = HYBRID_WORDS.test(part);
    const o = ONSITE_WORDS.test(part);
    // A remote marker beside a city ("Remote - London", "Kyiv, Ukraine, Remote, Warsaw")
    // is the City-or-Remote choice written with a comma. Beside a country or a state it
    // is a remote role with a hiring area ("Remote - US", "Remote, US, Texas"). A
    // city-state is both, and counts as the country.
    if (r && !h && !o) {
      const place = parseSegment(stripWorkplace(part));
      if (place.locality && place.locality !== place.country) {
        plain += 1;
        remote += 1;
        continue;
      }
    }
    if (r) remote += 1;
    if (h) hybrid += 1;
    if (o) onsite += 1;
    if (!r && !h && !o) plain += 1;
  }
  if (remote && !hybrid && !onsite && !plain) return 'Remote';
  if (hybrid && !remote && !onsite) return 'Hybrid';
  if (onsite && !remote && !hybrid) return 'OnSite';
  return null;
}

/** Drops workplace words, brackets and the punctuation that joined them to the place. */
function stripWorkplace(text: string): string {
  return text
    .replace(/\([^)]*\b(?:remote|hybrid|on[\s-]?site|travel|in[\s-]office)\b[^)]*\)/gi, ' ')
    .replace(/[\s-]+based\b/gi, ' ')
    .replace(/\b(?:flexible\s+|anywhere\s+)?within\s+(?:the\s+)?/gi, ' ')
    .replace(new RegExp(REMOTE_WORDS.source, 'gi'), ' ')
    .replace(new RegExp(HYBRID_WORDS.source, 'gi'), ' ')
    .replace(new RegExp(ONSITE_WORDS.source, 'gi'), ' ')
    .replace(/\bwith required travel\b|\btravel[\s-]required\b/gi, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,(?:\s*,)+/g, ',')
    .replace(/^[\s,\-–—:]+|[\s,\-–—:]+$/g, '')
    // What is left of "Remote in the US" and "Remote (in the U.S.)".
    .replace(/^(?:in|within)\s+(?:the\s+)?/i, '')
    .trim();
}

/**
 * The canonical country for one part of the string, or null if it is not one. Parts of
 * two letters are codes, and codes go through codeCountry with the state tables first.
 * Georgia is never a country here, because "Atlanta, Georgia" vastly outnumbers
 * Tbilisi; the known-city list handles Tbilisi.
 */
function countryOf(part: string): string | null {
  const key = part.trim().toLowerCase().replace(/\.$/, '').replace(/-/g, ' ');
  if (key.length <= 2 || key === 'georgia') return null;
  const extra = EXTRA_COUNTRY_ALIASES.get(key);
  if (extra) return extra;
  const folded = normaliseCountry(key);
  return (folded && COUNTRIES.get(folded.toLowerCase())) ?? null;
}

/** A two-letter country code, only where it cannot also be a US state or province. */
function codeCountry(part: string): string | null {
  const code = part.trim().replace(/\.$/, '').toUpperCase();
  if (code.length !== 2 || US_STATES[code] || CA_PROVINCES[code]) return null;
  return ISO2[code] ?? null;
}

const anyCountry = (part: string): string | null => countryOf(part) ?? codeCountry(part);

type Region = { region: string; country: string };

/** A US state, Canadian province or Australian state, by name or abbreviation. */
function regionOf(part: string): Region | null {
  const trimmed = part.trim().replace(/\.$/, '');
  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  if (trimmed.length === 2 && US_STATES[upper]) return { region: US_STATES[upper]!, country: 'United States' };
  if (trimmed.length === 2 && CA_PROVINCES[upper]) return { region: CA_PROVINCES[upper]!, country: 'Canada' };
  if (trimmed.length === 3 && AU_STATES[upper]) return { region: AU_STATES[upper]!, country: 'Australia' };
  const us = US_STATE_NAMES.get(lower);
  if (us) return { region: us, country: 'United States' };
  const ca = CA_PROVINCE_NAMES.get(lower);
  if (ca) return { region: ca, country: 'Canada' };
  const au = AU_STATE_NAMES.get(lower);
  if (au) return { region: au, country: 'Australia' };
  return null;
}

/** ISO code for a two-letter part, ignoring the state collision. Used only with a known city. */
function rawIso(part: string): string | null {
  const code = part.trim().replace(/\.$/, '').toUpperCase();
  return code.length === 2 ? (ISO2[code] ?? null) : null;
}

/** Words that mark a part as an organisational label, not a place. */
const LABEL = /^(?:field|local|regional|corporate|corp|home|hq|headquarters|national|nationwide|statewide|various|multiple locations|all locations|other)$/i;

/**
 * Text that has no business in a city filter even after cleaning: time zones, travel
 * notes, buildings and street furniture. Anything matching keeps its country but loses
 * its locality.
 */
const NOT_LOCALITY = /\b(?:time\s*zone|preferred|based|travel|required|only|eligible|local|regional|field|corporate|corp|home|national|nationwide|statewide|multiple|various|locations?|regions?|hq|headquarters|office|offices|campus|building|center|centre|village|ridge|suite|floor|drive|street|road|avenue|blvd|\d)\b/i;

/**
 * "United States- Griffin, Georgia", "Mexico- Nuevo Laredo", "Field - New Jersey",
 * "Malaysia-Local". A dash splits a part only when one side is a country, a region or a
 * label, so "Winston-Salem" and "Stratford-upon-Avon" survive untouched. A country
 * prefix moves to the end, where the rest of the parser expects it.
 */
function splitDash(part: string): string[] {
  const pieces = part.split(/\s*[-–—]\s*/).filter(Boolean);
  if (pieces.length < 2) return [part];
  const [head, ...tail] = pieces as [string, ...string[]];
  const rest = tail.join(' ');
  if (anyCountry(head)) {
    // "Malaysia-Local" is the country alone; "Mexico- Nuevo Laredo" is a city in it.
    const countryOnly = LABEL.test(rest) || (!/\s/.test(part) && !regionOf(rest));
    return countryOnly ? [head] : [rest, head];
  }
  if (LABEL.test(head)) return [rest];
  const last = tail[tail.length - 1]!;
  if (anyCountry(last) || regionOf(last)) return [pieces.slice(0, -1).join('-'), last];
  return [part];
}

function cleanPart(part: string): string[] {
  const unzipped = part
    .replace(/\s+\d{5}(?:-\d{4})?$/, '')
    .replace(/\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i, '')
    .trim();
  if (!unzipped) return [];
  // "US/Canada": keep the first of a slash pair when it is a place we recognise.
  const slash = unzipped.split('/');
  const base = slash.length > 1 && (anyCountry(slash[0]!) || regionOf(slash[0]!)) ? slash[0]!.trim() : unzipped;
  return splitDash(base).map((p) => p.trim()).filter((p) => p && !LABEL.test(p));
}

const EMPTY: NormalisedAddress = { country: null, region: null, locality: null };

function cityOrNull(raw: string | null, country: string, hasRegion = false): string | null {
  if (!raw || NOT_LOCALITY.test(raw)) return null;
  const locality = normaliseLocality(raw.replace(/\s+d\.?c\.?$/i, (m) => (/^washington/i.test(raw) ? m : '')));
  if (!locality) return null;
  // A country in the city slot, unless it is a city-state that the known list vouches for.
  if (locality.toLowerCase() === country.toLowerCase() && knownCityCountry(locality, null) !== country) return null;
  // A country name as the city is a leak, unless a state of the stated country sits
  // beside it, which makes it a town: Lebanon, New Hampshire.
  if (countryOf(locality) && !hasRegion) return knownCityCountry(locality, null) === country ? locality : null;
  return locality;
}

/** One part on its own: a country, a known city, or a state. Nothing else is trusted. */
function single(part: string): NormalisedAddress {
  const country = anyCountry(part);
  if (country) {
    // City-states are both. Everywhere else a bare country names no city.
    return { country, region: null, locality: knownCityCountry(part, null) === country ? cityOrNull(part, country) : null };
  }
  const known = knownCityCountry(part, normaliseLocality(part));
  if (known) return { country: known, region: null, locality: cityOrNull(part, known) };
  // Bare "Washington" and "Georgia" are a coin toss between two places each.
  const region = part.length > 2 && !/^(?:washington|georgia)$/i.test(part.trim()) ? regionOf(part) : null;
  if (region) return { country: region.country, region: region.region, locality: null };
  return EMPTY;
}

/**
 * Parses one Greenhouse location string into the shared address shape. Returns all
 * nulls rather than a guess.
 */
export function parseGreenhouseLocation(text: string | null | undefined): NormalisedAddress {
  if (!text) return EMPTY;
  const first = segments(text).map(stripWorkplace).find(Boolean);
  return first ? parseSegment(first) : EMPTY;
}

/** One place, already split from its neighbours and stripped of workplace words. */
function parseSegment(segment: string): NormalisedAddress {
  const parts = segment.split(',').flatMap(cleanPart);
  if (!parts.length) return EMPTY;
  // A country first is a list of countries: "Australia, Singapore, Malaysia". Unless a
  // state follows it, when it is one of the American towns named after a country:
  // "Lebanon, NH", "Peru, IN", "Mexico, MO".
  const lead = anyCountry(parts[0]!);
  const next = parts.length > 1 ? regionOf(parts[1]!) : null;
  if (parts.length === 1 || (lead && !next)) return single(parts[0]!);
  // "US, Texas": a country and one of its own states, with no city named.
  if (lead && next && next.country === lead) return { country: lead, region: next.region, locality: null };

  // Find where the first place ends: at a country, or at a region and the country that
  // may follow it. The city is the part just before the region, which also reads street
  // addresses right: "2000 Center Drive, West E101, Hoffman Estates, IL 60192".
  let regionIdx: number | null = null;
  let countryIdx: number | null = null;
  for (let i = 1; i < parts.length; i++) {
    if (countryOf(parts[i]!) || (codeCountry(parts[i]!) && !regionOf(parts[i]!))) {
      countryIdx = i;
      break;
    }
    if (regionOf(parts[i]!) || rawIso(parts[i]!)) {
      regionIdx = i;
      if (i + 1 < parts.length && anyCountry(parts[i + 1]!)) countryIdx = i + 1;
      break;
    }
  }

  const cityRaw = parts[regionIdx !== null ? regionIdx - 1 : 0]!;
  const known = knownCityCountry(cityRaw, normaliseLocality(cityRaw));
  let country: string | null = countryIdx !== null ? anyCountry(parts[countryIdx]!) : null;
  let region: string | null = null;

  if (regionIdx !== null) {
    const regionPart = parts[regionIdx]!;
    const state = regionOf(regionPart);
    const iso = rawIso(regionPart);
    if (country) {
      region = state && state.country === country ? state.region : normaliseRegion(regionPart);
    } else if (known === 'Georgia' && /^georgia$/i.test(regionPart.trim())) {
      country = 'Georgia';
    } else if (known && iso === known) {
      // "Tel Aviv, IL", "Toronto, CA", "Berlin, DE": the city knows what the code means.
      country = known;
    } else if (state) {
      // "Chicago, IL", and "London, ON", which really is London, Ontario.
      country = state.country;
      region = state.region;
    } else if (iso) {
      country = iso;
    }
  } else if (countryIdx !== null && countryIdx > 1) {
    // "Bengaluru, Karnataka, India": a region we have no table for, kept as written.
    region = normaliseRegion(parts.slice(1, countryIdx).join(', '));
  } else if (countryIdx === null && known) {
    // "Bengaluru, Karnataka": no country stated, but the city is unambiguous.
    country = known;
    region = normaliseRegion(parts[1]);
  }

  if (!country) return EMPTY;

  // The first part was a state, not a city: "California, United States".
  if (regionIdx === null && !known) {
    const asRegion = cityRaw.length > 2 ? regionOf(cityRaw) : null;
    if (asRegion && asRegion.country === country) return { country, region: asRegion.region, locality: null };
  }

  // A known city contradicting the stated country means the string is not the shape we
  // think. The only exception is a city that genuinely exists in both, which shows as a
  // region belonging to the stated country ("London, ON", "Paris, TX").
  if (known && known !== country) {
    const regionCountry = region ? regionOf(region)?.country : null;
    if (regionCountry !== country) return EMPTY;
  }

  const stateOfCountry = region ? regionOf(region)?.country === country : false;
  return { country, region, locality: cityOrNull(cityRaw, country, stateOfCountry) };
}
