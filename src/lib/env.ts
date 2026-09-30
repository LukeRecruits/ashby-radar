function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function loadEnv() {
  const url = required('SUPABASE_URL');
  if (url.includes('nhupuvxlrzcaenrqpgzh')) {
    // Hard stop. Ashby Radar must never touch the CandidHQ project.
    throw new Error('SUPABASE_URL points at the CandidHQ project. Refusing to run.');
  }
  return {
    supabaseUrl: url,
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  };
}
