/**
 * Reading one company, for the page that decides whether it is worth an invitation.
 *
 * The lead list answers "who looks interesting". This answers "what is actually going on
 * here", which is a different read: the roles broken down, the history behind the 30-day
 * number, and the evidence attached to each signal rather than the fact that one fired.
 *
 * Five reads, all in parallel, all keyed on company_id. Each hits one of the views added
 * in migration 0011 and none of them can write: `anon` holds select and nothing else on
 * all six lead views and nothing at all on the base tables, which 0012 made true after
 * 0011 proved it was not.
 */

import { db } from './supabase';
import { SIGNALS, type Lead, type SignalType } from './leads';

/** The oldest open roles, which is the list worth reading aloud on a call. */
export const ROLE_SAMPLE = 12;

/** Groups past this get folded into "Other", so a 33-department board stays scannable. */
export const GROUP_LIMIT = 8;

/**
 * `external_job_id` is the ATS's own id, the key for every source. `ashby_job_id` is a
 * uuid and null for Greenhouse, whose ids are integers. `ashby_job_url` predates
 * Greenhouse and is the job's URL whatever the source.
 */
export type Role = {
  external_job_id: string;
  ashby_job_id: string | null;
  title: string | null;
  department: string | null;
  team: string | null;
  address_country: string | null;
  address_locality: string | null;
  workplace_type: string | null;
  employment_type: string | null;
  has_compensation: boolean;
  published_at: string | null;
  age_days: number | null;
  ashby_job_url: string;
};

export type Group = {
  kind: 'department' | 'city' | 'country' | 'workplace';
  value: string;
  roles: number;
  stale_roles: number;
  roles_with_pay: number;
};

export type Day = {
  snapshot_date: string;
  open_role_count: number;
  recruiter_role_count: number;
  comp_published_count: number;
};

export type Signal = {
  id: string;
  type: SignalType;
  fired_at: string;
  evidence: Record<string, unknown>;
  reviewed: boolean;
};

const LEAD_COLUMNS =
  'id, label, display_name, board_name, board_url, source, status, domain, domain_confidence, ' +
  'domain_source, top_country, top_locality, remote_share, discovered_via, ' +
  'first_seen_at, last_checked_at, last_active_at, parked_at, parked_reason, ' +
  'snapshot_date, open_roles, recruiter_roles, roles_with_pay, open_roles_30d_ago, ' +
  'open_roles_change_30d, stale_roles_120, stale_roles_180, oldest_open_role_at, ' +
  'signal_count, role_band, has_in_house_ta, new_to_ashby_at, hiring_spike_at, ' +
  'first_recruiter_at, sweet_spot_at, long_open_at, publishes_comp_at';

const ROLE_COLUMNS =
  'external_job_id, ashby_job_id, title, department, team, address_country, ' +
  'address_locality, workplace_type, employment_type, has_compensation, published_at, ' +
  'age_days, ashby_job_url';

/** The lead row, plus the fields the list page has no column for. */
export type Company = Lead & {
  display_name: string | null;
  status: string;
  domain_source: string | null;
  discovered_via: string | null;
  last_checked_at: string | null;
  last_active_at: string | null;
  snapshot_date: string | null;
  open_roles_30d_ago: number | null;
  stale_roles_180: number;
  oldest_open_role_at: string | null;
  role_band: 'none' | 'small' | 'target' | 'large';
  has_in_house_ta: boolean;
};

export type CompanyPage = {
  company: Company;
  groups: Group[];
  history: Day[];
  signals: Signal[];
  oldestRoles: Role[];
  newestRoles: Role[];
};

/**
 * A guard on the path segment before it reaches PostgREST. `company_id` is a uuid, so
 * anything that is not one is a 404 rather than a database round trip and an error page.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCompanyId(value: string): boolean {
  return UUID.test(value);
}

export async function fetchCompany(id: string): Promise<CompanyPage | null> {
  if (!isCompanyId(id)) return null;

  const [lead, groups, history, signals, oldest, newest] = await Promise.all([
    db().from('lead_list').select(LEAD_COLUMNS).eq('id', id).maybeSingle(),

    // Every breakdown in one read. Ordering by roles here rather than in the application
    // means the fold into "Other" keeps the biggest groups, whatever the kind.
    db()
      .from('lead_role_groups')
      .select('kind, value, roles, stale_roles, roles_with_pay')
      .eq('company_id', id)
      .order('roles', { ascending: false })
      .order('value', { ascending: true }),

    db()
      .from('lead_history')
      .select('snapshot_date, open_role_count, recruiter_role_count, comp_published_count')
      .eq('company_id', id)
      .order('snapshot_date', { ascending: true }),

    db()
      .from('lead_signals')
      .select('id, type, fired_at, evidence, reviewed')
      .eq('company_id', id)
      .order('fired_at', { ascending: false }),

    // The two ends of the board. The oldest roles are the conversation ("you have had
    // this open since April"); the newest are what the company is doing right now.
    db()
      .from('lead_roles')
      .select(ROLE_COLUMNS)
      .eq('company_id', id)
      .order('published_at', { ascending: true, nullsFirst: false })
      .limit(ROLE_SAMPLE),

    db()
      .from('lead_roles')
      .select(ROLE_COLUMNS)
      .eq('company_id', id)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(ROLE_SAMPLE),
  ]);

  for (const [name, result] of [
    ['lead_list', lead],
    ['lead_role_groups', groups],
    ['lead_history', history],
    ['lead_signals', signals],
    ['lead_roles', oldest],
    ['lead_roles', newest],
  ] as const) {
    if (result.error) throw new Error(`${name} read failed: ${result.error.message}`);
  }

  if (!lead.data) return null;

  return {
    company: lead.data as unknown as Company,
    groups: (groups.data ?? []) as unknown as Group[],
    history: (history.data ?? []) as unknown as Day[],
    signals: (signals.data ?? []) as unknown as Signal[],
    oldestRoles: (oldest.data ?? []) as unknown as Role[],
    newestRoles: (newest.data ?? []) as unknown as Role[],
  };
}

/**
 * The top groups of one kind, with the tail folded into a single "Other" row.
 *
 * A 33-department board is real (OpenAI) and a bar chart of 33 bars answers nothing.
 * Folding keeps the total honest: the bars plus Other always sum to the open-role count,
 * so the chart cannot quietly disagree with the number in the header.
 */
export function groupsOf(
  groups: Group[],
  kind: Group['kind'],
  limit = GROUP_LIMIT,
): { rows: Group[]; total: number } {
  const all = groups.filter((g) => g.kind === kind);
  const total = all.reduce((sum, g) => sum + g.roles, 0);
  if (all.length <= limit) return { rows: all, total };

  const head = all.slice(0, limit - 1);
  const tail = all.slice(limit - 1);
  head.push({
    kind,
    value: `Other (${tail.length} more)`,
    roles: tail.reduce((sum, g) => sum + g.roles, 0),
    stale_roles: tail.reduce((sum, g) => sum + g.stale_roles, 0),
    roles_with_pay: tail.reduce((sum, g) => sum + g.roles_with_pay, 0),
  });
  return { rows: head, total };
}

/**
 * The workplace split as the three states Ashby actually distinguishes, in a fixed order
 * so the shape of one company is comparable with the next.
 *
 * Fixed order matters more than it looks: ordering these by size would mean a company's
 * remote bar moves position depending on how remote it is, and the eye then has to read
 * the labels every time instead of the lengths.
 */
export const WORKPLACE_ORDER = ['Remote', 'Hybrid', 'OnSite', 'Not stated'] as const;

export const WORKPLACE_LABELS: Record<string, string> = {
  Remote: 'Remote',
  Hybrid: 'Hybrid',
  OnSite: 'On-site',
  'Not stated': 'Not stated',
};

export function workplaceSplit(groups: Group[]): { rows: Group[]; total: number } {
  const found = groups.filter((g) => g.kind === 'workplace');
  const total = found.reduce((sum, g) => sum + g.roles, 0);
  const rows = WORKPLACE_ORDER.map(
    (value) => found.find((g) => g.value === value) ?? null,
  ).filter((g): g is Group => g !== null);
  return { rows, total };
}

export function signalMeta(type: SignalType) {
  return SIGNALS.find((s) => s.type === type);
}
