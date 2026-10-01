/**
 * The contacts panel: who to message at this company, and the state of that decision.
 *
 * Everything here is a plain form posting to a server action, and the search itself is a
 * GET that puts `find=1` in the URL. No client components, no fetching in the browser,
 * and the page stays a link: a company page with the search already run is a URL that can
 * be reopened.
 *
 * Two separations matter and are deliberately visible in the UI:
 *
 *   * **Finding is not storing.** Candidates returned by the search are rendered from the
 *     response of this render and are gone when the page is closed. A person is written
 *     to the database only when Add is pressed, which is what the assessment relies on.
 *   * **Remove is not Suppress.** Remove takes a row out and a later search can find them
 *     again, which is what you want for a mis-added person. Suppress records an objection
 *     against the profile URL permanently, and no future search can put them back. The
 *     second is the one that answers "stop contacting me", so it says so.
 */

import type { Candidate, LookupResult } from '@/lib/exa';
import type { Contact } from '@/lib/contacts';
import { NO_REASONS, type FunnelRow } from '@/lib/queue';
import {
  addContactAction,
  deleteContactAction,
  setConnectionAction,
  setStageAction,
  suppressContactAction,
} from '@/app/actions';

const BUTTON =
  'rounded-md border border-[var(--line-strong)] px-2.5 py-1 text-[12px] hover:border-[var(--accent)] hover:text-[var(--accent)]';
const INPUT =
  'w-full rounded-md border border-[var(--line)] bg-[var(--bg)] px-2 py-1.5 text-[13px] placeholder:text-[var(--ink-faint)]';
const SELECT =
  'rounded-md border border-[var(--line)] bg-[var(--bg)] px-1.5 py-1 text-[12px]';

function since(iso: string | null): string | null {
  if (!iso) return null;
  // Exa gives these as YYYY-MM or a full date, and a month is all we want to say.
  const date = new Date(iso.length === 7 ? `${iso}-01T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-t border-[var(--line)] py-2.5 first:border-t-0">
      {children}
    </li>
  );
}

function Person({
  name,
  title,
  url,
  note,
}: {
  name: string;
  title: string | null;
  url: string;
  note?: React.ReactNode;
}) {
  return (
    <div className="min-w-[200px] flex-1">
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="text-[13px] font-medium hover:text-[var(--accent)] hover:underline"
      >
        {name}
      </a>
      <div className="mt-0.5 text-[12px] text-[var(--ink-soft)]">{title ?? 'No title'}</div>
      {note ? <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">{note}</div> : null}
    </div>
  );
}

/**
 * A saved contact, with the whole ladder available.
 *
 * The queue offers one button because it is a list to work through. This offers the full
 * picker, because the company page is where the cases the obvious move does not fit get
 * sorted out: somebody who replied to the invitation before accepting it, or a No that
 * needs reopening. The reason select only means anything for a No, and the database
 * discards it for every other stage rather than letting a stale explanation linger.
 */
function Saved({
  contact,
  back,
  stages,
}: {
  contact: Contact;
  back: string;
  stages: FunnelRow[];
}) {
  const days =
    contact.days_in_stage === 0
      ? 'today'
      : contact.days_in_stage === 1
        ? '1 day'
        : `${contact.days_in_stage} days`;

  return (
    <Row>
      <Person
        name={contact.full_name}
        title={contact.job_title}
        url={contact.linkedin_url}
        note={
          <>
            <span style={{ color: contact.needs_action ? 'var(--warm)' : undefined }}>
              {contact.stage_label}
            </span>
            {` for ${days}`}
            {contact.no_reason
              ? ` · ${NO_REASONS.find((r) => r.value === contact.no_reason)?.label ?? contact.no_reason}`
              : ''}
            {contact.is_connection ? ' · already connected' : ''}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <form action={setStageAction} className="flex items-center gap-1">
          <input type="hidden" name="contact_id" value={contact.id} />
          <input type="hidden" name="back" value={back} />
          <input type="hidden" name="said" value={`${contact.full_name} moved`} />
          <select name="stage" defaultValue={contact.stage} className={SELECT} aria-label="Stage">
            {stages.map((stage) => (
              <option key={stage.stage} value={stage.stage}>
                {stage.label}
              </option>
            ))}
          </select>
          <select name="reason" defaultValue="no_response" className={SELECT} aria-label="Reason, if closing">
            {NO_REASONS.map((reason) => (
              <option key={reason.value} value={reason.value}>
                {reason.label}
              </option>
            ))}
          </select>
          <button type="submit" className={BUTTON} title="Move them to this stage. The reason is only kept for a No.">
            Move
          </button>
        </form>
        <form action={setConnectionAction}>
          <input type="hidden" name="contact_id" value={contact.id} />
          <input type="hidden" name="value" value={contact.is_connection ? '0' : '1'} />
          <input type="hidden" name="back" value={back} />
          <button type="submit" className={BUTTON}>
            {contact.is_connection ? 'Not connected' : 'Already connected'}
          </button>
        </form>
        <form action={deleteContactAction}>
          <input type="hidden" name="contact_id" value={contact.id} />
          <input type="hidden" name="back" value={back} />
          <button type="submit" className={BUTTON} title="Take this row out. A later search can find them again.">
            Remove
          </button>
        </form>
        <form action={suppressContactAction}>
          <input type="hidden" name="linkedin_url" value={contact.linkedin_url} />
          <input type="hidden" name="reason" value="objection" />
          <input type="hidden" name="back" value={back} />
          <button
            type="submit"
            className={BUTTON}
            style={{ color: 'var(--warm)' }}
            title="They asked not to be contacted. Deletes them and blocks any future search from adding them back."
          >
            Objected
          </button>
        </form>
      </div>
    </Row>
  );
}

function Found({
  candidate,
  companyId,
  back,
  already,
}: {
  candidate: Candidate;
  companyId: string;
  back: string;
  already: boolean;
}) {
  const started = since(candidate.startedAt);
  return (
    <Row>
      <Person
        name={candidate.name}
        title={candidate.title}
        url={candidate.linkedinUrl}
        note={
          <>
            {candidate.read.note}
            {started ? ` · in post since ${started}` : ''}
          </>
        }
      />
      {already ? (
        <span className="text-[12px] text-[var(--ink-faint)]">Already on the list</span>
      ) : (
        <form action={addContactAction} className="flex items-center gap-1.5">
          <input type="hidden" name="company_id" value={companyId} />
          <input type="hidden" name="full_name" value={candidate.name} />
          <input type="hidden" name="job_title" value={candidate.title ?? ''} />
          <input type="hidden" name="linkedin_url" value={candidate.linkedinUrl} />
          <input type="hidden" name="source" value="exa" />
          <input type="hidden" name="back" value={back} />
          <button type="submit" className={BUTTON}>
            Add
          </button>
        </form>
      )}
    </Row>
  );
}

/** What the search did, in one sentence, including when it found nobody. */
function Outcome({ result }: { result: Extract<LookupResult, { state: 'ok' }> }) {
  const { dropped, returned, withProfiles, candidates } = result;
  const bits = [
    dropped.otherEmployer ? `${dropped.otherEmployer} at other companies` : null,
    dropped.notTalent ? `${dropped.notTalent} not in talent` : null,
    dropped.unconfirmed ? `${dropped.unconfirmed} with no confirmable employer` : null,
  ].filter(Boolean);

  return (
    <p className="mt-2 text-[11px] text-[var(--ink-faint)]">
      {`Exa returned ${returned} ${returned === 1 ? 'profile' : 'profiles'}`}
      {withProfiles !== returned ? `, ${withProfiles} with structured history` : ''}
      {'. '}
      {candidates.length === 0 ? 'None survived the filters' : `${candidates.length} kept`}
      {bits.length ? `, set aside ${bits.join(', ')}` : ''}
      {'. Nothing here is stored until you press Add.'}
    </p>
  );
}

export function Contacts({
  companyId,
  companyLabel,
  contacts,
  stages,
  lookup,
  back,
  findHref,
  message,
}: {
  companyId: string;
  companyLabel: string;
  contacts: Contact[];
  stages: FunnelRow[];
  lookup: LookupResult | null;
  back: string;
  findHref: string;
  message: { kind: 'ok' | 'err'; text: string } | null;
}) {
  const known = new Set(contacts.map((c) => c.linkedin_key));

  return (
    <section className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">Who to talk to</h2>
        <span className="text-[11px] text-[var(--ink-faint)]">
          Name, title and profile only. Deleted after 24 months.{' '}
          <a
            href="https://candidhq.tech/privacy/prospecting"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-[var(--accent)] hover:underline"
          >
            The notice they get
          </a>
        </span>
      </div>

      {message ? (
        <p
          className="mb-2 rounded-md border px-2.5 py-1.5 text-[12px]"
          style={{
            borderColor: message.kind === 'err' ? 'var(--warm)' : 'var(--line-strong)',
            color: message.kind === 'err' ? 'var(--warm)' : 'var(--ink-soft)',
          }}
        >
          {message.text}
        </p>
      ) : null}

      {contacts.length ? (
        <ul className="mb-3">
          {contacts.map((contact) => (
            <Saved key={contact.id} contact={contact} back={back} stages={stages} />
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-[13px] text-[var(--ink-soft)]">
          Nobody on the list for {companyLabel} yet.
        </p>
      )}

      {lookup === null ? (
        <a href={findHref} className={BUTTON}>
          Find the talent lead
        </a>
      ) : lookup.state === 'unconfigured' ? (
        <p className="text-[12px]" style={{ color: 'var(--warm)' }}>
          Searching needs <code>EXA_API_KEY</code> on this Vercel project. Until it is set,
          add people by hand below.
        </p>
      ) : lookup.state === 'error' ? (
        <p className="text-[12px]" style={{ color: 'var(--warm)' }}>
          The search failed: {lookup.message}
        </p>
      ) : (
        <div>
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[12px] font-semibold">Found at {companyLabel}</h3>
            <a href={findHref} className="text-[11px] text-[var(--ink-faint)] hover:text-[var(--accent)]">
              Search again
            </a>
          </div>
          {lookup.candidates.length ? (
            <ul>
              {lookup.candidates.map((candidate) => (
                <Found
                  key={candidate.key}
                  candidate={candidate}
                  companyId={companyId}
                  back={back}
                  already={known.has(candidate.key)}
                />
              ))}
            </ul>
          ) : null}
          <Outcome result={lookup} />
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-[12px] text-[var(--ink-soft)]">
          Add somebody by hand
        </summary>
        <form action={addContactAction} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_1.4fr_auto]">
          <input type="hidden" name="company_id" value={companyId} />
          <input type="hidden" name="source" value="manual" />
          <input type="hidden" name="back" value={back} />
          <input name="full_name" placeholder="Name" className={INPUT} required />
          <input name="job_title" placeholder="Job title" className={INPUT} />
          <input
            name="linkedin_url"
            placeholder="https://www.linkedin.com/in/..."
            className={INPUT}
            required
          />
          <button type="submit" className={BUTTON}>
            Add
          </button>
        </form>
      </details>
    </section>
  );
}
