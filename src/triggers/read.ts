/**
 * Reading triggers back out, with the company attached. Shared by the digest, the Clay
 * hand-off and the CSV exports so all three describe a trigger the same way.
 */

import { config } from '../config.ts';
import { boardPageUrl, companyLabel, type CompanyRef } from '../lib/company.ts';
import { supabase } from '../lib/supabase.ts';
import type { TriggerType } from './rules.ts';

export type TriggerRow = {
  id: string;
  type: TriggerType;
  fired_at: string;
  evidence: Record<string, unknown>;
  reviewed: boolean;
  exported_at: string | null;
  companies: CompanyRef;
};

export type TriggerQuery = {
  /** Exclusive lower bound on fired_at. */
  since?: string;
  /** Exclusive upper bound on fired_at. */
  until?: string;
  unexportedOnly?: boolean;
  /** Stops after this many rows. Used by the Clay push to drain its backlog slowly. */
  limit?: number;
};

const SELECT =
  'id, type, fired_at, evidence, reviewed, exported_at, companies!inner(id, board_name, display_name, domain)';

export async function loadTriggers(query: TriggerQuery = {}): Promise<TriggerRow[]> {
  const pageSize = config.exports.pageSize;
  const rows: TriggerRow[] = [];

  // Advances by what came back and stops on an empty page, for the same reason
  // fetchAllPages does: PostgREST can cap a page below the size asked for.
  for (let from = 0; ; ) {
    const remaining = query.limit ? query.limit - rows.length : pageSize;
    if (remaining <= 0) break;
    const size = Math.min(pageSize, remaining);

    let builder = supabase().from('triggers').select(SELECT);
    if (query.since) builder = builder.gt('fired_at', query.since);
    if (query.until) builder = builder.lt('fired_at', query.until);
    if (query.unexportedOnly) builder = builder.is('exported_at', null);

    const { data, error } = await builder
      .order('fired_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw new Error(`triggers query failed: ${error.message}`);

    const batch = (data ?? []) as unknown as TriggerRow[];
    if (batch.length === 0) break;
    rows.push(...batch);
    from += batch.length;
  }

  return rows;
}

/** Everything a downstream consumer needs to act on one trigger. */
export function triggerView(row: TriggerRow) {
  const evidence = row.evidence ?? {};
  return {
    id: row.id,
    type: row.type,
    firedAt: row.fired_at,
    company: companyLabel(row.companies),
    boardName: row.companies.board_name,
    boardUrl: boardPageUrl(row.companies.board_name),
    domain: row.companies.domain,
    openRoles: typeof evidence.openRoles === 'number' ? evidence.openRoles : null,
    evidence,
  };
}
