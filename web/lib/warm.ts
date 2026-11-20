/**
 * The warm list (migration 0027): Luke's LinkedIn connections at Radar companies.
 *
 * Imported from his own LinkedIn data export by tools/warm_import.py, which matches on his
 * machine and sends only the connections at a Radar company. Two kinds of match: the
 * connection is a talent person the people sweep found (exact, on profile URL), or their
 * stated employer has a Radar company's name (`ambiguous` when the name fits several).
 */

import { db } from './supabase';

export type WarmCompany = {
  company_id: string;
  label: string;
  domain: string | null;
  source: string;
  open_roles: number;
  role_band: string;
  is_prospect: boolean;
  recruiter_roles: number;
  stale_roles_120: number;
  connections: number;
  talent_connections: number;
  profile_matches: number;
  all_ambiguous: boolean;
  newest_connected_on: string | null;
  imported_at: string | null;
  /** Active DDR newsletter subscribers at this company's domain. Who they are: fetchSubscribers. */
  subscribers: number;
};

export type WarmConnection = {
  company_id: string;
  full_name: string;
  position: string | null;
  linkedin_url: string;
  linkedin_key: string;
  connected_on: string | null;
  match_type: 'profile' | 'employer';
  ambiguous: boolean;
  is_talent: boolean;
};

const CONNECTION_COLUMNS =
  'company_id, full_name, position, linkedin_url, linkedin_key, connected_on, match_type, ambiguous, is_talent';

export type WarmScope = 'band' | 'all';

/**
 * Ranked the way the list gets worked: a connection who IS on the talent team first, then
 * any talent connection, then anybody who could introduce you.
 */
export async function fetchWarmCompanies(scope: WarmScope): Promise<WarmCompany[]> {
  const base = () => {
    let query = db()
      .from('lead_warm')
      .select(
        'company_id, label, domain, source, open_roles, role_band, is_prospect, recruiter_roles, ' +
          'stale_roles_120, connections, talent_connections, profile_matches, all_ambiguous, ' +
          'newest_connected_on, imported_at, subscribers',
      )
      .eq('status', 'active')
      .is('parked_at', null);
    if (scope === 'band') query = query.eq('is_prospect', true).eq('role_band', 'target');
    return query;
  };

  const out: WarmCompany[] = [];
  // Up to ~1,800 rows, so page past PostgREST's max-rows rather than trust one call.
  for (let from = 0; ; from += 1000) {
    const { data, error } = await base()
      .order('profile_matches', { ascending: false })
      .order('talent_connections', { ascending: false })
      .order('connections', { ascending: false })
      .order('company_id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`lead_warm read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as WarmCompany[];
    out.push(...rows);
    if (!rows.length) break;
  }
  return out;
}

/** Connections for a set of companies, talent people and exact matches first. */
export async function fetchWarmConnections(ids: string[]): Promise<Map<string, WarmConnection[]>> {
  const map = new Map<string, WarmConnection[]>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await db()
      .from('lead_warm_connections')
      .select(CONNECTION_COLUMNS)
      .in('company_id', ids.slice(i, i + 150))
      .order('match_type', { ascending: false })
      .order('is_talent', { ascending: false })
      .order('full_name', { ascending: true })
      .limit(5000);
    if (error) throw new Error(`lead_warm_connections read failed: ${error.message}`);
    for (const row of (data ?? []) as unknown as WarmConnection[]) {
      const list = map.get(row.company_id) ?? [];
      list.push(row);
      map.set(row.company_id, list);
    }
  }
  return map;
}

export function connectedYear(on: string | null): string | null {
  return on && /^\d{4}/.test(on) ? on.slice(0, 4) : null;
}

/** Active newsletter subscribers at one company, for the company page. */
export async function fetchSubscriberCount(id: string): Promise<number> {
  const { data, error } = await db().from('lead_warm').select('subscribers').eq('company_id', id).maybeSingle();
  if (error) throw new Error(`lead_warm read failed: ${error.message}`);
  return (data?.subscribers as number | undefined) ?? 0;
}

export type Subscriber = { email: string; subscribed_on: string | null };

/**
 * Who the subscribers are (migration 0029). The addresses are not on any anon view, since
 * the publishable key is public; the function checks the console's write token. Null when
 * the token is unset, so the page falls back to the count.
 */
export async function fetchSubscribers(id: string): Promise<Subscriber[] | null> {
  const token = process.env.CONSOLE_WRITE_TOKEN?.trim();
  if (!token) return null;
  const { data, error } = await db().rpc('company_subscriber_emails', { p_token: token, p_company_id: id });
  if (error) throw new Error(`company_subscriber_emails failed: ${error.message}`);
  return (data ?? []) as Subscriber[];
}

const letters = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');

/**
 * The beehiiv export has addresses, not names, so match the address to somebody already
 * known at the company: jane.smith@, janesmith@, jsmith@, jane@ and the like. Only a
 * single match counts; two people who both fit means no guess.
 */
export function guessSubscriber(email: string, names: string[]): string | null {
  const local = letters(email.split('@')[0] ?? '');
  if (local.length < 3) return null;
  const hits = new Set<string>();
  for (const name of names) {
    const parts = name.split(/\s+/).map(letters).filter(Boolean);
    if (parts.length < 2) continue;
    const first = parts[0];
    const last = parts[parts.length - 1];
    const forms = [first + last, first[0] + last, last + first, first + last[0], last, first];
    if (forms.some((f) => f.length >= 3 && f === local)) hits.add(name);
  }
  return hits.size === 1 ? [...hits][0] : null;
}
