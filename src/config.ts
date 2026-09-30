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

  triggers: {
    /** One trigger per company per type per this many days. */
    dedupeDays: 30,
    /** Rows per triggers insert batch. */
    insertBatchSize: 500,
    /**
     * The comparison rules look for the latest snapshot at or before
     * `lookbackDays` ago. `baselineWindowDays` is how far further back they will
     * reach for it, so a missed morning run degrades the comparison rather than
     * silencing the rule for a day.
     */
    hiringSpike: {
      lookbackDays: 30,
      baselineWindowDays: 7,
      minIncrease: 5,
      maxEvidenceJobs: 10,
    },
    sweetSpot: {
      lookbackDays: 30,
      baselineWindowDays: 7,
      /** The band CandidHQ sells into. Also used to order the digest. */
      minRoles: 5,
      maxRoles: 50,
    },
    firstRecruiter: {
      lookbackDays: 90,
      maxEvidenceJobs: 5,
    },
    longOpen: {
      /**
       * A role this old that is still open. Note this is the loudest rule by a
       * long way: on the first evaluation about three quarters of active boards
       * qualify, because most companies have something stale. Raise the age or
       * add a floor under staleRoles if the weekly digest is all long_open.
       */
      minAgeDays: 60,
      maxEvidenceJobs: 5,
    },
    publishesComp: {
      maxEvidenceJobs: 5,
    },
  },

  digest: {
    /** Triggers shown per type before the entry collapses to "and N more". */
    maxPerType: 15,
    /** Used the first time only, before a digest has ever been sent. */
    firstRunWindowDays: 7,
    requestTimeoutMs: 15_000,
  },

  clay: {
    /**
     * Triggers pushed per run. The backlog from the first evaluation is in the
     * thousands, and nothing is lost by draining it over several days: anything
     * unexported is picked up by the next run.
     */
    maxPerRun: 500,
    /** Clay's table webhook takes one row per request. Be polite about it. */
    requestDelayMs: 300,
    requestTimeoutMs: 20_000,
    maxRetries: 3,
    retryBaseDelayMs: 2_000,
    /** Rows per exported_at update batch. */
    markBatchSize: 500,
  },

  exports: {
    /** Written here, then uploaded as workflow artifacts. */
    outputDir: 'out',
    /** Rows pulled per page when walking a table for a CSV. */
    pageSize: 1_000,
  },

  ashby: {
    postingApiBase: 'https://api.ashbyhq.com/posting-api/job-board',
    /** Hard limit from the project rules: max 1 request per second. */
    requestDelayMs: 1_100,
  },
} as const;
