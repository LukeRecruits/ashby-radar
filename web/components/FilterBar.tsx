/**
 * A plain GET form. Submitting it navigates, so every filter combination is a URL, the
 * back button works, and a segment Luke wants again is a bookmark rather than six clicks.
 *
 * `page` is deliberately not a field: changing a filter should return you to page one
 * rather than to page four of a list that no longer has four pages.
 */

import { SIGNALS, SORTS, type Facet, type Filters } from '@/lib/leads';

const FIELD =
  'h-9 rounded-md border px-2 text-[13px] bg-[var(--panel)] border-[var(--line-strong)] ' +
  'text-[var(--ink)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--ink-faint)]">
      {children}
    </span>
  );
}

export function FilterBar({
  filters,
  countries,
  cities,
  resultCount,
}: {
  filters: Filters;
  countries: Facet[];
  cities: Facet[];
  resultCount: number;
}) {
  return (
    <form
      method="get"
      className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0">
          <Label>Country</Label>
          <select name="country" defaultValue={filters.country} className={`${FIELD} max-w-[13rem]`}>
            <option value="">Anywhere</option>
            {countries.map((c) => (
              <option key={c.value} value={c.value}>
                {c.value} ({c.companies})
              </option>
            ))}
          </select>
        </label>

        <label className="min-w-0">
          <Label>City</Label>
          <select name="city" defaultValue={filters.city} className={`${FIELD} max-w-[13rem]`}>
            <option value="">Any city</option>
            {cities.map((c) => (
              <option key={c.value} value={c.value}>
                {c.value} ({c.companies})
              </option>
            ))}
          </select>
        </label>

        <label>
          <Label>Open roles</Label>
          <select name="band" defaultValue={filters.band} className={FIELD}>
            <option value="">Any size</option>
            <option value="target">5 to 50</option>
            <option value="small">1 to 4</option>
            <option value="large">51 or more</option>
            <option value="none">None open</option>
          </select>
        </label>

        <label>
          <Label>Recruiter req</Label>
          <select name="ta" defaultValue={filters.ta} className={FIELD}>
            <option value="">Either way</option>
            <option value="none">None open</option>
            <option value="has">Hiring a recruiter</option>
          </select>
        </label>

        <label>
          <Label>Domain</Label>
          <select name="domain" defaultValue={filters.domain} className={FIELD}>
            <option value="">Either way</option>
            <option value="has">Resolved</option>
            <option value="missing">Needs a domain</option>
          </select>
        </label>

        <label>
          <Label>Signal</Label>
          <select name="signal" defaultValue={filters.signal} className={FIELD}>
            <option value="">Any or none</option>
            {SIGNALS.map((s) => (
              <option key={s.type} value={s.type}>
                {s.label}
              </option>
            ))}
            <option value="none">No signal yet</option>
          </select>
        </label>

        <label className="min-w-0 flex-1">
          <Label>Search</Label>
          <input
            type="search"
            name="q"
            defaultValue={filters.q}
            placeholder="Company or board name"
            className={`${FIELD} w-full min-w-[11rem]`}
          />
        </label>

        <label>
          <Label>Sort</Label>
          <select name="sort" defaultValue={filters.sort} className={FIELD}>
            {Object.entries(SORTS).map(([key, sort]) => (
              <option key={key} value={key}>
                {sort.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          className="h-9 rounded-md bg-[var(--accent)] px-4 text-[13px] font-medium text-white hover:opacity-90"
        >
          Apply
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-2.5">
        <label className="flex items-center gap-2 text-[13px] text-[var(--ink-soft)]">
          <input
            type="checkbox"
            name="parked"
            value="1"
            defaultChecked={filters.parked}
            className="size-3.5 accent-[var(--accent)]"
          />
          Include companies I have parked
        </label>

        <div className="flex items-center gap-3 text-[13px]">
          <span className="nums text-[var(--ink-soft)]">
            {resultCount.toLocaleString('en-GB')} matching
          </span>
          <a href="/" className="text-[var(--accent)] hover:underline">
            Clear all
          </a>
        </div>
      </div>
    </form>
  );
}
