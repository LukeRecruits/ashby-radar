import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from './env.ts';

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (client) return client;
  const env = loadEnv();
  client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
