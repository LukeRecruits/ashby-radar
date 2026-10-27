/**
 * A plain GET form. Submitting it navigates, so every filter combination is a URL, the
 * back button works, and a segment Luke wants again is a bookmark rather than six clicks.
 *
 * ATS, country, city, open roles and signal are tick-box dropdowns: several values in one
 * filter widen it (UK or Ireland), different filters narrow each other.
 *
 * `page` is deliberately not a field: changing a filter should return you to page one
 * rather than to page four of a list that no longer has four pages.
 */

import { MultiSelect } from '@/components/MultiSelect';
import { ATS, BANDS, SIGNALS, SORTS, type Facet, type Filters } from '@/lib/leads';

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
        {/* Divs, not labels: a label around the dropdown would forward every click on
            it to the first checkbox inside. */}
        <div>
          <Label>ATS</Label>
          <MultiSelect
            name="ats"
            options={ATS.map((a) => ({ value: a.value, label: a.label }))}
            selected={filters.ats}
            anyLabel="Any ATS"
            noun="ATSs"
          />
        </div>

        <div className="min-w-0">
          <Label>Country</Label>
          <MultiSelect
            name="country"
            options={countries.map((c) => ({ value: c.value, label: c.value, count: c.companies }))}
            selected={filters.country}
            anyLabel="Anywhere"
            noun="countries"
          />
        </div>

        <div className="min-w-0">
          <Label>City</Label>
          <MultiSelect
            name="city"
            options={cities.map((c) => ({ value: c.value, label: c.value, count: c.companies }))}
            selected={filters.city}
            anyLabel="Any city"
            noun="cities"
          />
        </div>

        <div>
          <Label>Open roles</Label>
          <MultiSelect
            name="band"
            options={BANDS.map((b) => ({ value: b.value, label: b.label }))}
            selected={filters.band}
            anyLabel="Any size"
            noun="sizes"
          />
        </div>

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

        <div>
          <Label>Signal</Label>
          <MultiSelect
            name="signal"
            options={[
              ...SIGNALS.map((x) => ({ value: x.type, label: x.label })),
              { value: 'none', label: 'No signal yet' },
            ]}
            selected={filters.signal}
            anyLabel="Any or none"
            noun="signals"
          />
        </div>

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
          <a href="/leads" className="text-[var(--accent)] hover:underline">
            Clear all
          </a>
        </div>
      </div>
    </form>
  );
}
