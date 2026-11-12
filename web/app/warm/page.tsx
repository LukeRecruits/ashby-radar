/**
 * The warm list: companies on Radar where Luke already knows somebody.
 *
 * Replaces checking LinkedIn by hand, company by company. Built from his own LinkedIn
 * data export (tools/warm_import.py, migration 0027). Ranked so the first rows are the
 * cheapest conversations: somebody on their talent team he is already connected to, then
 * any talent connection, then anybody there who could introduce him. A connection costs
 * no invitation from the weekly hundred, which is the whole point.
 */

import { Nav } from '@/components/Nav';
import { connectedYear, fetchWarmCompanies, fetchWarmConnections, type WarmConnection, type WarmScope } from '@/lib/warm';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const SHOWN = 4;

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function href(scope: WarmScope, page: number): string {
  const params = new URLSearchParams();
  if (scope === 'all') params.set('scope', 'all');
  if (page > 1) params.set('page', String(page));
  const q = params.toString();
  return q ? `/warm?${q}` : '/warm';
}

function Person({ c }: { c: WarmConnection }) {
  const year = connectedYear(c.connected_on);
  return (
    <li className="leading-snug">
      <a
        href={c.linkedin_url}
        target="_blank"
        rel="noreferrer noopener"
        className={`hover:text-[var(--accent)] hover:underline ${c.is_talent ? 'font-medium' : ''}`}
      >
        {c.full_name}
      </a>
      <span className="text-[var(--ink-soft)]">{c.position ? ` · ${c.position}` : ''}</span>
      {c.match_type === 'profile' ? (
        <span className="ml-1.5 text-[11px] font-medium text-[var(--good)]" title="The people sweep found this person on their talent team, and you are connected">
          On their talent team
        </span>
      ) : null}
      {c.ambiguous ? (
        <span className="ml-1.5 text-[11px] text-[var(--warm)]" title="Their employer's name matches more than one company on Radar">
          Check employer
        </span>
      ) : null}
      {year ? <span className="ml-1.5 text-[11px] text-[var(--ink-faint)]">since {year}</span> : null}
    </li>
  );
}

const TH =
  'px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--ink-faint)] whitespace-nowrap';
const TD = 'px-3 py-2 align-top';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const scope: WarmScope = one(params.scope) === 'all' ? 'all' : 'band';
  const requested = Number.parseInt(one(params.page), 10);

  const companies = await fetchWarmCompanies(scope);
  const pages = Math.max(1, Math.ceil(companies.length / PAGE_SIZE));
  const page = Math.min(Number.isFinite(requested) && requested > 1 ? requested : 1, pages);
  const rows = companies.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const people = await fetchWarmConnections(rows.map((r) => r.company_id));

  const onTeam = companies.filter((c) => c.profile_matches > 0).length;
  const talent = companies.filter((c) => c.talent_connections > 0).length;
  const imported = companies[0]?.imported_at
    ? new Date(companies[0].imported_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const back = encodeURIComponent(href(scope, page));

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6">
      <Nav current="/warm" />
      <header className="mb-5 flex flex-wrap items-end justify-between gap-6 border-b border-[var(--line)] pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Warm list</h1>
          <p className="mt-0.5 text-[13px] text-[var(--ink-soft)]">
            Companies where you already know somebody, from your LinkedIn connections
            {imported ? ` (imported ${imported})` : ''}. A message, not an invitation.
          </p>
        </div>
        <div className="flex gap-7 text-center">
          <div>
            <div className="nums text-lg font-semibold leading-tight">{companies.length.toLocaleString('en-GB')}</div>
            <div className="text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">Companies</div>
          </div>
          <div title="You are connected to somebody the people sweep found on their talent team">
            <div className="nums text-lg font-semibold leading-tight text-[var(--good)]">{onTeam.toLocaleString('en-GB')}</div>
            <div className="text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">Know their talent team</div>
          </div>
          <div title="At least one connection there has a talent, people or recruiting title">
            <div className="nums text-lg font-semibold leading-tight">{talent.toLocaleString('en-GB')}</div>
            <div className="text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">A talent connection</div>
          </div>
        </div>
      </header>

      <div className="mb-3 flex gap-2 text-[13px]">
        {(['band', 'all'] as const).map((s) => (
          <a
            key={s}
            href={href(s, 1)}
            aria-current={scope === s ? 'page' : undefined}
            className={`rounded-md border px-3 py-1.5 ${
              scope === s
                ? 'border-[var(--accent)] font-medium text-[var(--accent)]'
                : 'border-[var(--line-strong)] text-[var(--ink-soft)] hover:border-[var(--accent)]'
            }`}
          >
            {s === 'band' ? 'Prospects, 5 to 50 roles' : 'Every live company'}
          </a>
        ))}
      </div>

      {rows.length ? (
        <div className="overflow-x-auto rounded-lg border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-[var(--line)]">
                <th className={TH}>Company</th>
                <th className={TH}>Who you know</th>
                <th className={`${TH} text-right`}>Open</th>
                <th className={TH}>Recruiter req</th>
                <th className={`${TH} text-right`}>Stalled</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const list = people.get(c.company_id) ?? [];
                return (
                  <tr key={c.company_id} className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--bg)]">
                    <td className={TD}>
                      <a
                        href={`/company/${c.company_id}?from=${back}`}
                        className="font-medium text-[var(--ink)] hover:text-[var(--accent)] hover:underline"
                      >
                        {c.label}
                      </a>
                      <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">
                        {c.domain ?? 'No domain yet'} · {c.connections} connection{c.connections === 1 ? '' : 's'}
                      </div>
                    </td>
                    <td className={TD}>
                      <ul className="space-y-0.5">
                        {list.slice(0, SHOWN).map((p) => (
                          <Person key={p.linkedin_key} c={p} />
                        ))}
                      </ul>
                      {list.length > SHOWN ? (
                        <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">
                          +{list.length - SHOWN} more on the company page
                        </div>
                      ) : null}
                    </td>
                    <td className={`${TD} nums text-right font-medium`}>{c.open_roles}</td>
                    <td className={TD}>
                      {c.recruiter_roles > 0 ? (
                        <span className="text-[var(--ink-soft)]">{c.recruiter_roles} open</span>
                      ) : (
                        <span className="font-medium text-[var(--warm)]">None open</span>
                      )}
                    </td>
                    <td className={`${TD} nums text-right`}>
                      {c.stale_roles_120 > 0 ? c.stale_roles_120 : <span className="text-[var(--ink-faint)]">&ndash;</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-10 text-center text-[13px] text-[var(--ink-soft)]">
          No connections imported yet. Run tools/warm_import.py against your LinkedIn export.
        </div>
      )}

      <nav className="mt-4 flex items-center justify-end gap-2 text-[13px]">
        {page > 1 ? (
          <a href={href(scope, page - 1)} className="rounded-md border border-[var(--line-strong)] px-3 py-1.5 hover:border-[var(--accent)] hover:text-[var(--accent)]">
            Previous
          </a>
        ) : null}
        <span className="nums text-[var(--ink-faint)]">Page {page} of {pages}</span>
        {page < pages ? (
          <a href={href(scope, page + 1)} className="rounded-md border border-[var(--line-strong)] px-3 py-1.5 hover:border-[var(--accent)] hover:text-[var(--accent)]">
            Next
          </a>
        ) : null}
      </nav>
    </main>
  );
}
