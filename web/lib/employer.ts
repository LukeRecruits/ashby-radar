/**
 * Is this person actually at this company, today?
 *
 * The filter the whole contact lookup rests on. A people search for Vertice came back
 * with people at STRATOS, CUBE and BigID: all real people, all plausible-looking, none
 * of them at Vertice. Addressing somebody by an employer they left is the one mistake
 * that cannot be recovered from in a first message, so anything we cannot confirm is
 * dropped rather than shown with a caveat.
 *
 * Confirmation means a work-history entry that is both current and at this company.
 */

export type WorkEntry = {
  title?: string | null;
  dates?: { from?: string | null; to?: string | null } | null;
  company?: { id?: string | null; name?: string | null } | null;
};

/** Suffixes that are part of a legal name and never part of how anybody says it. */
const LEGAL = /\b(inc|inc\.|llc|ltd|ltd\.|limited|corp|corporation|co|company|gmbh|bv|b\.v\.|ab|oy|as|plc|sa|s\.a\.|srl|pty|pte|holdings|group|technologies|technology|labs|software)\b/g;

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[&]/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The memorable part of a domain: synthesia.io -> synthesia, my-co.co.uk -> my co. */
function domainLabel(domain: string): string {
  return normalise(domain.replace(/^www\./, '').split('.')[0].replace(/-/g, ' '));
}

/**
 * Deliberately conservative. Equality, or one name's tokens contained in the other's,
 * and in the containment case at least one shared token has to be long enough to carry
 * meaning: without that, "Atlas" matches "Atlas Copco" and "The Group" matches anything.
 */
export function sameCompany(a: string, b: string): boolean {
  const left = normalise(a);
  const right = normalise(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.replace(/ /g, '') === right.replace(/ /g, '')) return true;

  const lt = new Set(left.split(' '));
  const rt = new Set(right.split(' '));
  const shared = [...lt].filter((t) => rt.has(t));
  if (shared.length === 0) return false;
  if (!shared.some((t) => t.length >= 4)) return false;

  return shared.length === lt.size || shared.length === rt.size;
}

function isOpenEnded(dates: WorkEntry['dates']): boolean {
  if (!dates) return true;
  const to = (dates.to ?? '').trim();
  return to === '' || /present|current|now/i.test(to);
}

export type EmployerCheck = {
  isCurrent: boolean;
  title: string | null;
  startedAt: string | null;
  reason: 'match' | 'other-employer' | 'no-history';
};

export function isCurrentEmployee(
  history: WorkEntry[],
  company: string,
  domain: string | null,
): EmployerCheck {
  if (!history.length) {
    return { isCurrent: false, title: null, startedAt: null, reason: 'no-history' };
  }

  const names = [company, ...(domain ? [domainLabel(domain)] : [])].filter(Boolean);

  const current = history
    .filter((entry) => isOpenEnded(entry.dates))
    .filter((entry) => {
      const employer = entry.company?.name?.trim();
      return employer ? names.some((name) => sameCompany(name, employer)) : false;
    })
    // Somebody promoted inside the company has two open-ended entries. The later start
    // is the current job, and a missing start date sorts last rather than first.
    .sort((a, b) => (b.dates?.from ?? '').localeCompare(a.dates?.from ?? ''));

  if (!current.length) {
    return { isCurrent: false, title: null, startedAt: null, reason: 'other-employer' };
  }

  return {
    isCurrent: true,
    title: current[0].title?.trim() || null,
    startedAt: current[0].dates?.from?.trim() || null,
    reason: 'match',
  };
}
