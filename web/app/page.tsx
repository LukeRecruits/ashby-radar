/**
 * The work queue. The front door, because it is the only page that answers "what now".
 *
 * The lead list is a list of companies and the company page is a case for one of them.
 * Neither tells you what today looks like. This does: of the people already decided on,
 * who is waiting on Luke, in the order that matters, with the invitation budget in view.
 *
 * Sections in priority order, and a section with nobody in it does not render at all.
 * An empty queue should look empty rather than look like six headings over nothing.
 */

import { Funnel } from '@/components/Funnel';
import { Nav } from '@/components/Nav';
import { InviteMeter, Section } from '@/components/Queue';
import { bucket, fetchQueue, WAITING_DAYS } from '@/lib/queue';

export const dynamic = 'force-dynamic';

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ rows, funnel, invites }, query] = await Promise.all([fetchQueue(), searchParams]);
  const buckets = bucket(rows);

  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
  const err = one(query.err);
  const ok = one(query.ok);

  const toDo = buckets.reply.length + buckets.message.length + buckets.invite.length;

  return (
    <main className="mx-auto max-w-[1100px] px-4 py-6">
      <Nav current="/" />

      <header className="border-b border-[var(--line)] pb-4">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {toDo === 0 ? 'Nothing waiting on you' : `${toDo} waiting on you`}
            </h1>
            <p className="mt-1 text-[13px] text-[var(--ink-soft)]">
              {rows.length === 0
                ? 'Nobody in the funnel yet. Find companies on the lead list, then find the talent lead on their page.'
                : [
                    buckets.reply.length ? `${buckets.reply.length} to reply to` : null,
                    buckets.message.length ? `${buckets.message.length} to message` : null,
                    buckets.invite.length ? `${buckets.invite.length} to invite` : null,
                    buckets.overdue.length ? `${buckets.overdue.length} wanting a nudge` : null,
                  ]
                    .filter(Boolean)
                    .join(', ') || 'Everything is waiting on them, not on you.'}
            </p>
          </div>
          <InviteMeter usage={invites} />
        </div>

        <div className="mt-4">
          <Funnel rows={funnel} />
        </div>
      </header>

      {err || ok ? (
        <p
          className="mt-3 rounded-md border px-2.5 py-1.5 text-[12px]"
          style={{
            borderColor: err ? 'var(--warm)' : 'var(--line-strong)',
            color: err ? 'var(--warm)' : 'var(--ink-soft)',
          }}
        >
          {err || ok}
        </p>
      ) : null}

      <Section
        title="Replied"
        note="Deal with these first. A reply going cold is the only real loss here"
        rows={buckets.reply}
        back="/"
        tone="warm"
      />
      <Section
        title="To message"
        note="Connected, or already a connection, so no invitation needed"
        rows={buckets.message}
        back="/"
      />
      <Section
        title="To invite"
        note="Identified and not connected yet. Each one costs an invitation"
        rows={buckets.invite}
        back="/"
      />
      <Section
        title="Wanting a nudge"
        note={`Invitations past ${WAITING_DAYS.invite_sent} days, messages past ${WAITING_DAYS.messaged}`}
        rows={buckets.overdue}
        back="/"
      />
      <Section
        title="Waiting on them"
        note="Nothing to do yet. Here so the funnel is not a black box"
        rows={buckets.waiting}
        back="/"
      />
      <Section
        title="Closed"
        note="Customers and the ones that ended. Reopen from the company page"
        rows={buckets.done}
        back="/"
      />
    </main>
  );
}
