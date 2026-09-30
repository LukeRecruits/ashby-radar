/**
 * Turning a crawled jobs.ashbyhq.com URL into a board name.
 *
 * Board URLs look like:
 *   https://jobs.ashbyhq.com/acme
 *   https://jobs.ashbyhq.com/acme/0d6f9c1a-....?utm_source=x
 *   https://jobs.ashbyhq.com/Acme%20Corp/application
 *
 * The board name is always the first path segment. Board names are case-sensitive,
 * so we return them exactly as found and never normalise the case.
 */

/** First path segments that are Ashby infrastructure, not customer boards. */
const RESERVED = new Set([
  'api',
  'embed',
  'embed.js',
  'static',
  'assets',
  'public',
  '_next',
  'cdn',
  'images',
  'image',
  'img',
  'js',
  'css',
  'fonts',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'health',
  'healthz',
  'status',
  'login',
  'logout',
  'signin',
  'sign-in',
  'signup',
  'auth',
  'callback',
  'null',
  'undefined',
  'index.html',
]);

/** Anything ending in one of these is a file, not a board. */
const FILE_EXTENSION = /\.(js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|json|xml|txt|pdf|zip|gz|html?|php|aspx?)$/i;

/**
 * Board names are a slug, but a minority contain spaces (jobs.ashbyhq.com/Local%20Infusion
 * is a real board with live jobs). Anything outside this set is a crawl artefact: the
 * junk in the indexes is serialised JSON and query fragments full of quotes and colons.
 */
const ALLOWED_CHARS = /^[A-Za-z0-9][A-Za-z0-9._~ -]*$/;

const MAX_LENGTH = 80;

/**
 * Shapes that prove a path segment was never a company name. All three were confirmed
 * 404 against the posting API, and unlike a plain name they cannot be a real board.
 *
 * Note the deliberate limit: a 404 on its own is NOT evidence of junk. "Stanza" and
 * "DECA Dental Group" are ordinary names that also 404, because they are former Ashby
 * customers whose boards are gone. That is normal attrition and phase 2's job to record
 * as not_found. Only structural impossibility belongs here.
 */
const STRUCTURAL_JUNK: RegExp[] = [
  // root.<uuid> and root.<uuid>.<uuid>. An artefact of the embedded job board widget:
  // 2,059 of the first 7,792 names discovered were this one shape.
  /^root\./i,
  // jobs-page-<uuid>, from paginated board listings.
  /^jobs-page-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // A UUID with underscores for separators, anywhere in the segment.
  /[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}/i,
];

export function extractBoardName(rawUrl: string): string | null {
  let url: URL;
  try {
    // CDX indexes return bare URLs and occasionally protocol-relative ones.
    url = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }

  if (url.hostname.toLowerCase() !== 'jobs.ashbyhq.com') return null;

  const firstSegment = url.pathname.split('/').filter(Boolean)[0];
  if (!firstSegment) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(firstSegment);
  } catch {
    // Malformed percent-encoding. Not a real board name.
    return null;
  }

  decoded = decoded.trim();
  if (!decoded || decoded.length > MAX_LENGTH) return null;
  if (RESERVED.has(decoded.toLowerCase())) return null;
  if (FILE_EXTENSION.test(decoded)) return null;
  if (!ALLOWED_CHARS.test(decoded)) return null;

  // A bare UUID as the first segment means the crawler recorded a job URL with the
  // board name already stripped. Nothing usable there.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) {
    return null;
  }

  if (STRUCTURAL_JUNK.some((pattern) => pattern.test(decoded))) return null;

  return decoded;
}

/**
 * Groups names that differ only by case. The unique constraint in Postgres is
 * case-sensitive on purpose, so these are flagged for review rather than merged.
 */
export function findCaseVariants(names: Iterable<string>): string[][] {
  const groups = new Map<string, Set<string>>();
  for (const name of names) {
    const key = name.toLowerCase();
    const group = groups.get(key) ?? new Set<string>();
    group.add(name);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.size > 1)
    .map((group) => [...group].sort());
}

/**
 * Ashby's posting API is case-insensitive on the board name: /Linear, /linear and
 * /LINEAR all return the same 30 jobs. Crawl data contains both spellings of the same
 * board (LIV-Golf and LIV-golf, for instance), so storing each spelling as its own
 * company would mean duplicate daily API calls, duplicate snapshots and duplicate
 * triggers for one company.
 *
 * We therefore keep one spelling per board: the one seen most often in the crawls, which
 * is the one the company actually links to. Phase 2 can correct it to the authoritative
 * spelling, which the API returns inside each job's jobUrl.
 */
export function collapseCaseVariants<T extends { hitCount: number }>(
  hits: Map<string, T>,
): { canonical: Map<string, T>; variants: string[][] } {
  const groups = new Map<string, [string, T][]>();
  for (const entry of hits) {
    const key = entry[0].toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  const canonical = new Map<string, T>();
  const variants: string[][] = [];

  for (const group of groups.values()) {
    // Most-seen spelling wins; alphabetical as a stable tie-break.
    const sorted = [...group].sort(
      (a, b) => b[1].hitCount - a[1].hitCount || a[0].localeCompare(b[0]),
    );
    const [winnerName, winnerHit] = sorted[0]!;
    const totalHits = group.reduce((sum, [, hit]) => sum + hit.hitCount, 0);
    canonical.set(winnerName, { ...winnerHit, hitCount: totalHits });
    if (group.length > 1) variants.push(group.map(([name]) => name).sort());
  }

  return { canonical, variants };
}
