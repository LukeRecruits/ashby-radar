/**
 * Reading what the people sweep found (src/people/run.ts, migration 0025).
 *
 * `lead_people` is everyone on a company's talent and people team that survived the
 * employer and title filters. `lead_people_summary` is one row per searched company:
 * team size, the most senior person, and whether they are new in post. Neither is the
 * outreach pipeline; that is still `lead_contacts`, and Add copies a person across.
 */

import type { Candidate } from './exa';
import { readTitle } from './titles';
import { db } from './supabase';

export type PeopleSummary = {
  company_id: string;
  searched_at: string;
  people_count: number;
  senior_count: number;
  top_name: string | null;
  top_title: string | null;
  top_started_at: string | null;
  top_linkedin_url: string | null;
  new_leader: boolean;
};

export type StoredPeople = {
  searchedAt: string | null;
  people: Candidate[];
};

type Row = {
  full_name: string;
  job_title: string | null;
  linkedin_url: string;
  linkedin_key: string;
  started_at: string | null;
};

export async function fetchPeople(companyId: string): Promise<StoredPeople> {
  const [people, summary] = await Promise.all([
    db()
      .from('lead_people')
      .select('full_name, job_title, linkedin_url, linkedin_key, started_at')
      .eq('company_id', companyId)
      .order('rank', { ascending: false })
      .order('full_name', { ascending: true }),
    db().from('lead_people_summary').select('searched_at').eq('company_id', companyId).maybeSingle(),
  ]);
  if (people.error) throw new Error(`lead_people read failed: ${people.error.message}`);
  if (summary.error) throw new Error(`lead_people_summary read failed: ${summary.error.message}`);

  return {
    searchedAt: (summary.data?.searched_at as string | undefined) ?? null,
    // Shaped as the live search's candidates so the panel renders both the same way.
    people: ((people.data ?? []) as Row[]).map((p) => ({
      name: p.full_name,
      title: p.job_title,
      linkedinUrl: p.linkedin_url,
      key: p.linkedin_key,
      startedAt: p.started_at,
      read: readTitle(p.job_title),
    })),
  };
}

/** Summaries for one page of the lead list, keyed by company id. */
export async function fetchPeopleSummaries(ids: string[]): Promise<Map<string, PeopleSummary>> {
  if (!ids.length) return new Map();
  const { data, error } = await db()
    .from('lead_people_summary')
    .select(
      'company_id, searched_at, people_count, senior_count, top_name, top_title, ' +
        'top_started_at, top_linkedin_url, new_leader',
    )
    .in('company_id', ids);
  if (error) throw new Error(`lead_people_summary read failed: ${error.message}`);
  const rows = (data ?? []) as unknown as PeopleSummary[];
  return new Map(rows.map((r) => [r.company_id, r]));
}
