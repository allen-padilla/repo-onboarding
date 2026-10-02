// Errors carry a code for the route to map to a status and a message for the
// user. They never include GitHub's or the job queue's own errors.

export type RepositoryRequestCode =
  | "INVALID_URL"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_EMPTY"
  | "REPOSITORY_LIMIT"
  | "DAILY_LIMIT"
  | "REQUEST_LIMIT"
  | "VERIFICATION_REQUIRED"
  | "GITHUB_UNAVAILABLE"
  | "QUEUE_UNAVAILABLE"
  | "NOT_RETRYABLE";

const MESSAGES: Record<RepositoryRequestCode, string> = {
  INVALID_URL: "The URL is not a GitHub repository URL.",
  REPOSITORY_NOT_FOUND: "The repository does not exist or is not public.",
  REPOSITORY_EMPTY: "The repository is empty.",
  REPOSITORY_LIMIT: "The user already has the most repositories allowed.",
  DAILY_LIMIT: "The user has started the most analyses allowed in 24 hours.",
  REQUEST_LIMIT: "The user has sent the most requests allowed in an hour.",
  VERIFICATION_REQUIRED: "The user's email address is not verified.",
  GITHUB_UNAVAILABLE: "GitHub is unavailable or rate-limited.",
  QUEUE_UNAVAILABLE: "The job queue is unavailable.",
  NOT_RETRYABLE: "Only a failed analysis can be retried.",
};

/** An add or retry request that was rejected. Nothing was saved for it. */
export class RepositoryRequestError extends Error {
  readonly code: RepositoryRequestCode;

  constructor(code: RepositoryRequestCode) {
    super(MESSAGES[code]);
    this.name = "RepositoryRequestError";
    this.code = code;
  }
}

/**
 * The repository does not exist, or belongs to another user. Both look the
 * same, so a user cannot learn about other users' repositories.
 */
export class RepositoryNotFoundError extends Error {
  constructor() {
    super("Repository not found.");
    this.name = "RepositoryNotFoundError";
  }
}
