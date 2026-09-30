/**
 * Posting one row to a Clay table webhook.
 *
 * Shared by the company push and the trigger push so both retry the same way and
 * neither invents its own idea of which failures are worth trying again.
 */

import { config } from '../config.ts';
import { sleep } from '../lib/sleep.ts';

/** Clay refused the row itself. Retrying would send the same rejected row again. */
export class ClayRejected extends Error {}

export async function postToClay(webhook: string, row: unknown): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.clay.maxRetries; attempt++) {
    if (attempt > 0) await sleep(config.clay.retryBaseDelayMs * 2 ** (attempt - 1));

    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': config.userAgent },
        body: JSON.stringify(row),
        signal: AbortSignal.timeout(config.clay.requestTimeoutMs),
      });
      if (response.ok) return;

      // Only rate limits and server faults are worth trying again.
      if (response.status !== 429 && response.status < 500) {
        throw new ClayRejected(`Clay returned ${response.status}: ${await response.text()}`);
      }
      lastError = new Error(`Clay returned ${response.status}`);
    } catch (error) {
      if (error instanceof ClayRejected) throw error;
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Clay push failed');
}
