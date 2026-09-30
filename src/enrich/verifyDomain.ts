/**
 * Second-tier domain resolution: guess, then prove.
 *
 * About 40% of companies never link themselves in their own job adverts, so nothing
 * can be read out of the board. For those, try the obvious domains and verify.
 *
 * The verification is circular on purpose. We start from board `acme`, and if
 * acme.com's careers page links to jobs.ashbyhq.com/acme, that is proof rather than
 * inference: the company is telling us that board is theirs. False positives are
 * effectively impossible, which matters because a wrong domain sends a real prospect's
 * slot to another company and every later lookup inherits the mistake.
 *
 * Where there is no backlink, a weaker check applies: the site is live and its own
 * title or og:site_name names the company. That is recorded at a lower confidence so
 * it can be filtered out or re-checked later.
 *
 * Unlike the Ashby calls, these go to thousands of different hosts, so the one-request-
 * per-second Ashby budget does not apply. Each host is touched a handful of times at
 * most, and the work is parallel across companies.
 */

import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { sleep } from '../lib/sleep.ts';
import { guessableDomains, scoreCandidate } from './domainGuess.ts';

export type Verified = {
  domain: string;
  confidence: number;
  source: 'careers_backlink' | 'site_name_match';
};

/** One fetch, short timeout, no retries. A site that is slow or down is simply a miss. */
async function get(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': config.userAgent, accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(config.enrich.siteTimeoutMs),
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') ?? '';
    if (type && !type.includes('html') && !type.includes('text')) return null;
    return (await response.text()).slice(0, config.enrich.siteReadBytes);
  } catch {
    return null;
  }
}

/**
 * robots.txt, honoured for our own user-agent and for `*`.
 *
 * Deliberately simple: it reads Disallow rules and treats a bare `Disallow: /` as
 * "leave this site alone". It does not implement Allow precedence or wildcards, and
 * errs towards not fetching. A site we skip is a company that goes to Clay, which is a
 * far better outcome than crawling somebody who asked us not to.
 */
async function mayCrawl(domain: string): Promise<boolean> {
  const body = await get(`https://${domain}/robots.txt`);
  if (body === null) return true; // No robots.txt, or unreachable. Nothing forbids us.

  let applies = false;
  let blocked = false;
  for (const raw of body.split('\n')) {
    const line = raw.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const [field, ...rest] = line.split(':');
    const key = field?.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      applies = value === '*' || config.userAgent.toLowerCase().startsWith(value.toLowerCase());
    } else if (key === 'disallow' && applies && value === '/') {
      blocked = true;
    }
  }
  return !blocked;
}

function namesCompany(html: string, companyName: string | null): boolean {
  if (!companyName) return false;
  const head = html.slice(0, 8_000).toLowerCase();
  const needle = companyName.toLowerCase().replace(/\s+/g, ' ').trim();
  if (needle.length < 3) return false;
  return head.includes(needle);
}

/**
 * Tries the plausible domains for one company and returns the first that proves out.
 *
 * `boardName` is matched case-insensitively because Ashby's board URLs are, and a
 * company's own site often links a different spelling than the one we discovered.
 */
export async function verifyDomain(
  boardName: string,
  companyName: string | null,
): Promise<Verified | null> {
  const candidates = guessableDomains(companyName, boardName, config.enrich.guessTlds);
  const backlink = `jobs.ashbyhq.com/${boardName}`.toLowerCase();
  let fallback: Verified | null = null;
  let fetched = 0;

  for (const domain of candidates) {
    if (fetched >= config.enrich.maxFetchesPerCompany) break;

    // Do not spend the budget on a domain that could never be this company's.
    if (companyName && scoreCandidate(domain, companyName) < config.enrich.minGuessScore) continue;

    if (!(await mayCrawl(domain))) {
      log.info('robots.txt disallows crawling, skipping', { domain });
      continue;
    }

    const home = await get(`https://${domain}/`);
    fetched += 1;
    if (home === null) continue;

    if (home.toLowerCase().includes(backlink)) {
      return { domain, confidence: 100, source: 'careers_backlink' };
    }

    // The homepage rarely links the board; the careers page almost always does.
    for (const path of config.enrich.careersPaths) {
      if (fetched >= config.enrich.maxFetchesPerCompany) break;
      const page = await get(`https://${domain}${path}`);
      fetched += 1;
      await sleep(config.enrich.perHostDelayMs);
      if (page?.toLowerCase().includes(backlink)) {
        return { domain, confidence: 100, source: 'careers_backlink' };
      }
    }

    // Live site that names the company. Worth keeping, worth trusting less.
    if (!fallback && namesCompany(home, companyName)) {
      fallback = { domain, confidence: 80, source: 'site_name_match' };
    }
  }

  return fallback;
}
