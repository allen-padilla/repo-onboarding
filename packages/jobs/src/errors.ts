// Errors never include the connection string or the underlying database
// error, so they are safe to log and report. They deliberately have no
// `cause`, as in @startup/email.

export type JobQueueUnavailableReason =
  | "not_installed"
  | "migration_required"
  | "unreachable";

const MESSAGES: Record<JobQueueUnavailableReason, string> = {
  not_installed: "pg-boss is not installed. Run pnpm db:migrate.",
  migration_required: "pg-boss is at another schema version. Run pnpm db:migrate.",
  unreachable: "the database could not be reached.",
};

/** The job queue could not start. */
export class JobQueueUnavailableError extends Error {
  readonly reason: JobQueueUnavailableReason;

  constructor(reason: JobQueueUnavailableReason) {
    super(`The job queue is not available: ${MESSAGES[reason]}`);
    this.name = "JobQueueUnavailableError";
    this.reason = reason;
  }
}
