'use server';

/**
 * The four writes, as server actions.
 *
 * Each one ends in a redirect back to the company page the form was submitted from, with
 * the list's filters still attached, because the next thing after adding a contact is
 * carrying on down the segment. The destination comes from a hidden field rather than
 * from a referer header, and is validated as a path on this site before it is used: a
 * redirect target that arrives from the request is a redirect target somebody else can
 * choose.
 *
 * Errors are carried back in the query string rather than thrown. A thrown error here
 * replaces the whole page with an error screen, and the two errors that will actually
 * happen are both ordinary answers the operator needs to read: "this person has objected"
 * and "that is not a profile URL".
 */

import { redirect } from 'next/navigation';

import {
  addContact,
  deleteContact,
  setConnection,
  suppressContact,
} from '@/lib/contacts';

/** Only a path on this console, never an absolute URL and never a protocol-relative one. */
function safeBack(value: FormDataEntryValue | null): string {
  const raw = typeof value === 'string' ? value : '';
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

function withFlag(back: string, key: 'err' | 'ok', message: string): string {
  const [path, search = ''] = back.split('?');
  const params = new URLSearchParams(search);
  params.delete('find');
  params.delete('err');
  params.delete('ok');
  params.set(key, message.slice(0, 200));
  return `${path}?${params.toString()}`;
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

async function run(back: string, done: string, work: () => Promise<string | void>) {
  let destination: string;
  try {
    const message = await work();
    destination = withFlag(back, 'ok', message || done);
  } catch (error) {
    destination = withFlag(back, 'err', error instanceof Error ? error.message : String(error));
  }
  redirect(destination);
}

export async function addContactAction(form: FormData): Promise<void> {
  const back = safeBack(form.get('back'));
  const name = text(form, 'full_name');
  const url = text(form, 'linkedin_url');
  const source = text(form, 'source') === 'exa' ? 'exa' : 'manual';

  await run(back, `${name} added`, async () => {
    if (!name) throw new Error('A name is required.');
    if (!url) throw new Error('A LinkedIn profile URL is required.');
    await addContact({
      companyId: text(form, 'company_id'),
      fullName: name,
      jobTitle: text(form, 'job_title') || null,
      linkedinUrl: url,
      source,
    });
    return `${name} added`;
  });
}

export async function setConnectionAction(form: FormData): Promise<void> {
  const back = safeBack(form.get('back'));
  const value = text(form, 'value') === '1';
  await run(back, 'Updated', async () => {
    await setConnection(text(form, 'contact_id'), value);
    return value ? 'Marked as an existing connection' : 'Marked as not connected';
  });
}

export async function deleteContactAction(form: FormData): Promise<void> {
  const back = safeBack(form.get('back'));
  await run(back, 'Removed', async () => {
    await deleteContact(text(form, 'contact_id'));
    return 'Removed. They can be found again by a later search.';
  });
}

export async function suppressContactAction(form: FormData): Promise<void> {
  const back = safeBack(form.get('back'));
  const url = text(form, 'linkedin_url');
  await run(back, 'Suppressed', async () => {
    const removed = await suppressContact(url, text(form, 'reason') || 'objection');
    return removed > 0
      ? 'Objection recorded and the contact deleted. They cannot be added again.'
      : 'Objection recorded. They were not on the list, and cannot be added now.';
  });
}
