/**
 * The console's only database client, and deliberately a weak one.
 *
 * It holds the publishable key, which grants the `anon` role. Every base table in the
 * Radar project keeps row level security enabled with no policies, so `anon` reads zero
 * rows from companies, jobs, snapshots, triggers and runs, and cannot write to any of
 * them. The one thing it is granted is `select` on the `lead_list` view.
 *
 * That is the whole security model, and it is enforced by Postgres rather than by this
 * file being careful. The service-role key is not here and never will be: writes the
 * console needs (parking a company, moving a contact through the funnel) get their own
 * narrow server action later, not a general-purpose admin client.
 *
 * Queries run in server components, so the key never reaches the browser.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set on the Vercel project',
    );
  }

  // A guard against the one mistake that would matter: pointing the prospecting console
  // at CandidHQ's database. The two products share nothing, in either direction.
  if (url.includes('nhupuvxlrzcaenrqpgzh')) {
    throw new Error('refusing to start: that is the CandidHQ Supabase project');
  }

  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
