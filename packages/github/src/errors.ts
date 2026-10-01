// Errors never include the token, request headers, response bodies, or
// GitHub's own messages, so they are safe to log, report, and store. They
// deliberately have no `cause`, as in @startup/email.

/** Base class for every error raised by `@startup/github`. */
export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

/** The repository does not exist, or it is not public. GitHub answers both the same way. */
export class GitHubNotFoundError extends GitHubError {
  constructor() {
    super("The repository does not exist or is not public.");
    this.name = "GitHubNotFoundError";
  }
}

/** The repository has no commits. */
export class GitHubEmptyRepositoryError extends GitHubError {
  constructor() {
    super("The repository is empty.");
    this.name = "GitHubEmptyRepositoryError";
  }
}

export type GitHubTooLargeReason = "listing_truncated" | "download_limit";

/** GitHub cannot list the whole repository, or its archive is over the download limit. */
export class GitHubRepositoryTooLargeError extends GitHubError {
  readonly reason: GitHubTooLargeReason;

  constructor(reason: GitHubTooLargeReason) {
    super(
      reason === "listing_truncated"
        ? "The repository is too large: GitHub could not list all of its files."
        : "The repository is too large: its archive is over the download limit.",
    );
    this.name = "GitHubRepositoryTooLargeError";
    this.reason = reason;
  }
}

/** GitHub's rate limit is used up until `resetAt`. */
export class GitHubRateLimitError extends GitHubError {
  readonly resetAt: Date;

  constructor(resetAt: Date) {
    super(`GitHub's rate limit is reached until ${resetAt.toISOString()}.`);
    this.name = "GitHubRateLimitError";
    this.resetAt = resetAt;
  }
}

export type GitHubUnavailableReason =
  | "network"
  | "timeout"
  | "status"
  | "authentication"
  | "invalid_response"
  | "redirect";

/**
 * GitHub could not answer: a network failure, a timeout, a server error, a
 * rejected token, a response in an unexpected shape, or a redirect to a host
 * other than GitHub's.
 */
export class GitHubUnavailableError extends GitHubError {
  readonly reason: GitHubUnavailableReason;
  readonly status: number | undefined;

  constructor(reason: GitHubUnavailableReason, status?: number) {
    super(
      status === undefined
        ? `GitHub is unavailable (${reason}).`
        : `GitHub is unavailable (${reason}, HTTP ${status}).`,
    );
    this.name = "GitHubUnavailableError";
    this.reason = reason;
    this.status = status;
  }
}
