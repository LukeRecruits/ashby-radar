/**
 * Three numbers per company that Radar did not show before (migration 0026).
 *
 * - Recruiter load: open roles per recruiter on the team the people sweep found. Exa
 *   returns at most ten people per company, so a big team reads as ten; inside the 5 to
 *   50 band that cap is rarely reached.
 * - Adverts that came down in the last 90 days, how long they were live, and how many of
 *   those roles came back. Same-title swaps within three days are excluded first: a
 *   quarter of all closures are an ad being reposted, not a role being filled.
 * - Headcount and funding, from one Exa company search per in-band prospect.
 */

import { db } from './supabase';

export type CompanyStats = {
  company_id: string;
  people_searched_at: string | null;
  people_count: number;
  recruiter_count: number;
  window_days: number | null;
  closed_count: number | null;
  swap_count: number | null;
  repost_count: number | null;
  median_days_live: number | null;
  profile_searched_at: string | null;
  profile_matched: boolean | null;
  headcount: number | null;
  founded_year: number | null;
  funding_total_usd: number | null;
  latest_round_name: string | null;
  latest_round_date: string | null;
  latest_round_usd: number | null;
};

const COLUMNS =
  'company_id, people_searched_at, people_count, recruiter_count, window_days, closed_count, ' +
  'swap_count, repost_count, median_days_live, profile_searched_at, profile_matched, headcount, ' +
  'founded_year, funding_total_usd, latest_round_name, latest_round_date, latest_round_usd';

/** Below this many closures a median is an anecdote, so the console prints none. */
export const MIN_CLOSURES_FOR_MEDIAN = 3;

export async function fetchStats(ids: string[]): Promise<Map<string, CompanyStats>> {
  if (!ids.length) return new Map();
  const { data, error } = await db().from('lead_company_stats').select(COLUMNS).in('company_id', ids);
  if (error) throw new Error(`lead_company_stats read failed: ${error.message}`);
  const rows = (data ?? []) as unknown as CompanyStats[];
  return new Map(rows.map((r) => [r.company_id, r]));
}

/**
 * Open roles per recruiter, or why there is no figure. Null recruiter count with a search
 * done means the sweep found people but none of them recruit, which is itself the answer.
 */
export function recruiterLoad(
  openRoles: number,
  stats: CompanyStats | undefined,
): { value: string; note: string; heavy: boolean } | null {
  if (!stats?.people_searched_at) return null;
  if (stats.recruiter_count === 0) {
    return {
      value: 'No recruiter',
      note: stats.people_count ? `${stats.people_count} in people or HR, none recruiting` : 'Nobody found in talent',
      heavy: openRoles >= 5,
    };
  }
  const per = openRoles / stats.recruiter_count;
  return {
    value: per >= 10 ? String(Math.round(per)) : per.toFixed(1).replace(/\.0$/, ''),
    note: `${openRoles} roles, ${stats.recruiter_count} recruiter${stats.recruiter_count === 1 ? '' : 's'} found`,
    heavy: per >= 15,
  };
}

export function money(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd) || usd <= 0) return null;
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(1).replace(/\.0$/, '')}bn`;
  if (usd >= 1e6) return `$${Math.round(usd / 1e6)}m`;
  return `$${Math.round(usd / 1e3)}k`;
}
