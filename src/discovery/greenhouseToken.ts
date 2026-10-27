/**
 * Turning a crawled Greenhouse URL into a board token.
 *
 * Board URLs live on four hosts (config.greenhouse.boardHosts) and look like:
 *   https://job-boards.greenhouse.io/adyen
 *   https://boards.greenhouse.io/adyen/jobs/4567890?gh_src=x
 *   https://boards.greenhouse.io/embed/job_board?for=adyen
 *   https://boards.greenhouse.io/embed/job_app?for=adyen&token=4567890
 *
 * The token is the first path segment, except on the embed widget, where it is the
 * `for` query parameter and the first segment is always "embed".
 *
 * Unlike Ashby, tokens are lowercased. Greenhouse's board API is case-insensitive on the
 * token (ADYEN and adyen return the same board) and every token Greenhouse issues is
 * lowercase, so a capitalised spelling in the crawl is a human retyping a link, never a
 * different board. Ashby has no canonical case, which is why it keeps the most-seen
 * spelling instead; here there is a right answer and we can simply use it.
 */

/**
 * First path segments that are Greenhouse infrastructure, not customer boards. Every
 * entry was seen in the Wayback index for boards.greenhouse.io and confirmed 404 against
 * the board API on 2026-10-27, except the handful of generic ones at the end. Note what
 * is NOT here: "privacy" looks like infrastructure but is a real board with live jobs.
 */
const RESERVED = new Set([
  'embed', // Handled separately: the token is in ?for=.
  'v1', // The legacy board API, /v1/boards/{token}/...
  'api',
  'assets', // assets/embed.css, fingerprinted .js bundles
  'static', // static/bookmark.html, share buttons
  'images',
  'users', // users/password/new
  'jobs', // a bare /jobs with no board in front of it
  'javascripts',
  'stylesheets',
  'packs',
  'cdn-cgi',
  'login',
  'logout',
  'sign_in',
  'apply',
  'careers',
  'null',
  'undefined',
]);

/**
 * The characters a token may contain. Real tokens are mostly [a-z0-9] with the odd
 * hyphen, but Greenhouse does not police them: "1pyra)mid_health&care" looks like crawl
 * junk and is in fact Pyramid Healthcare's live board, and "540" and "103644278" are real
 * boards too. So the rule is a blocklist in spirit: what is excluded is what the junk in
 * the indexes is actually made of, which is quotes, spaces, commas, angle brackets,
 * backslashes and asterisks from HTML and JSON scraped as if it were a link.
 *
 * Dots are excluded as well. Every dotted first segment seen (.well-known, index.jsp,
 * sitemap.xml, a googleusercontent.com client id) was junk, and no real board was seen
 * with one. That differs from Ashby, where Viz.ai and primer.io are real boards.
 */
const ALLOWED_CHARS = /^[a-z0-9][a-z0-9_()&!~+-]*$/;

/** The longest real token seen is about 40 characters. Twice that is junk. */
const MAX_LENGTH = 64;

export function extractGreenhouseBoardToken(
  rawUrl: string,
  boardHosts: readonly string[],
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }

  if (!boardHosts.includes(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments[0];
  if (!first) return null;

  let candidate: string | null;
  if (first.toLowerCase() === 'embed') {
    candidate = embedToken(url, segments);
  } else {
    try {
      candidate = decodeURIComponent(first);
    } catch {
      // Malformed percent-encoding. Not a real token.
      return null;
    }
  }
  if (candidate === null) return null;

  const token = candidate.trim().toLowerCase();
  if (!token || token.length > MAX_LENGTH) return null;
  if (RESERVED.has(token)) return null;
  if (!ALLOWED_CHARS.test(token)) return null;
  return token;
}

/**
 * The embed widget carries the token in ?for=. Crawlers that read the URL out of HTML
 * often keep the entity, so "&amp;for=x" arrives as a parameter literally named
 * "amp;for": 1,748 of 3,000 sampled embed URLs had their other parameters mangled that
 * way. A few crawls also hold /embed/{token}/jobs/{id}, which is not a Greenhouse route
 * but still names a real board in the right position (coinbase, gemini, cloudflare).
 */
function embedToken(url: URL, segments: string[]): string | null {
  const forParam = url.searchParams.get('for') ?? url.searchParams.get('amp;for');
  if (forParam) return forParam;
  if (segments.length >= 4 && segments[2] === 'jobs' && /^\d+$/.test(segments[3] ?? '')) {
    try {
      return decodeURIComponent(segments[1]!);
    } catch {
      return null;
    }
  }
  return null;
}
