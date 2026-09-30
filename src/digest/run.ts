/**
 * Weekly Slack digest.
 *
 * Everything fired since the last digest, grouped by trigger type, with a company name,
 * a board link and one line of evidence each. Sent through an incoming webhook.
 *
 * Without SLACK_WEBHOOK_URL it does nothing and says so. The digest can therefore be
 * wired into the daily workflow before the webhook exists, and starts working the
 * moment the secret is added.
 *
 * The window runs from the last digest rather than a fixed seven days, so a missed
 * Monday is caught up rather than skipped.
 */

import { config } from '../config.ts';
import { inSweetSpot } from '../lib/company.ts';
import { log } from '../lib/log.ts';
import { finishRun, startRun } from '../lib/runs.ts';
import { SETTINGS, getTimestamp, setSetting } from '../lib/settings.ts';
import { loadTriggers, triggerView, type TriggerRow } from '../triggers/read.ts';
import { RULES, type TriggerType } from '../triggers/rules.ts';
import { summarise } from '../triggers/summary.ts';

const WORKFLOW = 'digest';

const RULE_LABEL: Record<TriggerType, string> = {
  new_to_ashby: 'New to Ashby',
  hiring_spike: 'Hiring spike',
  first_recruiter: 'First recruiter',
  sweet_spot: 'Into the sweet spot',
  long_open: 'Long-open roles',
  publishes_comp: 'Started publishing pay',
};

/** Slack rejects a section whose text runs past this. */
const MAX_SECTION_CHARS = 2_900;

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Most useful first. A company inside the band CandidHQ sells into outranks a
 * 3,000-role job marketplace, which is otherwise what sorting on size alone puts at
 * the top of every list.
 */
function rank(a: ReturnType<typeof triggerView>, b: ReturnType<typeof triggerView>): number {
  const inBand = Number(inSweetSpot(b.openRoles)) - Number(inSweetSpot(a.openRoles));
  if (inBand !== 0) return inBand;
  return (b.openRoles ?? 0) - (a.openRoles ?? 0);
}

function sectionFor(type: TriggerType, rows: TriggerRow[]): string {
  const views = rows.map(triggerView).sort(rank);
  const shown = views.slice(0, config.digest.maxPerType);

  const lines = shown.map((view) => {
    const evidence = escape(summarise(type, view.evidence));
    return `• <${view.boardUrl}|${escape(view.company)}> — ${evidence}`;
  });

  const hidden = views.length - shown.length;
  if (hidden > 0) lines.push(`_and ${hidden} more_`);

  let text = lines.join('\n');
  if (text.length > MAX_SECTION_CHARS) {
    text = `${text.slice(0, MAX_SECTION_CHARS - 20).trimEnd()}\n_…truncated_`;
  }
  return text;
}

function buildMessage(rows: TriggerRow[], since: string, until: string) {
  const byType = new Map<TriggerType, TriggerRow[]>();
  for (const row of rows) {
    byType.set(row.type, [...(byType.get(row.type) ?? []), row]);
  }

  const window = `${since.slice(0, 10)} to ${until.slice(0, 10)}`;
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Ashby Radar: ${rows.length} new signals` },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${window} · ${byType.size} of 6 rules fired` }],
    },
  ];

  // RULES order, not insertion order, so the digest reads the same way every week.
  for (const rule of RULES) {
    const typeRows = byType.get(rule.type);
    if (!typeRows?.length) continue;
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${RULE_LABEL[rule.type]}* (${typeRows.length})\n${sectionFor(rule.type, typeRows)}`,
      },
    });
  }

  return {
    text: `Ashby Radar: ${rows.length} new signals, ${window}`,
    blocks,
  };
}

async function send(webhook: string, payload: unknown): Promise<void> {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': config.userAgent },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.digest.requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Slack webhook returned ${response.status}: ${await response.text()}`);
  }
}

async function main(): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();

  const runId = await startRun(WORKFLOW);
  try {
    const until = new Date().toISOString();
    const since =
      (await getTimestamp(SETTINGS.lastDigestSentAt)) ??
      new Date(Date.now() - config.digest.firstRunWindowDays * 86_400_000).toISOString();

    const rows = await loadTriggers({ since, until });
    log.info('digest window', { since, until, triggers: rows.length });

    if (!rows.length) {
      // Still move the marker on. An empty week is not a week to replay next time.
      if (webhook) await setSetting(SETTINGS.lastDigestSentAt, until);
      await finishRun(runId, {
        checked: 0,
        succeeded: 0,
        failed: 0,
        notes: JSON.stringify({ since, until, triggers: 0, sent: false }, null, 2),
      });
      log.info('nothing new to report, digest skipped');
      return;
    }

    const message = buildMessage(rows, since, until);
    const byType: Record<string, number> = {};
    for (const row of rows) byType[row.type] = (byType[row.type] ?? 0) + 1;

    // No webhook yet. Render the digest into the run log anyway and leave the marker
    // alone, so the week is still waiting when the secret arrives. With no local
    // development environment this log is the only way to see a digest before it
    // lands in Luke's Slack.
    if (!webhook) {
      log.warn('SLACK_WEBHOOK_URL is not set, digest rendered but not sent');
      console.log(JSON.stringify(message, null, 2));
      await finishRun(runId, {
        checked: rows.length,
        succeeded: 0,
        failed: 0,
        notes: JSON.stringify({ since, until, sent: false, reason: 'no webhook', byType }, null, 2),
      });
      return;
    }

    await send(webhook, message);
    await setSetting(SETTINGS.lastDigestSentAt, until);

    await finishRun(runId, {
      checked: rows.length,
      succeeded: rows.length,
      failed: 0,
      notes: JSON.stringify({ since, until, sent: true, byType }, null, 2),
    });
    log.info('digest sent', { triggers: rows.length, ...byType });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, {
      checked: 0,
      succeeded: 0,
      failed: 1,
      notes: JSON.stringify({ fatal: message }, null, 2),
    });
    throw error;
  }
}

main().catch((error) => {
  log.error('digest failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
