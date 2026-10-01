/**
 * Reading and writing contacts, which is the only writing this console does.
 *
 * Reads go through `lead_contacts`, the seventh shaped view, on the same terms as the
 * other six: anon holds select on the view and nothing at all on the `contacts` table.
 *
 * Writes go through four named database functions, each behind a shared secret that the
 * publishable key does not contain. There is no service-role key here and there will not
 * be one: the whole point of the arrangement is that the credential this app holds can
 * add a contact, flip a flag, delete a row and record an objection, and cannot do
 * anything else to anything else. Migration 0013 section 6 has the reasoning.
 *
 * Every write refuses when CONSOLE_WRITE_TOKEN is unset, the same way the password gate
 * refuses when CONSOLE_PASSWORD is unset. A misconfigured console should be a console
 * that does not work.
 */

import { db } from './supabase';

export type Contact = {
  id: string;
  company_id: string;
  full_name: string;
  job_title: string | null;
  linkedin_url: string;
  linkedin_key: string;
  source: 'exa' | 'manual';
  is_connection: boolean;
  added_at: string;
  last_activity_at: string;
  stage: string;
  stage_changed_at: string;
  no_reason: string | null;
  stage_label: string;
  stage_position: number;
  is_terminal: boolean;
  needs_action: boolean;
  action_label: string | null;
  days_in_stage: number;
};

export async function fetchContacts(companyId: string): Promise<Contact[]> {
  const { data, error } = await db()
    .from('lead_contacts')
    .select(
      'id, company_id, full_name, job_title, linkedin_url, linkedin_key, source, ' +
        'is_connection, added_at, last_activity_at, stage, stage_changed_at, no_reason, ' +
        'stage_label, stage_position, is_terminal, needs_action, action_label, days_in_stage',
    )
    .eq('company_id', companyId)
    .order('added_at', { ascending: true });

  if (error) throw new Error(`lead_contacts read failed: ${error.message}`);
  return (data ?? []) as unknown as Contact[];
}

function token(): string {
  const value = process.env.CONSOLE_WRITE_TOKEN?.trim();
  if (!value) {
    throw new Error(
      'CONSOLE_WRITE_TOKEN is not set on this deployment, so writing is disabled.',
    );
  }
  return value;
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, { ...args, p_token: token() });
  if (error) {
    // The database speaks plainly on the two errors that are the operator's to see: a
    // suppressed contact and a URL that is not a profile. Everything else is ours.
    throw new Error(error.message);
  }
  return data as T;
}

export async function addContact(input: {
  companyId: string;
  fullName: string;
  jobTitle: string | null;
  linkedinUrl: string;
  source: 'exa' | 'manual';
}): Promise<string> {
  return call<string>('add_contact', {
    p_company_id: input.companyId,
    p_full_name: input.fullName,
    p_job_title: input.jobTitle,
    p_linkedin_url: input.linkedinUrl,
    p_source: input.source,
  });
}

export async function setConnection(contactId: string, value: boolean): Promise<boolean> {
  return call<boolean>('set_contact_connection', {
    p_contact_id: contactId,
    p_is_connection: value,
  });
}

export async function deleteContact(contactId: string): Promise<boolean> {
  return call<boolean>('delete_contact', { p_contact_id: contactId });
}

/**
 * Moving somebody along the ladder, or ending it.
 *
 * Setting the stage a contact is already on is allowed and useful: it restamps
 * `stage_changed_at`, which is how "chased today" resets the waiting clock without
 * inventing a stage for it. The database records an event only on an actual change, so
 * the history stays a record of transitions rather than of button presses.
 */
export async function setStage(
  contactId: string,
  stage: string,
  reason: string | null,
): Promise<boolean> {
  return call<boolean>('set_contact_stage', {
    p_contact_id: contactId,
    p_stage: stage,
    p_reason: reason,
  });
}

/** The objection path. Permanent, and survives a later lookup re-finding them. */
export async function suppressContact(
  linkedinUrl: string,
  reason: string,
): Promise<number> {
  return call<number>('suppress_contact', {
    p_linkedin_url: linkedinUrl,
    p_reason: reason,
  });
}
