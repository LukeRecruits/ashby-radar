import { config } from '../config.ts';
import { log } from './log.ts';
import { sleep } from './sleep.ts';

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

type FetchOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Statuses returned to the caller instead of retried. 404 for the Ashby API. */
  passThroughStatuses?: number[];
};

/**
 * Fetch with exponential backoff on 429 and 5xx. Honours Retry-After when the
 * server sends one. Never retries a 4xx other than 429.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = config.discovery.requestTimeoutMs,
    maxRetries = config.discovery.maxRetries,
    retryBaseDelayMs = config.discovery.retryBaseDelayMs,
    passThroughStatuses = [],
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = retryBaseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.random() * retryBaseDelayMs;
      await sleep(backoff + jitter);
    }

    try {
      const response = await fetch(url, {
        headers: { 'user-agent': config.userAgent, accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok || passThroughStatuses.includes(response.status)) {
        return response;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw new HttpError(response.status, url);

      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        await sleep(Math.min(retryAfter, 120) * 1_000);
      }
      lastError = new HttpError(response.status, url);
      log.warn('retrying', { url, status: response.status, attempt: attempt + 1 });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      lastError = error;
      log.warn('request failed, retrying', {
        url,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
}
