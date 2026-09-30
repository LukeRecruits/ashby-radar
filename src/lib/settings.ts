/**
 * Key/value state that is not about a company: the backfill marker and the timestamp of
 * the last Slack digest. Both need to survive between workflow runs, and neither
 * belongs on a table of companies.
 */

import { supabase } from './supabase.ts';

export const SETTINGS = {
  /**
   * When the initial verification pass finished. Until this exists, new_to_ashby
   * fires for nobody: every one of the 5,731 discovered boards would otherwise be
   * "new" on the day the engine first runs.
   */
  initialBackfillCompletedAt: 'initial_backfill_completed_at',
  /** When the weekly digest last went out, so the next one starts where it stopped. */
  lastDigestSentAt: 'last_digest_sent_at',
} as const;

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const { data, error } = await supabase()
    .from('settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw new Error(`settings read failed for ${key}: ${error.message}`);
  return (data?.value ?? null) as T | null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const { error } = await supabase()
    .from('settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(`settings write failed for ${key}: ${error.message}`);
}

export async function getTimestamp(key: string): Promise<string | null> {
  const value = await getSetting<string>(key);
  return typeof value === 'string' ? value : null;
}
