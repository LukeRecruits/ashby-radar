/**
 * The company profile sweep: headcount and funding for every in-band prospect.
 *
 * One Exa search per company with `category: "company"`, which returns a structured
 * company entity (workforce, founded year, funding total and latest round) alongside each
 * result. The people search does not carry any of this, so it is a second, separate
 * search. Company data only: nobody's personal data is read or stored here.
 *
 * A result is accepted only when its URL is on the company's own domain, or its entity
 * name matches our name for the company exactly once normalised. Exa ranks look-alikes
 * highly ("Atlas" returns Atlas Copco), and a wrong headcount is worse than none, so an
 * unmatched search is recorded as `matched = false` and shown as "No match found".
 */

import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { finishRun, startRun } from '../lib/runs.ts';
import { supabase } from '../lib/supabase.ts';

const ENDPOINT = 'https://api.exa.ai/search';
const TIMEOUT_MS = 20_000;

type QueueRow = { company_id: string; label: string; domain: string };

type CompanyEntity = {
  type?: string;
  properties?: {
    name?: string | null;
    foundedYear?: number | null;
    workforce?: { total?: number | null } | null;
    financials?: {
      fundingTotal?: number | null;
      fundingLatestRound?: { name?: string | null; date?: string | null; amount?: number | null } | null;
    } | null;
  };
};

type ExaResult = { url?: string; title?: string; entities?: CompanyEntity[] };

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function norm(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|ltd|llc|limited|gmbh|corp|corporation|co|plc|sa|bv|ag|technologies|labs|hq)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function onDomain(url: string | undefined, domain: string): boolean {
  const host = url ? hostOf(url) : null;
  const d = domain.toLowerCase().replace(/^www\./, '');
  return !!host && (host === d || host.endsWith(`.${d}`));
}

function finite(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

async function profileOne(row: QueueRow): Promise<{ matched: boolean } | { error: string }> {
  const key = process.env.EXA_API_KEY?.trim();
  if (!key) return { error: 'EXA_API_KEY is not set' };

  let results: ExaResult[];
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `${row.label} (${row.domain}) company`,
        category: 'company',
        numResults: 5,
        type: 'auto',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return { error: `Exa returned ${response.status}. ${(await response.text()).slice(0, 200)}` };
    }
    results = ((await response.json()) as { results?: ExaResult[] }).results ?? [];
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const label = norm(row.label);
  const withEntity = results
    .map((r) => ({ r, e: r.entities?.find((e) => e.type === 'company')?.properties }))
    .filter((x) => x.e);
  // Domain first, because it is proof; then an exact normalised name.
  const hit =
    withEntity.find((x) => onDomain(x.r.url, row.domain)) ??
    withEntity.find((x) => !!label && !!x.e?.name && norm(x.e.name) === label);

  const e = hit?.e;
  const round = e?.financials?.fundingLatestRound ?? null;
  const record = {
    company_id: row.company_id,
    searched_at: new Date().toISOString(),
    matched: !!e,
    exa_name: e?.name ?? null,
    matched_url: hit?.r.url ?? null,
    headcount: finite(e?.workforce?.total) === null ? null : Math.round(e!.workforce!.total!),
    founded_year: finite(e?.foundedYear),
    funding_total_usd: finite(e?.financials?.fundingTotal),
    latest_round_name: round?.name ?? null,
    latest_round_date: round?.date ?? null,
    latest_round_usd: finite(round?.amount),
  };

  const { error } = await supabase().from('company_profiles').upsert(record, { onConflict: 'company_id' });
  if (error) return { error: error.message };
  return { matched: record.matched };
}

async function main(): Promise<void> {
  const { companiesPerRun, refreshDays, concurrency } = config.profiles;
  const limit = Number(process.env.PROFILE_LIMIT) || companiesPerRun;
  const runId = await startRun('profiles');

  try {
    const { data, error } = await supabase().rpc('profile_queue', {
      p_limit: limit,
      p_stale_days: refreshDays,
    });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as QueueRow[];
    log.info('profiles: looking up', { companies: rows.length });

    let succeeded = 0;
    let failed = 0;
    let matched = 0;
    const errors: string[] = [];
    let next = 0;

    async function worker(): Promise<void> {
      while (next < rows.length) {
        const row = rows[next++];
        if (!row) return;
        const outcome = await profileOne(row);
        if ('error' in outcome) {
          failed += 1;
          if (errors.length < 20) errors.push(`${row.label}: ${outcome.error}`);
          if (/EXA_API_KEY|402|insufficient|credit/i.test(outcome.error)) next = rows.length;
        } else {
          succeeded += 1;
          if (outcome.matched) matched += 1;
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));

    log.info('profiles: done', { succeeded, failed, matched });
    await finishRun(runId, {
      checked: rows.length,
      succeeded,
      failed,
      notes: [`Looked up ${succeeded} of ${rows.length} companies, matched ${matched}.`, ...errors].join('\n'),
    });
    if (failed > succeeded) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('profiles: failed', { message });
    await finishRun(runId, { checked: 0, succeeded: 0, failed: 1, notes: message });
    process.exitCode = 1;
  }
}

await main();
