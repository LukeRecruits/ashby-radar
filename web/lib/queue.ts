/**
 * The work queue: what to do today, in the order it should be done.
 *
 * The lead list answers "who is worth a look" and the company page answers "is this one
 * worth an invitation". Neither answers the question that actually governs a week of
 * outreach, which is "of the people I have already decided to approach, who is waiting on
 * me right now". That is this.
 *
 * Three principles the shape comes from:
 *
 *   * **Replies first.** Somebody who answered is the only thing here with a cost to
 *     delay. An invitation can wait a day; a reply going cold cannot.
 *   * **Waiting is not doing.** Invite sent, Messaged and Demo booked are stages where
 *     the ball is with them, so they sit below the actionable work and only surface when
 *     they have waited long enough to be chased.
 *   * **The invitation budget is finite.** LinkedIn allows roughly a hundred invitations
 *     per rolling seven days, on every tier including Sales Navigator, and exceeding it
 *     is an account problem rather than a telling-off. The counter is part of the page,
 *     not a footnote.
 *
 * The stage ladder lives in the database (`contact_stages`) because the views order by
 * it. The waiting thresholds live here, because a view cannot take a parameter and
 * burying a number like "chase after seven days" in SQL is how it stops being tunable.
 */

import { db } from './supabase';

/** How long a stage where we are waiting on them can sit before it wants chasing. */
export const WAITING_DAYS = {
  /** An unanswered invitation. Past this it is unlikely to be accepted at all. */
  invite_sent: 21,
  /** A first message with no reply. A week is long enough to not look impatient. */
  messaged: 7,
  /** A booked demo with nothing since. */
  demo: 7,
} as const;

/** LinkedIn's own limit, which it does not publish and does not enforce gently. */
export const INVITE_LIMIT_7_DAYS = 100;

/** The pace that uses the budget without ever approaching the edge of it. */
export const INVITE_DAILY_TARGET = 20;

export type QueueRow = {
  contact_id: string;
  company_id: string;
  full_name: string;
  job_title: string | null;
  linkedin_url: string;
  is_connection: boolean;
  source: 'exa' | 'manual';
  added_at: string;
  stage: string;
  stage_label: string;
  stage_position: number;
  is_terminal: boolean;
  needs_action: boolean;
  stage_changed_at: string;
  days_in_stage: number;
  no_reason: string | null;
  next_action: 'invite' | 'message' | 'reply' | 'waiting' | 'done';
  company_label: string;
  domain: string | null;
  top_country: string | null;
  top_locality: string | null;
  open_roles: number;
  stale_roles_120: number;
  recruiter_roles: number;
  signal_count: number;
};

export type FunnelRow = {
  stage: string;
  label: string;
  position: number;
  is_terminal: boolean;
  contacts: number;
};

export type InviteUsage = {
  last_7_days: number;
  last_24_hours: number;
  last_30_days: number;
  last_invite_at: string | null;
};

const QUEUE_COLUMNS =
  'contact_id, company_id, full_name, job_title, linkedin_url, is_connection, source, ' +
  'added_at, stage, stage_label, stage_position, is_terminal, needs_action, ' +
  'stage_changed_at, days_in_stage, no_reason, next_action, company_label, domain, ' +
  'top_country, top_locality, open_roles, stale_roles_120, recruiter_roles, signal_count';

export async function fetchQueue(): Promise<{
  rows: QueueRow[];
  funnel: FunnelRow[];
  invites: InviteUsage;
}> {
  const [queue, funnel, invites] = await Promise.all([
    db()
      .from('work_queue')
      .select(QUEUE_COLUMNS)
      // Oldest first inside a bucket: the person who has been waiting longest on an
      // answer from us is the one to deal with, and the buckets themselves are ordered
      // in the page rather than here.
      .order('stage_changed_at', { ascending: true }),
    db()
      .from('funnel_counts')
      .select('stage, label, position, is_terminal, contacts')
      .order('position', { ascending: true }),
    db()
      .from('invite_usage')
      .select('last_7_days, last_24_hours, last_30_days, last_invite_at')
      .maybeSingle(),
  ]);

  for (const [name, result] of [
    ['work_queue', queue],
    ['funnel_counts', funnel],
    ['invite_usage', invites],
  ] as const) {
    if (result.error) throw new Error(`${name} read failed: ${result.error.message}`);
  }

  return {
    rows: (queue.data ?? []) as unknown as QueueRow[],
    funnel: (funnel.data ?? []) as unknown as FunnelRow[],
    invites: (invites.data as unknown as InviteUsage | null) ?? {
      last_7_days: 0,
      last_24_hours: 0,
      last_30_days: 0,
      last_invite_at: null,
    },
  };
}

/**
 * The ladder itself, for the company page's stage picker.
 *
 * It comes out of `funnel_counts` rather than from a list in this file, because that view
 * already carries every stage with its label and position and is already granted. One
 * definition of the ladder, in the database, which is where the foreign key lives too.
 */
export async function fetchStages(): Promise<FunnelRow[]> {
  const { data, error } = await db()
    .from('funnel_counts')
    .select('stage, label, position, is_terminal, contacts')
    .order('position', { ascending: true });
  if (error) throw new Error(`funnel_counts read failed: ${error.message}`);
  return (data ?? []) as unknown as FunnelRow[];
}

/** True when a stage we are waiting on has waited long enough to want a nudge. */
export function isOverdue(row: QueueRow): boolean {
  const limit = WAITING_DAYS[row.stage as keyof typeof WAITING_DAYS];
  return limit !== undefined && row.days_in_stage >= limit;
}

export type Buckets = {
  reply: QueueRow[];
  message: QueueRow[];
  invite: QueueRow[];
  overdue: QueueRow[];
  waiting: QueueRow[];
  done: QueueRow[];
};

/**
 * One pass, in priority order. A row appears in exactly one bucket: the queue is a list
 * of decisions, and a person who shows up twice is a person counted twice.
 */
export function bucket(rows: QueueRow[]): Buckets {
  const out: Buckets = { reply: [], message: [], invite: [], overdue: [], waiting: [], done: [] };

  for (const row of rows) {
    if (row.next_action === 'reply') out.reply.push(row);
    else if (row.next_action === 'message') out.message.push(row);
    else if (row.next_action === 'invite') out.invite.push(row);
    else if (row.next_action === 'done') out.done.push(row);
    else if (isOverdue(row)) out.overdue.push(row);
    else out.waiting.push(row);
  }

  // Inside the chasing bucket, longest wait first. Everything else keeps the oldest-first
  // order the query returned.
  out.overdue.sort((a, b) => b.days_in_stage - a.days_in_stage);
  return out;
}

/**
 * What pressing the one visible button on a row means. Each actionable stage has a single
 * obvious next move, and a queue that asks which of six stages to pick is a queue that
 * gets read rather than worked.
 */
export const ADVANCE: Record<string, { stage: string; label: string; hint: string }> = {
  invite: {
    stage: 'invite_sent',
    label: 'Invited',
    hint: 'Records the invitation, which counts against the rolling weekly limit',
  },
  message: {
    stage: 'messaged',
    label: 'Messaged',
    hint: 'Records the first message. Remember the privacy notice link',
  },
  reply: {
    stage: 'demo',
    label: 'Demo booked',
    hint: 'They replied and there is something in the diary',
  },
};

export const NO_REASONS: { value: string; label: string }[] = [
  { value: 'no_response', label: 'Never replied' },
  { value: 'not_relevant', label: 'Not a fit' },
  { value: 'wrong_person', label: 'Wrong person' },
  { value: 'said_no', label: 'Said no' },
  { value: 'left_company', label: 'Left the company' },
  { value: 'other', label: 'Other' },
];
