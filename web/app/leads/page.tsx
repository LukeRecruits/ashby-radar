/**
 * The lead list: every company Radar knows about, filtered.
 *
 * It used to be the front door. The work queue is, now that there is a funnel to work:
 * the list is where the queue gets fed from, which is a weekly job rather than a daily
 * one.
 *
 * Everything is read in a server component, so the Supabase key never reaches the
 * browser and there is no loading state to design. Filters live in the URL, which makes
 * a segment shareable and the back button correct.
 */

import { FilterBar } from '@/components/FilterBar';
import { LeadTable } from '@/components/LeadTable';
import { Nav } from '@/components/Nav';
import {
  PAGE_SIZE,
  fetchFacets,
  fetchLeads,
  fetchTotals,
  parseFilters,
  toQuery,
} from '@/lib/leads';

// The underlying data changes once a day, but a stale lead list is worse than a slow one
// when the next thing Luke does is act on a row. Always fresh.
export const dynamic = 'force-dynamic';

function Total({ value, label, hint }: { value: number; label: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="nums text-lg font-semibold leading-tight">
        {value.toLocaleString('en-GB')}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">
        {label}
      </div>
    </div>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseFilters(await searchParams);

  const [{ rows, total }, facets, totals] = await Promise.all([
    fetchLeads(filters),
    fetchFacets(),
    fetchTotals(),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6">
      <Nav current="/leads" />
      <header className="mb-5 flex flex-wrap items-end justify-between gap-6 border-b border-[var(--line)] pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ashby Radar</h1>
          <p className="mt-0.5 text-[13px] text-[var(--ink-soft)]">
            Companies running Ashby or Greenhouse, and which of them are worth a conversation.
          </p>
        </div>
        <div className="flex gap-7">
          <Total value={totals.live} label="Live boards" hint="Active on their ATS today, Ashby and Greenhouse together" />
          <Total
            value={totals.prospects}
            label="Contactable"
            hint="Live, with a domain, not parked"
          />
          <Total
            value={totals.inBand}
            label="5 to 50 roles"
            hint="Contactable and the size CandidHQ sells into"
          />
          <Total
            value={totals.noDomain}
            label="Need a domain"
            hint="Live but no domain resolved yet"
          />
        </div>
      </header>

      <FilterBar
        filters={filters}
        countries={facets.countries}
        cities={facets.cities}
        resultCount={total}
      />

      <div className="mt-4">
        {/* The current segment, handed to each row so the company page can offer a way
            back into it rather than back to an unfiltered list. */}
        <LeadTable rows={rows} backQuery={toQuery({ ...filters, page })} />
      </div>

      <nav className="mt-4 flex items-center justify-between text-[13px]">
        <span className="nums text-[var(--ink-soft)]">
          {total === 0
            ? 'No companies'
            : `${first.toLocaleString('en-GB')}–${last.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')}`}
        </span>
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <a
              href={toQuery({ ...filters, page: page - 1 })}
              className="rounded-md border border-[var(--line-strong)] px-3 py-1.5 hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Previous
            </a>
          ) : null}
          <span className="nums text-[var(--ink-faint)]">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <a
              href={toQuery({ ...filters, page: page + 1 })}
              className="rounded-md border border-[var(--line-strong)] px-3 py-1.5 hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Next
            </a>
          ) : null}
        </div>
      </nav>
    </main>
  );
}
