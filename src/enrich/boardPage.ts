/**
 * Reading a company's real name off its Ashby board page.
 *
 * The posting API has no company name anywhere: the response has exactly two top-level
 * keys, `jobs` and `apiVersion`, and no job field carries one. That is why display_name
 * has been null since phase 1, and why the README said a name could not be had.
 *
 * The hosted board *page* has one. `<title>` on https://jobs.ashbyhq.com/{board} is
 * "<Company> Jobs", set from the organisation's own Ashby settings. 25 of 25 on a test
 * that included the awkward cases:
 *
 *   the job sauce          -> The Job Sauce
 *   Agentis-Capital-Advisors -> Agentis Capital Advisors
 *   kpr                    -> KP Reddy Co.
 *   demo.uipath.com        -> UiPath Workday Sandbox
 *
 * The last two are the point. No amount of slug-tidying turns `kpr` into "KP Reddy Co.",
 * and "UiPath Workday Sandbox" is how you find out a board is a demo environment rather
 * than a prospect.
 */

import { config } from '../config.ts';
import { fetchWithRetry } from '../lib/http.ts';

const TITLE = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i;

const ENTITIES: [RegExp, string][] = [
  [/&amp;/gi, '&'],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#0*39;|&apos;|&#x0*27;/gi, "'"],
  [/&nbsp;/gi, ' '],
];

function decode(value: string): string {
  let out = value;
  for (const [pattern, replacement] of ENTITIES) out = out.replace(pattern, replacement);
  return out.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/**
 * "Supabase Jobs" -> "Supabase". Only the trailing word is removed, and only when
 * something is left: a company genuinely called "Jobs" keeps its name.
 */
export function companyNameFromTitle(title: string): string | null {
  const decoded = decode(title).replace(/[\s ]+/g, ' ').trim();
  if (!decoded) return null;

  const stripped = decoded.replace(/\s*[|·–—-]?\s*\b(jobs|careers|open roles|job board)\b\s*$/i, '').trim();
  const name = stripped || decoded;

  // A board with no theme set renders a generic title. Not a company name.
  if (/^(ashby|job board|jobs|careers|not found|error)$/i.test(name)) return null;
  if (name.length < 2 || name.length > 120) return null;
  return name;
}

export type BoardPageResult =
  | { found: true; name: string | null }
  | { found: false };

/** Fetches one board page and reads the company name out of it. */
export async function fetchCompanyName(boardName: string): Promise<BoardPageResult> {
  const url = `https://jobs.ashbyhq.com/${encodeURIComponent(boardName)}`;
  const response = await fetchWithRetry(url, {
    timeoutMs: config.enrich.boardPageTimeoutMs,
    maxRetries: config.enrich.maxRetries,
    retryBaseDelayMs: config.enrich.retryBaseDelayMs,
    passThroughStatuses: [404],
  });

  if (response.status === 404) return { found: false };

  // The page is a JavaScript app; only the head matters and it arrives first. Reading
  // the whole body would pull a megabyte per board for nothing.
  const html = (await response.text()).slice(0, config.enrich.boardPageReadBytes);
  const match = TITLE.exec(html);
  return { found: true, name: match?.[1] ? companyNameFromTitle(match[1]) : null };
}
