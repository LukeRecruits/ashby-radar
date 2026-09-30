// Every tunable in one place. Change values here, never in the logic.

export const config = {
  /** Sent on every outbound request so operators can identify us. */
  userAgent:
    process.env.RADAR_USER_AGENT ??
    'AshbyRadar/1.0 (+contact: luke.eaton.mail@gmail.com)',

  discovery: {
    /** How many of the most recent Common Crawl indexes to sweep. */
    commonCrawlIndexCount: 6,
    /** Politeness gap between CDX requests, per source. */
    cdxRequestDelayMs: 1_200,
    /** Safety valve. A single crawl index should be far under this. */
    maxPagesPerCommonCrawlIndex: 400,
    /** Rows per Wayback page, and a cap on how many pages we will walk. */
    waybackPageSize: 20_000,
    maxWaybackPages: 200,
    /** Request timeout for CDX endpoints. Their p99 is slow. */
    requestTimeoutMs: 120_000,
    /**
     * Retries on 429 / 5xx / network error, with exponential backoff. Common Crawl's
     * index server fails intermittently on wide prefix queries, so the ladder is long:
     * 3s, 6s, 12s, 24s, 48s, 96s, 192s.
     */
    maxRetries: 7,
    retryBaseDelayMs: 3_000,
    /** Rows per Supabase upsert batch. */
    upsertBatchSize: 500,
  },

  ashby: {
    postingApiBase: 'https://api.ashbyhq.com/posting-api/job-board',
    /** Hard limit from the project rules: max 1 request per second. */
    requestDelayMs: 1_100,
  },
} as const;
