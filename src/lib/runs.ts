import { supabase } from './supabase.ts';

export type RunTotals = {
  checked: number;
  succeeded: number;
  failed: number;
  notes?: string;
};

export async function startRun(workflow: string): Promise<string> {
  const { data, error } = await supabase()
    .from('runs')
    .insert({ workflow })
    .select('id')
    .single();
  if (error) throw new Error(`Could not open run row: ${error.message}`);
  return data.id as string;
}

export async function finishRun(id: string, totals: RunTotals): Promise<void> {
  const { error } = await supabase()
    .from('runs')
    .update({
      finished_at: new Date().toISOString(),
      checked: totals.checked,
      succeeded: totals.succeeded,
      failed: totals.failed,
      // Postgres text has no practical limit, but keep run logs readable.
      notes: totals.notes?.slice(0, 20_000) ?? null,
    })
    .eq('id', id);
  if (error) throw new Error(`Could not close run row: ${error.message}`);
}
