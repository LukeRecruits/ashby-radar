/**
 * One company, in enough detail to decide whether to spend an invitation on it.
 *
 * The list page answers "who looks interesting". This answers the next question, which is
 * the one that actually costs something: LinkedIn allows about a hundred invitations a
 * rolling week, so every row opened here is a decision, and the page is laid out as the
 * case for and against rather than as a dump of the record.
 *
 * Reads seven shaped views. Six of them it only reads; the seventh, `lead_contacts`, is
 * paired with four named database functions that are the only writes this console can
 * make. The publishable key still cannot write a row by itself, which migration 0012 made
 * true after 0011 proved it was not, and 0013 kept true by putting the write path behind
 * a secret the key does not contain.
 *
 * The contacts panel is the one part of this page that concerns a person. It finds them
 * on demand and stores nobody until asked; see components/Contacts.tsx and
 * docs/prospecting-lia.md.
 */

import { notFound } from 'next/navigation';

import { Breakdown } from '@/components/Breakdown';
import { Contacts } from '@/components/Contacts';
import { Evidence } from '@/components/Evidence';
import { RoleList } from '@/components/RoleList';
import { Trend } from '@/components/Trend';
import { fetchContacts } from '@/lib/contacts';
import { findTalentContacts, type LookupResult } from '@/lib/exa';
import {
  ROLE_SAMPLE,
  WORKPLACE_LABELS,
  fetchCompany,
  groupsOf,
  isCompanyId,
  workplaceSplit,
  type Group,
} from '@/lib/company';

export const dynamic = 'force-dynamic';

function dateOf(iso: string | null, withYear = true): string {
  if (!iso) return 'Not stated';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Not stated';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

function Stat({
  label,
  value,
  note,
  hint,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  hint?: string;
  tone?: 'warm' | 'good';
}) {
  const colour =
    tone === 'warm' ? 'var(--warm)' : tone === 'good' ? 'var(--good)' : 'var(--ink)';
  return (
    <div title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">
        {label}
      </div>
      <div className="nums mt-0.5 text-lg font-semibold leading-tight" style={{ color: colour }}>
        {value}
      </div>
      {note ? (
        <div className="mt-0.5 text-[11px] text-[var(--ink-soft)]">{note}</div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">
        {label}
      </dt>
      <dd className="mt-0.5 text-[13px]">{children}</dd>
    </div>
  );
}

/**
 * How we came to believe this domain belongs to this company, in words.
 *
 * Confidence 100 means the company's own careers page links back to this Ashby board,
 * which is proof. Anything lower is a name match, which is a guess, and the difference
 * matters a great deal when the next step is addressing a stranger by their employer.
 */
function domainProvenance(
  confidence: number | null,
  source: string | null,
): { verdict: string; detail: string } {
  if (confidence === 100) {
    return {
      verdict: 'Proved',
      detail: `Their careers page links back to this Ashby board${
        source ? ` (${source})` : ''
      }. This is the company.`,
    };
  }
  if (confidence !== null) {
    return {
      verdict: `Matched, confidence ${confidence}`,
      detail: `Inferred from the company name${
        source ? ` via ${source}` : ''
      }, not confirmed against their site. Worth a glance before using it.`,
    };
  }
  return {
    verdict: 'Unverified',
    detail: source
      ? `Recorded from ${source} with no confidence score.`
      : 'No provenance recorded.',
  };
}

export default async function CompanyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!isCompanyId(id)) notFound();

  const [page, query, contacts] = await Promise.all([
    fetchCompany(id),
    searchParams,
    fetchContacts(id),
  ]);
  if (!page) notFound();

  const { company, groups, history, signals, oldestRoles, newestRoles } = page;

  // The list's own query string, handed over in `from`, so "back to the list" returns to
  // the segment Luke was working rather than to an unfiltered first page. Only the search
  // part is kept: anything else in there would be someone else's URL.
  const from = Array.isArray(query.from) ? query.from[0] : query.from;
  const backTo = from && from.startsWith('?') ? from : '';

  // The panel's URLs. `back` is this page with the list's filters kept and the transient
  // flags dropped, so a redirect after a write lands exactly here rather than on an
  // unfiltered page, and a refresh does not re-run the search or re-show a stale message.
  const back = `/company/${id}${backTo}`;
  const findHref = `${back}${backTo ? '&' : '?'}find=1`;

  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() ?? '';

  // The search runs during this render, only when asked for by name. It costs about
  // $0.004 and stores nothing, so the only thing to guard against is running it by
  // accident.
  const lookup: LookupResult | null =
    one(query.find) === '1'
      ? await findTalentContacts(company.label, company.domain)
      : null;

  const err = one(query.err);
  const ok = one(query.ok);
  const message = err
    ? ({ kind: 'err', text: err } as const)
    : ok
      ? ({ kind: 'ok', text: ok } as const)
      : null;

  const departments = groupsOf(groups, 'department');
  const cities = groupsOf(groups, 'city');
  const countries = groupsOf(groups, 'country');
  const workplace = workplaceSplit(groups);

  const payShare =
    company.open_roles > 0
      ? Math.round((company.roles_with_pay / company.open_roles) * 100)
      : null;

  const provenance = domainProvenance(company.domain_confidence, company.domain_source);

  const change = company.open_roles_change_30d;
  const linkedinSearch = `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(
    company.label,
  )}`;

  return (
    <main className="mx-auto max-w-[1100px] px-4 py-6">
      <nav className="mb-4 text-[13px]">
        <a
          href={`/${backTo}`}
          className="text-[var(--ink-soft)] hover:text-[var(--accent)] hover:underline"
        >
          ← {backTo ? 'Back to the filtered list' : 'Back to the lead list'}
        </a>
      </nav>

      <header className="border-b border-[var(--line)] pb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{company.label}</h1>
            <p className="mt-1 text-[13px] text-[var(--ink-soft)]">
              {company.top_locality || company.top_country ? (
                <>
                  Hiring mostly in{' '}
                  {[company.top_locality, company.top_country].filter(Boolean).join(', ')}
                </>
              ) : (
                'No location on its open roles'
              )}
              {company.remote_share !== null ? (
                <>
                  {' · '}
                  <span className="nums">{company.remote_share}%</span> of stated roles
                  fully remote
                </>
              ) : null}
            </p>
            {company.display_name && company.display_name !== company.board_name ? (
              <p className="mt-0.5 text-[11px] text-[var(--ink-faint)]">
                Ashby board: <span className="nums">{company.board_name}</span>
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            {company.status !== 'active' ? (
              <span
                className="rounded border px-2 py-1"
                style={{ borderColor: 'var(--warm)', color: 'var(--warm)' }}
                title="Status on Ashby, from the last successful check"
              >
                {company.status === 'inactive'
                  ? 'Left Ashby'
                  : company.status === 'not_found'
                    ? 'Board not found'
                    : 'Unverified'}
              </span>
            ) : null}
            {company.parked_at ? (
              <span
                className="rounded border border-[var(--line-strong)] px-2 py-1 text-[var(--ink-soft)]"
                title={company.parked_reason ?? 'Set aside by hand'}
              >
                Parked {dateOf(company.parked_at, false)}
              </span>
            ) : null}
            <a
              href={company.board_url}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-md border border-[var(--line-strong)] px-3 py-1.5 hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Ashby board
            </a>
            {company.domain ? (
              <a
                href={`https://${company.domain}`}
                target="_blank"
                rel="noreferrer noopener"
                className="rounded-md border border-[var(--line-strong)] px-3 py-1.5 hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                {company.domain}
              </a>
            ) : null}
            <a
              href={linkedinSearch}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-md border border-[var(--line-strong)] px-3 py-1.5 hover:border-[var(--accent)] hover:text-[var(--accent)]"
              title="Search LinkedIn for this company by name"
            >
              Find on LinkedIn
            </a>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-x-9 gap-y-4">
          <Stat
            label="Open roles"
            value={company.open_roles.toLocaleString('en-GB')}
            note={
              company.role_band === 'target'
                ? 'In the 5 to 50 band'
                : company.role_band === 'none'
                  ? 'Nothing published today'
                  : company.role_band === 'small'
                    ? 'Below the band'
                    : 'Above the band'
            }
            hint={`From the snapshot of ${dateOf(company.snapshot_date)}`}
            tone={company.role_band === 'target' ? 'good' : undefined}
          />
          <Stat
            label="30-day change"
            value={change === null ? '–' : change > 0 ? `+${change}` : String(change)}
            note={
              change === null
                ? 'No baseline yet'
                : `From ${company.open_roles_30d_ago} on the baseline`
            }
            hint={
              change === null
                ? 'Needs a snapshot about 30 days old. History started on 30 September 2026.'
                : undefined
            }
            tone={change !== null && change > 0 ? 'good' : undefined}
          />
          <Stat
            label="Recruiter req"
            value={company.recruiter_roles > 0 ? `${company.recruiter_roles} open` : 'None open'}
            note={
              company.recruiter_roles > 0
                ? 'Hiring for their talent team'
                : 'Not hiring a recruiter today'
            }
            hint="Whether a recruiting role is open on their board right now. It is not evidence that they have no talent team: Synthesia has a Head of Talent and ten people under them, and no open recruiter req."
            tone={company.recruiter_roles > 0 ? undefined : 'warm'}
          />
          <Stat
            label="Pay published"
            value={payShare === null ? '–' : `${payShare}%`}
            note={
              payShare === null
                ? 'No open roles'
                : `${company.roles_with_pay} of ${company.open_roles} roles`
            }
          />
          <Stat
            label="Stalling"
            value={company.stale_roles_120.toLocaleString('en-GB')}
            note={
              company.stale_roles_120 === 0
                ? 'Nothing past 120 days'
                : `${company.stale_roles_180} past 180 days`
            }
            hint="Roles open 120 days or more, the threshold behind the stalling signal"
            tone={company.stale_roles_120 > 0 ? 'warm' : undefined}
          />
          <Stat
            label="Oldest open role"
            value={
              company.oldest_open_role_at
                ? dateOf(company.oldest_open_role_at, false)
                : '–'
            }
            note={
              company.oldest_open_role_at
                ? new Date(company.oldest_open_role_at).getUTCFullYear().toString()
                : 'No open roles'
            }
          />
        </div>
      </header>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[13px] font-semibold tracking-tight">Open roles over time</h2>
            <span className="text-[11px] text-[var(--ink-faint)]">
              One snapshot per morning, 120 days
            </span>
          </div>
          <Trend history={history} />
        </section>

        <Evidence signals={signals} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Breakdown
          title="Roles by department"
          rows={departments.rows}
          total={departments.total}
          empty="No open roles to break down."
        />
        <Breakdown
          title="Roles by city"
          rows={cities.rows}
          total={cities.total}
          empty="No open roles to break down."
        />
        <Breakdown
          title="Roles by country"
          rows={countries.rows}
          total={countries.total}
          empty="No open roles to break down."
        />
        <Breakdown
          title="Remote, hybrid and on-site"
          rows={workplace.rows.map(
            (row): Group => ({
              ...row,
              value: WORKPLACE_LABELS[row.value] ?? row.value,
            }),
          )}
          total={workplace.total}
          empty="No open roles to break down."
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <RoleList
          title="Longest open"
          note={`Oldest ${ROLE_SAMPLE}`}
          roles={oldestRoles}
        />
        <RoleList
          title="Most recently posted"
          note={`Newest ${ROLE_SAMPLE}`}
          roles={newestRoles}
        />
      </div>

      <Contacts
        companyId={company.id}
        companyLabel={company.label}
        contacts={contacts}
        lookup={lookup}
        back={back}
        findHref={findHref}
        message={message}
      />

      <section className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
        <h2 className="mb-3 text-[13px] font-semibold tracking-tight">
          How we know about this company
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Domain">
            {company.domain ? (
              <>
                <a
                  href={`https://${company.domain}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:text-[var(--accent)] hover:underline"
                >
                  {company.domain}
                </a>
                <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">
                  {provenance.verdict}. {provenance.detail}
                </div>
              </>
            ) : (
              <>
                <span style={{ color: 'var(--warm)' }}>None resolved</span>
                <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">
                  Nothing in their adverts links back to a site we could read. These are
                  being filled by hand rather than guessed from the name.
                </div>
              </>
            )}
          </Field>
          <Field label="Found via">
            {company.discovered_via ?? 'Not stated'}
            <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">
              First seen {dateOf(company.first_seen_at)}
            </div>
          </Field>
          <Field label="Last checked">
            {dateOf(company.last_checked_at)}
            <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">
              Last live {dateOf(company.last_active_at)}
            </div>
          </Field>
          <Field label="Latest snapshot">
            {dateOf(company.snapshot_date)}
            <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">
              {history.length === 1
                ? '1 snapshot held'
                : `${history.length} snapshots held`}
            </div>
          </Field>
        </dl>
      </section>
    </main>
  );
}
