// Shared by the repository route handlers: who may call them, and the status
// for each rejection. Bodies carry a code and never a message from GitHub, the
// job queue, or the database. See docs/specs/repo-onboarding-core.md.

import { getSession, type Session } from "@startup/auth/next";
import { RepositoryNotFoundError, RepositoryRequestError, type RepositoryRequestCode } from "@startup/onboarding";

import type { RepositoryErrorCode } from "./repositories";
import { isSameOrigin } from "./same-origin";

const STATUS: Record<RepositoryRequestCode, number> = {
  INVALID_URL: 400,
  REPOSITORY_NOT_FOUND: 422,
  REPOSITORY_EMPTY: 422,
  REPOSITORY_LIMIT: 409,
  DAILY_LIMIT: 429,
  REQUEST_LIMIT: 429,
  VERIFICATION_REQUIRED: 403,
  GITHUB_UNAVAILABLE: 503,
  QUEUE_UNAVAILABLE: 503,
  NOT_RETRYABLE: 409,
};

function refuse(error: RepositoryErrorCode, status: number): Response {
  return Response.json({ error }, { status });
}

/**
 * The signed-in user for a state-changing request: `401` without a session,
 * and `403` when the request does not come from the application's own pages.
 */
export async function authorize(request: Request): Promise<{ user: Session["user"] } | { response: Response }> {
  const session = await getSession();
  if (!session) return { response: refuse("UNAUTHORIZED", 401) };
  if (!isSameOrigin(request)) return { response: refuse("FORBIDDEN_ORIGIN", 403) };
  return { user: session.user };
}

/**
 * The response for a rejected request, or `undefined` for any other error,
 * which the route throws again. A repository that is missing or belongs to
 * another user, and a malformed ID, are all `404`.
 */
export function rejection(error: unknown): Response | undefined {
  if (error instanceof RepositoryNotFoundError) return refuse("NOT_FOUND", 404);
  if (error instanceof RepositoryRequestError) return refuse(error.code, STATUS[error.code]);
  return undefined;
}
