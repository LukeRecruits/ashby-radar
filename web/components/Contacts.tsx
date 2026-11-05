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
import type { StoredPeople } from '@/lib/people';
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
/** The one filled button per row: the move this person is waiting on. */
const PRIMARY =
  'rounded-md bg-[var(--brand-fill)] px-3 py-1 text-[12px] font-medium text-white hover:bg-[var(--brand-fill-hover)]';
const MENU_PANEL =
  'absolute right-0 z-10 mt-1 w-64 rounded-md border border-[var(--line)] bg-[var(--panel)] p-2 shadow-lg';
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
 * The move this person is waiting on, as a CRM would log it: a verb about what happened,
 * not the name of the stage it lands in. An existing connection skips the invitation,
 * which is the same fold `work_queue.next_action` makes.
 */
function nextMove(contact: Contact): { stage: string; label: string; hint: string } | null {
  switch (contact.stage) {
    case 'identified':
      return contact.is_connection
        ? { stage: 'messaged', label: 'Log message sent', hint: 'Already connected, so straight to a message. Include the privacy notice link.' }
        : { stage: 'invite_sent', label: 'Log invite sent', hint: 'Counts against the rolling weekly invitation limit' };
    case 'invite_sent':
      return { stage: 'connected', label: 'Log accepted', hint: 'They accepted the invitation' };
    case 'connected':
      return { stage: 'messaged', label: 'Log message sent', hint: 'Include the privacy notice link' };
    case 'messaged':
      return { stage: 'replied', label: 'Log reply', hint: 'They wrote back' };
    case 'replied':
      return { stage: 'demo', label: 'Log demo booked', hint: 'Something is in the diary' };
    case 'demo':
      return { stage: 'customer', label: 'Mark as customer', hint: 'They signed' };
    default:
      return null;
  }
}

/**
 * The stage as a pill, the way CRMs show a deal's status: a label in a tinted chip, never
 * something that looks pressable. Violet while live, emerald for a customer, grey for a No.
 */
function StagePill({ contact }: { contact: Contact }) {
  const tone =
    contact.stage === 'customer'
      ? { background: 'color-mix(in srgb, var(--good) 14%, transparent)', color: 'var(--good)' }
      : contact.stage === 'no'
        ? { background: 'var(--line)', color: 'var(--ink-soft)' }
        : { background: 'var(--brand-soft)', color: 'var(--accent)' };
  const reason =
    contact.stage === 'no' && contact.no_reason
      ? NO_REASONS.find((r) => r.value === contact.no_reason)?.label ?? contact.no_reason
      : null;
  return (
    <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={tone}>
      {contact.stage_label}
      {reason ? ` · ${reason}` : ''}
    </span>
  );
}

/**
 * The pipeline as a row of steps, Pipedrive-style: where they are is filled, where they
 * have been is ticked, and any step can be clicked to move them there. That covers the
 * cases the next-move button does not, such as a reply that arrived before the invitation
 * was accepted, or reopening a No.
 */
function Pipeline({
  contact,
  stages,
  back,
}: {
  contact: Contact;
  stages: FunnelRow[];
  back: string;
}) {
  const ladder = stages.filter((s) => s.stage !== 'no').sort((a, b) => a.position - b.position);
  const closed = contact.stage === 'no';
  return (
    <ol className="mt-2 flex flex-wrap items-center gap-1" aria-label="Pipeline stage">
      {ladder.map((step, index) => {
        const current = step.stage === contact.stage;
        const done = !closed && step.position < contact.stage_position;
        return (
          <li key={step.stage} className="flex items-center gap-1">
            {index > 0 ? (
              <span
                className="h-px w-3"
                style={{ background: done || current ? 'var(--accent)' : 'var(--line-strong)' }}
                aria-hidden
              />
            ) : null}
            {current ? (
              <span
                aria-current="step"
                className="rounded-full bg-[var(--brand-fill)] px-2 py-0.5 text-[11px] font-medium text-white"
              >
                {step.label}
              </span>
            ) : (
              <form action={setStageAction}>
                <input type="hidden" name="contact_id" value={contact.id} />
                <input type="hidden" name="stage" value={step.stage} />
                <input type="hidden" name="said" value={`${contact.full_name} moved to ${step.label}`} />
                <input type="hidden" name="back" value={back} />
                <button
                  type="submit"
                  title={`Move to ${step.label}`}
                  className="rounded-full border px-2 py-0.5 text-[11px] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  style={
                    done
                      ? { borderColor: 'transparent', color: 'var(--accent)' }
                      : { borderColor: 'var(--line)', color: 'var(--ink-faint)' }
                  }
                >
                  {done ? '✓ ' : ''}
                  {step.label}
                </button>
              </form>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Whether Luke and this person are already connected on LinkedIn, as a two-option
 * segmented control.
 *
 * It used to be one button whose label was the *opposite* of the current state ("Not
 * connected" on someone who was connected), so it read as a status that said the wrong
 * thing. Now both options are always visible, the true one is filled with a tick, and
 * only the other one can be pressed. Same pattern as a CRM's boolean property.
 */
function Connection({ contact, back }: { contact: Contact; back: string }) {
  const options = [
    { value: true, label: 'Connected' },
    { value: false, label: 'Not connected' },
  ];
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-[var(--ink-faint)]">LinkedIn</span>
      <div
        role="group"
        aria-label="Already connected on LinkedIn"
        className="inline-flex overflow-hidden rounded-md border border-[var(--line-strong)]"
      >
        {options.map((option) =>
          option.value === contact.is_connection ? (
            <span
              key={option.label}
              aria-pressed="true"
              className="bg-[var(--brand-soft)] px-2 py-0.5 font-medium text-[var(--accent)]"
            >
              ✓ {option.label}
            </span>
          ) : (
            <form key={option.label} action={setConnectionAction}>
              <input type="hidden" name="contact_id" value={contact.id} />
              <input type="hidden" name="value" value={option.value ? '1' : '0'} />
              <input type="hidden" name="back" value={back} />
              <button
                type="submit"
                aria-pressed="false"
                title={`Change to ${option.label.toLowerCase()}`}
                className="px-2 py-0.5 text-[var(--ink-faint)] hover:text-[var(--accent)]"
              >
                {option.label}
              </button>
            </form>
          ),
        )}
      </div>
    </div>
  );
}

/** A saved contact: who they are, where they are, the next move, and the rarer moves tucked away. */
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
  const next = nextMove(contact);

  return (
    <li className="border-t border-[var(--line)] py-3 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[200px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={contact.linkedin_url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[14px] font-medium hover:text-[var(--accent)] hover:underline"
            >
              {contact.full_name} ↗
            </a>
            <StagePill contact={contact} />
          </div>
          <div className="mt-0.5 text-[12px] text-[var(--ink-soft)]">
            {contact.job_title ?? 'No title'}
            <span className="text-[var(--ink-faint)]">
              {' · '}
              {contact.days_in_stage === 0 ? 'moved today' : `${days} at this stage`}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {next ? (
            <form action={setStageAction}>
              <input type="hidden" name="contact_id" value={contact.id} />
              <input type="hidden" name="stage" value={next.stage} />
              <input type="hidden" name="said" value={`${contact.full_name}: ${next.label.toLowerCase()}`} />
              <input type="hidden" name="back" value={back} />
              <button type="submit" className={PRIMARY} title={next.hint}>
                {next.label}
              </button>
            </form>
          ) : null}

          {contact.stage !== 'no' ? (
            <details className="menu relative">
              <summary className={`${BUTTON} cursor-pointer`}>Close as No</summary>
              <form action={setStageAction} className={MENU_PANEL}>
                <input type="hidden" name="contact_id" value={contact.id} />
                <input type="hidden" name="stage" value="no" />
                <input type="hidden" name="said" value={`${contact.full_name}: closed`} />
                <input type="hidden" name="back" value={back} />
                <label className="block text-[11px] text-[var(--ink-faint)]">
                  Why
                  <select name="reason" defaultValue="no_response" className={`${SELECT} mt-1 w-full`}>
                    {NO_REASONS.map((reason) => (
                      <option key={reason.value} value={reason.value}>
                        {reason.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className={`${BUTTON} mt-2 w-full`}>
                  Close as No
                </button>
              </form>
            </details>
          ) : null}

          <details className="menu relative">
            <summary className={`${BUTTON} cursor-pointer`} aria-label="More actions" title="More actions">
              ⋯
            </summary>
            <div className={MENU_PANEL}>
              <form action={deleteContactAction}>
                <input type="hidden" name="contact_id" value={contact.id} />
                <input type="hidden" name="back" value={back} />
                <button type="submit" className="w-full rounded px-2 py-1.5 text-left text-[12px] hover:bg-[var(--bg)]">
                  Remove
                  <span className="block text-[11px] text-[var(--ink-faint)]">
                    Added by mistake. A later search can find them again.
                  </span>
                </button>
              </form>
              <form action={suppressContactAction}>
                <input type="hidden" name="linkedin_url" value={contact.linkedin_url} />
                <input type="hidden" name="reason" value="objection" />
                <input type="hidden" name="back" value={back} />
                <button
                  type="submit"
                  className="w-full rounded px-2 py-1.5 text-left text-[12px] hover:bg-[var(--bg)]"
                  style={{ color: 'var(--warm)' }}
                >
                  They objected
                  <span className="block text-[11px] text-[var(--ink-faint)]">
                    Deletes them and blocks any future search from adding them back.
                  </span>
                </button>
              </form>
            </div>
          </details>
        </div>
      </div>

      <Pipeline contact={contact} stages={stages} back={back} />
      <div className="mt-2">
        <Connection contact={contact} back={back} />
      </div>
    </li>
  );
}

/**
 * Asked at the moment of adding, because that is when Luke knows it: he is looking at
 * their profile. Saves a second click on the new row, and sets the first move correctly
 * (message rather than invite) from the start.
 */
function ConnectedBox() {
  return (
    <label className="flex items-center gap-1 text-[11px] text-[var(--ink-soft)]">
      <input type="checkbox" name="is_connection" value="1" className="accent-[var(--brand-fill)]" />
      Already connected
    </label>
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
        <span className="text-[12px] text-[var(--ink-faint)]">In the pipeline</span>
      ) : (
        <form action={addContactAction} className="flex items-center gap-1.5">
          <input type="hidden" name="company_id" value={companyId} />
          <input type="hidden" name="full_name" value={candidate.name} />
          <input type="hidden" name="job_title" value={candidate.title ?? ''} />
          <input type="hidden" name="linkedin_url" value={candidate.linkedinUrl} />
          <input type="hidden" name="source" value="exa" />
          <input type="hidden" name="back" value={back} />
          <ConnectedBox />
          <button type="submit" className={PRIMARY}>
            Add to pipeline
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
      {'. Live search; the stored list updates at the next sweep.'}
    </p>
  );
}

export function Contacts({
  companyId,
  companyLabel,
  contacts,
  stages,
  lookup,
  stored,
  back,
  findHref,
  message,
}: {
  companyId: string;
  companyLabel: string;
  contacts: Contact[];
  stages: FunnelRow[];
  lookup: LookupResult | null;
  stored: StoredPeople;
  back: string;
  findHref: string;
  message: { kind: 'ok' | 'err'; text: string } | null;
}) {
  const known = new Set(contacts.map((c) => c.linkedin_key));

  return (
    <section
      id="who"
      className="mt-5 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4"
      style={{ borderTop: '3px solid var(--brand-fill)' }}
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold tracking-tight">
          Who to talk to{' '}
          {contacts.length ? (
            <span className="nums font-normal text-[var(--ink-faint)]">{contacts.length}</span>
          ) : null}
        </h2>
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
            borderColor: message.kind === 'err' ? 'var(--warm)' : 'var(--good)',
            color: message.kind === 'err' ? 'var(--warm)' : 'var(--good)',
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

      {lookup === null && stored.searchedAt ? (
        <div>
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[12px] font-semibold">
              People team at {companyLabel}{' '}
              <span className="nums font-normal text-[var(--ink-faint)]">{stored.people.length}</span>
            </h3>
            <a href={findHref} className="text-[11px] text-[var(--ink-faint)] hover:text-[var(--accent)]">
              Search again now
            </a>
          </div>
          {stored.people.length ? (
            <ul>
              {stored.people.map((candidate) => (
                <Found
                  key={candidate.key}
                  candidate={candidate}
                  companyId={companyId}
                  back={back}
                  already={known.has(candidate.key)}
                />
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-[var(--ink-soft)]">
              The sweep found nobody in talent or people here.
            </p>
          )}
          <p className="mt-2 text-[11px] text-[var(--ink-faint)]">
            {`From the people sweep on ${new Date(stored.searchedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. Refreshed every 90 days.`}
          </p>
        </div>
      ) : lookup === null ? (
        <a href={findHref} className={PRIMARY}>
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
        <form action={addContactAction} className="mt-2 grid items-center gap-2 sm:grid-cols-[1fr_1fr_1.4fr_auto_auto]">
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
          <ConnectedBox />
          <button type="submit" className={PRIMARY}>
            Add to pipeline
          </button>
        </form>
      </details>
    </section>
  );
}
