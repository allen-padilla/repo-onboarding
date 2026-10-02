// Shared by the repository pages, in server and browser code. Only types come
// from @startup/onboarding, which is server-only. See
// docs/specs/repo-onboarding-core.md.

import type { FailureReason, RepositoryRequestCode, RepositoryStatus } from "@startup/onboarding";
import type { FileRole } from "@startup/onboarding/walkthrough";

/** The error codes the repository routes answer with. */
export type RepositoryErrorCode = RepositoryRequestCode | "UNAUTHORIZED" | "FORBIDDEN_ORIGIN" | "NOT_FOUND";

export const STATUS_LABELS: Record<RepositoryStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

export const FAILURE_REASONS: Record<FailureReason, string> = {
  not_found: "The repository was not found or is not public.",
  too_large: "The repository is too large to analyze.",
  nothing_to_analyze: "The repository has nothing to analyze.",
  github_rate_limit: "GitHub's rate limit was reached.",
  writer_failed: "The walkthrough could not be written.",
  timed_out: "The analysis timed out.",
  unexpected: "An unexpected error stopped the analysis.",
};

export const ROLE_LABELS: Record<FileRole, string> = {
  entry_point: "Entry point",
  configuration: "Configuration",
  domain_logic: "Domain logic",
  test: "Test",
  documentation: "Documentation",
};

/** The page's copy for each rejection. Never the server's own message. */
export const REQUEST_MESSAGES: Record<RepositoryErrorCode, string> = {
  INVALID_URL: "Enter a GitHub repository URL, such as https://github.com/owner/repo.",
  REPOSITORY_NOT_FOUND: "That repository doesn't exist or isn't public.",
  REPOSITORY_EMPTY: "That repository is empty.",
  REPOSITORY_LIMIT: "You have the most repositories allowed. Delete a repository to add another.",
  DAILY_LIMIT: "You've started the most analyses allowed in 24 hours. Try again later.",
  REQUEST_LIMIT: "You've sent the most requests allowed in an hour. Try again later.",
  VERIFICATION_REQUIRED: "Verify your email address to add or retry repositories.",
  GITHUB_UNAVAILABLE: "GitHub is unavailable right now. Try again in a few minutes.",
  QUEUE_UNAVAILABLE: "Analyses can't be started right now. Try again in a few minutes.",
  NOT_RETRYABLE: "Only a failed analysis can be retried.",
  UNAUTHORIZED: "Your session has ended. Sign in again.",
  FORBIDDEN_ORIGIN: "Something went wrong. Please try again.",
  NOT_FOUND: "This repository no longer exists.",
};

const GENERIC = "Something went wrong. Please try again.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RepositoryResponse = { ok: true; id?: string } | { ok: false; message: string };

/**
 * Sends a request to a repository route from the browser, and returns the ID
 * it answered with, or the page's message for its error.
 */
export async function sendRepositoryRequest(
  path: string,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<RepositoryResponse> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, message: GENERIC };
  }

  const result = (await response.json().catch(() => null)) as { id?: unknown; error?: unknown } | null;

  if (response.ok) {
    return { ok: true, id: typeof result?.id === "string" && UUID.test(result.id) ? result.id : undefined };
  }

  const code = result?.error;
  return {
    ok: false,
    message:
      typeof code === "string" && Object.hasOwn(REQUEST_MESSAGES, code)
        ? REQUEST_MESSAGES[code as RepositoryErrorCode]
        : GENERIC,
  };
}

const DATE_FORMAT = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

/** A date as the pages show it. Stored times are UTC. */
export function formatDate(date: Date): string {
  return DATE_FORMAT.format(date);
}

/** The short form of a commit SHA. */
export function shortCommit(sha: string): string {
  return sha.slice(0, 7);
}
