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
    /** Common Crawl pages are slower still: two aborted at 120s on the first run. */
    commonCrawlPageTimeoutMs: 240_000,
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

  refresh: {
    /**
     * Companies in flight at once. Ashby is paced by the shared rate limiter, not by
     * this, so raising it overlaps more Supabase writes with the same 1 request/second
     * and does not touch Ashby any harder. At 1 it would run a full second idle between
     * every board while waiting on the database.
     */
    concurrency: 6,
    /** Rows pulled per page when listing companies to check. */
    companyPageSize: 1_000,
    /** How long a not_found company waits before we try it again. */
    notFoundRecheckDays: 7,
    /** Rows per jobs upsert batch. Big boards exist: OpenAI returns 833 jobs. */
    jobUpsertBatchSize: 500,
    /** Per-company request timeout. Board responses can be a megabyte or more. */
    requestTimeoutMs: 60_000,
    /** Retries on 429 / 5xx per board. Shorter ladder than discovery: 2s, 4s, 8s. */
    maxRetries: 3,
    retryBaseDelayMs: 2_000,
    /**
     * Counts as a recruiting hire for recruiter_role_count and the first_recruiter
     * trigger. \bTA\b is anchored deliberately: an unanchored "ta" matches Data,
     * Staff, Retail and most of the job market.
     */
    recruiterTitlePatterns: [
      'recruit',
      'talent',
      '\\bTA\\b',
      'people partner',
    ] as string[],
    /** Failure strings kept in the run notes. The rest are counted only. */
    maxLoggedFailures: 200,
  },

  ashby: {
    postingApiBase: 'https://api.ashbyhq.com/posting-api/job-board',
    /** Hard limit from the project rules: max 1 request per second. */
    requestDelayMs: 1_100,
  },
} as const;
