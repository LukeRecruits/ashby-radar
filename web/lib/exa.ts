/**
 * Finding the person who owns hiring at one company, on demand.
 *
 * This is the only part of Radar that looks up a human being, and it runs exactly once
 * per company, when Luke asks for it, after he has already decided the company is worth
 * an invitation. Nothing is stored by searching: the results live in the response of one
 * page render. A person reaches the database only when he presses Add, which is what
 * makes the data-minimisation claim in docs/prospecting-lia.md true rather than
 * aspirational.
 *
 * Exa's `people` category returns a structured `entities` array alongside the usual
 * result fields: name, location, and a work history with titles, employers and date
 * ranges. The work history is what makes the employer filter possible, and the employer
 * filter is the thing this cannot be trusted without. A people search for Vertice
 * returned people at STRATOS, CUBE and BigID, all of them real and none of them any use.
 *
 * Cost is about $0.004 a search, so the ~940 qualified companies cost under four pounds
 * all in. A page refresh with ?find=1 still in the URL runs it again, which is a few
 * tenths of a penny and worth not engineering around.
 */

import { isCurrentEmployee, type WorkEntry } from './employer';
import { readTitle, type TitleRead } from './titles';

const ENDPOINT = 'https://api.exa.ai/search';
const TIMEOUT_MS = 20_000;
const RESULTS = 10;

export type Candidate = {
  name: string;
  title: string | null;
  linkedinUrl: string;
  /** Normalised the same way the database does, so the panel can spot a duplicate. */
  key: string;
  /** Null when the work history gives no start date. */
  startedAt: string | null;
  read: TitleRead;
};

export type LookupResult =
  | { state: 'unconfigured' }
  | { state: 'error'; message: string }
  | {
      state: 'ok';
      candidates: Candidate[];
      /** Why the others were dropped, so an empty list is never just empty. */
      dropped: { otherEmployer: number; notTalent: number; unconfirmed: number };
      returned: number;
      withProfiles: number;
    };

/**
 * The same normalisation as `normalise_linkedin_url` in migration 0013, in TypeScript,
 * for one purpose: telling whether a candidate is already on the contact list before the
 * database is asked. The database remains the authority; if these two ever disagree the
 * database wins and the worst outcome is a duplicate Add that resolves to an upsert.
 */
export function profileKey(url: string): string | null {
  const m = url.trim().toLowerCase().match(/(?:^|\.|\/)linkedin\.com\/in\/([^/?#\s]+)/);
  return m ? `linkedin.com/in/${m[1]}` : null;
}

type ExaResult = {
  title?: string;
  url?: string;
  entities?: {
    type?: string;
    properties?: {
      name?: string | null;
      workHistory?: WorkEntry[];
    };
  }[];
};

/**
 * The query is written the way a person would ask, because that is what the category is
 * tuned for, and it names both wordings the market uses. The domain goes in when we have
 * one: company names collide ("Atlas", "Vertice") and a domain disambiguates far better
 * than any filter parameter would.
 */
function queryFor(company: string, domain: string | null): string {
  const where = domain ? `${company} (${domain})` : company;
  return `Head of Talent Acquisition, Head of People or recruiting lead at ${where}`;
}

export async function findTalentContacts(
  company: string,
  domain: string | null,
): Promise<LookupResult> {
  const key = process.env.EXA_API_KEY?.trim();
  if (!key) return { state: 'unconfigured' };

  let payload: { results?: ExaResult[] };
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: queryFor(company, domain),
        category: 'people',
        numResults: RESULTS,
        type: 'auto',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        state: 'error',
        message: `Exa returned ${response.status}. ${body.slice(0, 300)}`,
      };
    }
    payload = (await response.json()) as { results?: ExaResult[] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: 'error', message };
  }

  const results = payload.results ?? [];
  const dropped = { otherEmployer: 0, notTalent: 0, unconfirmed: 0 };
  const candidates: Candidate[] = [];
  let withProfiles = 0;

  for (const result of results) {
    const person = result.entities?.find((e) => e.type === 'person')?.properties;
    const url = result.url ?? '';
    const key = profileKey(url);
    if (!key) continue;

    if (!person) {
      // No structured profile, so the employer cannot be confirmed. Dropping is the only
      // safe answer: an unconfirmed person is exactly the failure this filter exists for.
      dropped.unconfirmed += 1;
      continue;
    }
    withProfiles += 1;

    const current = isCurrentEmployee(person.workHistory ?? [], company, domain);
    if (!current.isCurrent) {
      if (current.reason === 'no-history') dropped.unconfirmed += 1;
      else dropped.otherEmployer += 1;
      continue;
    }

    const read = readTitle(current.title);
    if (!read.isTalent) {
      dropped.notTalent += 1;
      continue;
    }

    candidates.push({
      // Falling back to the result title is worth it: Exa's page titles are
      // "Jane Doe - Synthesia - LinkedIn", so the first segment is the name.
      name: person.name?.trim() || (result.title ?? '').split(' - ')[0].trim() || 'Unknown',
      title: current.title,
      linkedinUrl: `https://www.${key}`,
      key,
      startedAt: current.startedAt,
      read,
    });
  }

  candidates.sort((a, b) => b.read.score - a.read.score || a.name.localeCompare(b.name));

  return {
    state: 'ok',
    candidates,
    dropped,
    returned: results.length,
    withProfiles,
  };
}
