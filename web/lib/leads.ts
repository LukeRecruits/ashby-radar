/**
 * Reading the lead list, and the filter vocabulary the URL speaks.
 *
 * Every filter lives in the query string rather than in component state, so a segment
 * ("UK, 5-50 roles, no open recruiter req") is a link Luke can bookmark, and the back button
 * works. That is also why the whole page is a server component with a plain GET form:
 * there is no client-side fetching to keep in sync with the URL.
 */

import { db } from './supabase';

export const PAGE_SIZE = 50;

export type SignalType =
  | 'new_to_ashby'
  | 'hiring_spike'
  | 'first_recruiter'
  | 'sweet_spot'
  | 'long_open'
  | 'publishes_comp';

export const SIGNALS: { type: SignalType; label: string; hint: string }[] = [
  { type: 'sweet_spot', label: 'In band', hint: 'Open roles moved into the 5-50 range' },
  { type: 'hiring_spike', label: 'Spike', hint: 'Open roles up 5 or more on 30 days ago' },
  { type: 'first_recruiter', label: 'First TA', hint: 'A recruiting hire where there was none' },
  { type: 'long_open', label: 'Stalling', hint: 'A role open 120+ days' },
  { type: 'publishes_comp', label: 'Pay', hint: 'Showing pay on a job for the first time' },
  { type: 'new_to_ashby', label: 'New', hint: 'First successful check since the backfill' },
];

export const SORTS = {
  roles: { label: 'Most open roles', column: 'open_roles', ascending: false },
  stale: { label: 'Most stalled roles', column: 'stale_roles_120', ascending: false },
  growth: { label: 'Fastest growing', column: 'open_roles_change_30d', ascending: false },
  newest: { label: 'Newest to Ashby', column: 'first_seen_at', ascending: false },
  name: { label: 'Name', column: 'label', ascending: true },
} as const;

export type SortKey = keyof typeof SORTS;

export type Filters = {
  country: string;
  city: string;
  band: '' | 'small' | 'target' | 'large' | 'none';
  ta: '' | 'none' | 'has';
  domain: '' | 'has' | 'missing';
  signal: '' | 'none' | SignalType;
  q: string;
  parked: boolean;
  sort: SortKey;
  page: number;
};

export type Lead = {
  id: string;
  label: string;
  board_name: string;
  board_url: string;
  domain: string | null;
  domain_confidence: number | null;
  top_country: string | null;
  top_locality: string | null;
  remote_share: number | null;
  open_roles: number;
  recruiter_roles: number;
  roles_with_pay: number;
  open_roles_change_30d: number | null;
  stale_roles_120: number;
  signal_count: number;
  first_seen_at: string;
  parked_at: string | null;
  parked_reason: string | null;
  new_to_ashby_at: string | null;
  hiring_spike_at: string | null;
  first_recruiter_at: string | null;
  sweet_spot_at: string | null;
  long_open_at: string | null;
  publishes_comp_at: string | null;
};

const COLUMNS =
  'id, label, board_name, board_url, domain, domain_confidence, top_country, ' +
  'top_locality, remote_share, open_roles, recruiter_roles, roles_with_pay, ' +
  'open_roles_change_30d, stale_roles_120, signal_count, first_seen_at, parked_at, ' +
  'parked_reason, new_to_ashby_at, hiring_spike_at, first_recruiter_at, ' +
  'sweet_spot_at, long_open_at, publishes_comp_at';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** Anything the caller sent that is not a known value becomes the default. */
export function parseFilters(params: Record<string, string | string[] | undefined>): Filters {
  const band = one(params.band);
  const ta = one(params.ta);
  const domain = one(params.domain);
  const signal = one(params.signal);
  const sort = one(params.sort);
  const page = Number.parseInt(one(params.page), 10);

  return {
    country: one(params.country),
    city: one(params.city),
    band: (['small', 'target', 'large', 'none'] as const).includes(band as 'small')
      ? (band as Filters['band'])
      : '',
    ta: ta === 'none' || ta === 'has' ? ta : '',
    domain: domain === 'has' || domain === 'missing' ? domain : '',
    signal:
      signal === 'none' || SIGNALS.some((s) => s.type === signal)
        ? (signal as Filters['signal'])
        : '',
    q: one(params.q).slice(0, 80),
    parked: one(params.parked) === '1',
    sort: sort in SORTS ? (sort as SortKey) : 'roles',
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

/**
 * PostgREST's filter grammar is comma and parenthesis delimited, so those characters in
 * a search term would be read as syntax rather than as text. Stripping them is enough:
 * no company name needs them, and the alternative, quoting, has its own escaping to get
 * wrong on a string that reaches the database.
 */
function searchSafe(q: string): string {
  return q.replace(/[,()*\\%"']/g, ' ').trim();
}

export async function fetchLeads(
  filters: Filters,
): Promise<{ rows: Lead[]; total: number }> {
  const sort = SORTS[filters.sort];
  const from = (filters.page - 1) * PAGE_SIZE;

  let query = db()
    .from('lead_list')
    .select(COLUMNS, { count: 'exact' })
    .eq('status', 'active');

  // Parked companies are out of every view unless asked for, including the counts, so a
  // deliberate "no" never quietly reappears at the bottom of a list.
  if (!filters.parked) query = query.is('parked_at', null);

  if (filters.country) query = query.eq('top_country', filters.country);
  if (filters.city) query = query.eq('top_locality', filters.city);
  if (filters.band) query = query.eq('role_band', filters.band);
  if (filters.ta) query = query.eq('has_in_house_ta', filters.ta === 'has');
  if (filters.domain === 'has') query = query.not('domain', 'is', null);
  if (filters.domain === 'missing') query = query.is('domain', null);

  if (filters.signal === 'none') query = query.eq('signal_count', 0);
  else if (filters.signal) query = query.not(`${filters.signal}_at`, 'is', null);

  const q = searchSafe(filters.q);
  if (q) query = query.or(`display_name.ilike.%${q}%,board_name.ilike.%${q}%`);

  // Nulls last on every sort. A company with no 30-day baseline yet is not the
  // fastest-growing company on the list, which is where a default nulls-first would put
  // it while the history is still filling.
  const { data, count, error } = await query
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    // A tiebreak on a unique column, so paging cannot repeat or skip a row when many
    // companies share an open-role count. Most of them do: 2,473 are on a single digit.
    .order('id', { ascending: true })
    .range(from, from + PAGE_SIZE - 1);

  if (error) throw new Error(`lead_list read failed: ${error.message}`);
  return { rows: (data ?? []) as unknown as Lead[], total: count ?? 0 };
}

export type Facet = { value: string; companies: number };

export async function fetchFacets(): Promise<{ countries: Facet[]; cities: Facet[] }> {
  const { data, error } = await db()
    .from('lead_facets')
    .select('kind, value, companies')
    .order('companies', { ascending: false });

  if (error) throw new Error(`lead_facets read failed: ${error.message}`);
  const rows = (data ?? []) as { kind: string; value: string; companies: number }[];
  return {
    countries: rows.filter((r) => r.kind === 'country'),
    cities: rows.filter((r) => r.kind === 'city'),
  };
}

/** Counts for the header, so the shape of the whole list is visible without filtering. */
export async function fetchTotals(): Promise<{
  live: number;
  prospects: number;
  inBand: number;
  noDomain: number;
}> {
  const base = () => db().from('lead_list').select('id', { count: 'exact', head: true });

  const [live, prospects, inBand, noDomain] = await Promise.all([
    base().eq('status', 'active').is('parked_at', null),
    base().eq('status', 'active').is('parked_at', null).not('domain', 'is', null),
    base()
      .eq('status', 'active')
      .is('parked_at', null)
      .not('domain', 'is', null)
      .eq('role_band', 'target'),
    base().eq('status', 'active').is('parked_at', null).is('domain', null),
  ]);

  for (const result of [live, prospects, inBand, noDomain]) {
    if (result.error) throw new Error(`lead_list count failed: ${result.error.message}`);
  }

  return {
    live: live.count ?? 0,
    prospects: prospects.count ?? 0,
    inBand: inBand.count ?? 0,
    noDomain: noDomain.count ?? 0,
  };
}

/** Rebuilds the query string, dropping empties so shared links stay readable. */
export function toQuery(filters: Partial<Filters>): string {
  const params = new URLSearchParams();
  const add = (key: string, value: string | number | boolean | undefined) => {
    if (value === undefined || value === '' || value === false) return;
    if (key === 'page' && value === 1) return;
    if (key === 'sort' && value === 'roles') return;
    params.set(key, value === true ? '1' : String(value));
  };
  add('country', filters.country);
  add('city', filters.city);
  add('band', filters.band);
  add('ta', filters.ta);
  add('domain', filters.domain);
  add('signal', filters.signal);
  add('q', filters.q);
  add('parked', filters.parked);
  add('sort', filters.sort);
  add('page', filters.page);
  const query = params.toString();
  return query ? `?${query}` : '';
}
