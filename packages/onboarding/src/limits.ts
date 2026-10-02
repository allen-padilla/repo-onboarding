// Per-user limits. See docs/specs/repo-onboarding-core.md.

/** Repositories a user can have at once, in every status. */
export const REPOSITORY_LIMIT = 5;

/** Analyses a user can start per rolling 24 hours, new repositories and retries. */
export const DAILY_ANALYSIS_LIMIT = 10;

/** Add or retry requests a user can send per rolling hour, rejected ones included. */
export const HOURLY_REQUEST_LIMIT = 20;
