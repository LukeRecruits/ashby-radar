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

  enrich: {
    /**
     * Company name comes from the board page, once per company rather than daily.
     * jobs.ashbyhq.com is Ashby's infrastructure like the API is, so it gets the same
     * one-request-per-second budget and its own limiter.
     */
    boardPageDelayMs: 1_100,
    boardPageTimeoutMs: 30_000,
    /** Only the <head> is wanted. The board is a JS app and the body is a megabyte. */
    boardPageReadBytes: 60_000,
    maxRetries: 2,
    retryBaseDelayMs: 2_000,

    /**
     * Minimum name-match score to accept a domain read out of job adverts. The whole
     * safety margin lives here: below it we refuse and let the verifier try, because a
     * wrong domain poisons every downstream lookup and a refusal costs nothing.
     */
    minDomainScore: 80,
    /** Minimum score before a guessed domain is even worth fetching. */
    minGuessScore: 60,
    /** Tried in this order. Covers the overwhelming majority of company websites. */
    guessTlds: ['com', 'io', 'ai', 'co', 'app', 'dev'] as readonly string[],
    careersPaths: ['/careers', '/jobs', '/careers/', '/company/careers', '/about/careers'] as readonly string[],
    /** Hard ceiling on fetches per company so one slow site cannot eat the run. */
    maxFetchesPerCompany: 8,
    siteTimeoutMs: 10_000,
    siteReadBytes: 400_000,
    /** Politeness gap between two fetches of the same host. */
    perHostDelayMs: 1_000,
    /**
     * Companies verified in parallel. These are thousands of different hosts, not one,
     * so the Ashby rate limit does not apply and the run is minutes rather than hours.
     */
    verifyConcurrency: 20,

    /** Safety valve per run, so a first pass can be proved small before going wide. */
    maxNamesPerRun: 6_000,
    maxVerifiesPerRun: 3_000,
    companyPageSize: 1_000,
    updateBatchSize: 200,
    /**
     * Write results out every this many rows rather than once at the end. A full
     * naming pass runs about 75 minutes; flushing as it goes means a failure at
     * minute 74 keeps everything already proved.
     */
    flushEvery: 200,
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
       * A role this old that is still open.
       *
       * The build pack specced 60 days. On the first evaluation over the full
       * 4,167 active boards that fired for 3,217 of them, 77%, which is a
       * directory rather than a prospect list: almost every company has
       * something stale, so the signal carried no information. Raised to 120 on
       * 2026-09-30.
       */
      minAgeDays: 120,
      /**
       * And this many of them. One stale role is an accident, three is a
       * pattern. At 120 days with no floor the rule still fired for 2,521 of
       * 4,167 boards; with this and the band below it fires for 1,131.
       *
       * Evergreen postings ("General Application", "Don't see your role?") are
       * excluded from the count entirely, in the rule and in every view, by
       * jobs.is_evergreen. 474 of 64,827 open roles are one, and 105 companies
       * had nothing else as their stale evidence. See migration 0019.
       */
      minStaleRoles: 3,
      /**
       * And a company in the band CandidHQ sells into. Deliberately the same
       * numbers as sweetSpot, because it is the same claim about who the
       * product is for: a two-person board with three old roles is not a
       * company with a hiring problem worth solving.
       */
      minOpenRoles: 5,
      maxOpenRoles: 50,
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

  contacts: {
    /**
     * How long a prospecting contact is kept after the last action taken on them, in
     * months. Stated publicly at candidhq.tech/privacy/prospecting and enforced monthly
     * by the retention workflow, so changing it here means changing that page too.
     */
    retentionMonths: 24,
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

  greenhouse: {
    /**
     * Greenhouse's public Job Board API. One host serves US and EU boards alike:
     * boards-api.eu.greenhouse.io does not resolve, and EU board tokens answer here.
     */
    boardApiBase: 'https://boards-api.greenhouse.io/v1/boards',
    /**
     * The hosts a Greenhouse board lives on, all served by the one API above. Discovery
     * mines all four. job-boards.* is the current board, boards.* the legacy one, which
     * also carries the embed widget at /embed/job_board?for={token}.
     */
    boardHosts: [
      'job-boards.greenhouse.io',
      'boards.greenhouse.io',
      'job-boards.eu.greenhouse.io',
      'boards.eu.greenhouse.io',
    ] as readonly string[],
    /**
     * Same politeness as Ashby: one request per second. Greenhouse publishes no limit
     * for the board API. Its own limiter, so the two refreshes never share a budget.
     */
    requestDelayMs: 1_100,
    /**
     * Fetch /departments alongside /jobs. The plain jobs list carries no departments, and
     * the alternative, content=true, is about sixteen times the bytes. Off means one
     * request per board and a null department on every Greenhouse job.
     */
    fetchDepartments: true,
  },
} as const;
