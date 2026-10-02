// Per-user limits. See docs/specs/repo-onboarding-core.md.

/** Repositories a user can have at once, in every status. */
export const REPOSITORY_LIMIT = 5;

/** Analyses a user can start per rolling 24 hours, new repositories and retries. */
export const DAILY_ANALYSIS_LIMIT = 10;

/** Add or retry requests a user can send per rolling hour, rejected ones included. */
export const HOURLY_REQUEST_LIMIT = 20;

// Per-analysis bounds. See docs/plans/repo-onboarding-core.md (Decisions) and
// docs/architecture/repository-analysis.md. Tunable.

const KB = 1024;
const MINUTE = 60_000;

/** Files larger than this are dropped from the listing. */
export const MAX_FILE_BYTES = 100 * KB;

/** Files scored per repository. */
export const SCORED_FILE_LIMIT = 300;

/** Files read from the archive, by local score, to find the files to score. */
export const CANDIDATE_LIMIT = 450;

/** Compressed bytes downloaded before the repository counts as too large. */
export const MAX_DOWNLOAD_BYTES = 250 * KB * KB;

/** The root `.gitattributes` is ignored when it is larger than this. */
export const MAX_ATTRIBUTES_BYTES = 100 * KB;

/** Content sent to TypeSafe per file. */
export const SCORING_CONTENT_BYTES = 16 * KB;

/** TypeSafe requests in flight at once, per analysis. */
export const SCORING_CONCURRENCY = 4;

/** Scoring stops after this, and the remaining files use local signals. */
export const SCORING_DEADLINE_MS = 6 * MINUTE;

/** TypeSafe timeouts or provider errors in a row after which scoring stops. */
export const SCORING_FAILURES_IN_A_ROW = 5;

/** A TypeSafe rate limit is waited out once per file when it asks for at most this long. */
export const SCORING_RATE_LIMIT_WAIT_MS = 30_000;

/** Role answers below this confidence are replaced by the path rule. */
export const ROLE_CONFIDENCE_THRESHOLD = 0.6;

/** Top-ranked files whose contents are sent to the writer. */
export const WRITER_FILE_LIMIT = 30;

/** Content sent to the writer per file. */
export const WRITER_FILE_BYTES = 30 * KB;

/** Content sent to the writer in total. */
export const WRITER_TOTAL_BYTES = 300 * KB;

/** Paths in the outline sent to the writer. */
export const OUTLINE_PATH_LIMIT = 2_000;

/** Key files in a walkthrough. */
export const KEY_FILE_LIMIT = 15;

/** The writer stops this long before the analysis time limit. */
export const WRITER_RESERVE_MS = 1 * MINUTE;

/** The writer is asked again after invalid output only when this much time remains. */
export const WRITER_RETRY_MIN_REMAINING_MS = 3 * MINUTE;

/** An analysis still running after this fails as timed out. */
export const ANALYSIS_TIME_LIMIT_MS = 15 * MINUTE;

/** How often a running analysis refreshes its job's heartbeat. The queue expects one every 30 seconds. */
export const HEARTBEAT_REFRESH_SECONDS = 15;

/** A user's analysis waits this long when another of theirs is running. */
export const BUSY_REQUEUE_SECONDS = 15;

/** A GitHub rate limit is waited out inside a run when it resets within this. */
export const GITHUB_RATE_LIMIT_WAIT_MS = 1 * MINUTE;

/** Times an analysis is queued again for a GitHub rate limit before it fails. */
export const GITHUB_RATE_LIMIT_REQUEUES = 3;

/** A queued or running analysis untouched for this long, whose job is gone or finished, fails. */
export const STUCK_ANALYSIS_MINUTES = 20;
