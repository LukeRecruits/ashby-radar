/**
 * Working out a company's domain from what Ashby already gives us.
 *
 * Companies link to themselves in their own job adverts, and `descriptionHtml` arrives
 * with every board response we already fetch daily. Reading it costs nothing extra.
 *
 * The naive version, "most frequently linked domain", scored 4 of 12 on a hand-checked
 * sample. It picked github.com for Supabase, nest.js for Mapbox and fortune.com for
 * Giga, because engineers link their repos, adverts list the tech stack, and everyone
 * links their own press. Two changes took it to 7 of 12:
 *
 *   1. Fold to the registrable domain, so go.chainalysis.com counts as chainalysis.com.
 *   2. Rank by how well the domain stem matches the company name, not by frequency.
 *      github.com scores 0 against "Supabase" and loses to supabase.com even though it
 *      appears more often.
 *
 * The property that matters more than the hit rate: of the twelve, seven were right and
 * five were refusals. Nothing was wrong. A wrong domain is expensive, because it sends a
 * real prospect's slot to someone else's company and every downstream lookup inherits
 * the error. A refusal just goes to the next tier.
 */

/** Never a company's own domain, however often it is linked. */
const NOT_A_COMPANY_SITE = [
  // Ashby itself, and the other ATSs a job advert might mention
  'ashbyhq.com', 'ashbyprd.com', 'greenhouse.io', 'lever.co', 'workable.com',
  'myworkdayjobs.com', 'workday.com', 'smartrecruiters.com', 'jobvite.com',
  // Social and profile links in every other advert
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'threads.net',
  'bsky.app', 'mastodon.social', 'glassdoor.com', 'indeed.com', 'crunchbase.com',
  // Developer and doc hosts, the main source of false positives
  'github.com', 'github.io', 'gitlab.com', 'bitbucket.org', 'npmjs.com',
  'stackoverflow.com', 'readthedocs.io', 'w3.org', 'schema.org', 'json.org',
  // Press: companies link their own coverage constantly
  'techcrunch.com', 'forbes.com', 'bloomberg.com', 'nytimes.com', 'wsj.com',
  'fortune.com', 'businessinsider.com', 'theverge.com', 'wired.com', 'ft.com',
  'reuters.com', 'cnbc.com', 'axios.com', 'wikipedia.org', 'medium.com',
  'substack.com', 'notion.so', 'notion.site',
  // Tooling that shows up inside adverts and application flows
  'google.com', 'goo.gl', 'docs.google.com', 'forms.gle', 'calendly.com',
  'typeform.com', 'loom.com', 'zoom.us', 'slack.com', 'hubspot.com',
  'hs-sales-engage.com', 'hsforms.com', 'bit.ly', 'gravatar.com', 'apple.com',
  'microsoft.com', 'amazon.com', 'adobe.com', 'salesforce.com',
];

/**
 * Suffixes that take three labels to make a registrable domain. The real answer is the
 * Public Suffix List, which is thousands of entries and a dependency; this covers the
 * cases that actually appear in job adverts. A suffix we miss folds one label too far
 * (bbc.co.uk becomes co.uk), which scores 0 against any company name and is therefore
 * refused rather than accepted wrongly.
 */
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'com.br', 'com.mx', 'com.ar',
  'co.jp', 'or.jp', 'ne.jp', 'co.kr', 'com.cn', 'com.hk', 'com.tw',
  'co.in', 'com.sg', 'com.my', 'co.za', 'com.tr', 'com.ua', 'co.il',
]);

/** Legal suffixes that are never part of a domain stem. */
const LEGAL_SUFFIX = /(incorporated|technologies|international|corporation|holdings|limited|company|group|labs|inc|llc|ltd|plc|gmbh|bv|nv|ab|as|oy|sa|srl|spa|pty|co|corp)$/;

/** Folds a hostname to its registrable domain. `go.chainalysis.com` → `chainalysis.com`. */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const parts = host.split('.');
  if (parts.length < 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (parts.length > 2 && TWO_PART_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/** Letters and digits only, lowercased. "KP Reddy Co." → "kpreddyco". */
export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The comparable core of a company name, with any legal suffix removed. */
function nameCore(companyName: string): string {
  const slug = slugify(companyName);
  const trimmed = slug.replace(LEGAL_SUFFIX, '');
  // "Co." on its own is the whole name for nobody; keep the slug if stripping empties it.
  return trimmed.length >= 3 ? trimmed : slug;
}

/** Longest common subsequence ratio, 0..1. Cheap and good enough for short strings. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let matched = 0;
  let cursor = 0;
  for (const char of short) {
    const found = long.indexOf(char, cursor);
    if (found !== -1) {
      matched += 1;
      cursor = found + 1;
    }
  }
  return matched / long.length;
}

/**
 * How strongly a candidate domain looks like it belongs to this company, 0..100.
 * Exact stem match is the common case: synthesia.io for Synthesia, giga.ai for Giga.
 */
export function scoreCandidate(domain: string, companyName: string): number {
  const stem = registrableDomain(domain).split('.').slice(0, -1).join('');
  const core = nameCore(companyName);
  if (!stem || !core) return 0;
  if (stem === core) return 100;
  // "kpreddy" for "KP Reddy Co.", "supabase" for "Supabase Inc"
  if (stem.startsWith(core) || core.startsWith(stem)) {
    const shorter = Math.min(stem.length, core.length);
    return shorter >= 4 ? 90 : 60;
  }
  return Math.round(75 * similarity(stem, core));
}

export type DomainCandidate = { domain: string; hits: number };

/**
 * Pulls every plausible company domain out of a board's job descriptions.
 *
 * Descriptions are read and discarded. Nothing but the extracted hostname is kept,
 * which keeps Radar's "no job descriptions stored" rule intact.
 */
export function candidatesFromDescriptions(descriptions: string[]): DomainCandidate[] {
  const counts = new Map<string, number>();

  for (const html of descriptions) {
    if (!html) continue;
    // Anchored on a real URL scheme and terminated by a character that cannot appear in
    // a hostname. An earlier version matched bare dotted words and produced
    // "machines.you" from the sentence "...machines. You will...".
    const matches = html.matchAll(
      /https?:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?=[/?#"'\s<>)\]]|$)/gi,
    );
    for (const match of matches) {
      const host = match[1];
      if (!host) continue;
      const domain = registrableDomain(host);
      if (!/\.[a-z]{2,}$/.test(domain)) continue;
      if (NOT_A_COMPANY_SITE.includes(domain)) continue;
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
  }

  return [...counts]
    .map(([domain, hits]) => ({ domain, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 8);
}

/**
 * Picks a domain from the candidates, or returns null rather than guess.
 *
 * `minScore` is the whole safety margin. Below it we would rather hand the company to
 * the verifier than write a domain that quietly poisons every later lookup.
 */
export function pickDomain(
  candidates: DomainCandidate[],
  companyName: string | null,
  minScore: number,
): { domain: string; confidence: number } | null {
  if (!companyName || !candidates.length) return null;

  const ranked = candidates
    .map((candidate) => ({
      domain: candidate.domain,
      score: scoreCandidate(candidate.domain, companyName),
      hits: candidate.hits,
    }))
    .sort((a, b) => b.score - a.score || b.hits - a.hits);

  const best = ranked[0];
  if (!best || best.score < minScore) return null;
  return { domain: best.domain, confidence: best.score };
}

/**
 * Domains worth trying for a company we could not read one from. Ordered by how often
 * each shape turns out to be right, and deduplicated.
 */
export function guessableDomains(
  companyName: string | null,
  boardName: string,
  tlds: readonly string[],
): string[] {
  const stems = new Set<string>();
  if (companyName) stems.add(nameCore(companyName));
  const boardStem = slugify(boardName.replace(/[-_.]?(careers?|jobs|hq|inc|team)$/i, ''));
  if (boardStem.length >= 3) stems.add(boardStem);
  // A board named after a domain is its own answer: `voltai.careers`, `demo.uipath.com`.
  if (/^[a-z0-9-]+\.[a-z]{2,}$/i.test(boardName)) stems.add(slugify(boardName.split('.')[0]!));

  const out: string[] = [];
  for (const stem of stems) {
    if (stem.length < 3) continue;
    for (const tld of tlds) out.push(`${stem}.${tld}`);
  }
  return [...new Set(out)];
}
