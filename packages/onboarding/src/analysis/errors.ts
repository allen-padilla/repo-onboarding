import type { FailureReason } from "../repositories";

// pg-boss stores what a job handler throws, with its properties, in
// `pgboss.job.output`, and dead-lettering copies it. Handlers therefore throw
// only these errors: a step and an error type, never a message from GitHub,
// TypeSafe, Anthropic, or the database, and never repository content.

export type AnalysisStep =
  | "start"
  | "repository"
  | "listing"
  | "attributes"
  | "download"
  | "scoring"
  | "writing"
  | "saving";

/** How many files were listed, dropped, left unscored by the limit, and ranked by local signals only. */
export interface Coverage {
  readonly listed: number;
  readonly dropped: number;
  readonly unscored: number;
  readonly localOnly: number;
}

/**
 * An expected failure. The repository is marked failed with `reason`, and the
 * job completes: retrying it would fail the same way.
 */
export class AnalysisFailure extends Error {
  readonly reason: FailureReason;
  readonly coverage: Coverage | undefined;

  constructor(reason: FailureReason, coverage?: Coverage) {
    super(`The analysis failed: ${reason}.`);
    this.name = "AnalysisFailure";
    this.reason = reason;
    this.coverage = coverage;
  }
}

/** An unexpected error, reduced to the step that failed and the error's type. */
export class AnalysisError extends Error {
  readonly step: AnalysisStep;
  readonly type: string;

  constructor(step: AnalysisStep, error: unknown) {
    const type = errorType(error);
    super(`The analysis failed at step "${step}" with ${type}.`);
    this.name = "AnalysisError";
    this.step = step;
    this.type = type;
  }
}

export type InterruptionReason = "shutdown" | "claim_lost";

/**
 * The run stopped before it finished: the worker is shutting down, or the job
 * is no longer this run's (deleted, cancelled, or retried after a lost
 * heartbeat).
 */
export class AnalysisInterruptedError extends Error {
  readonly reason: InterruptionReason;

  constructor(reason: InterruptionReason) {
    super(
      reason === "shutdown"
        ? "The analysis was interrupted because the worker stopped."
        : "The analysis stopped because its job is no longer active.",
    );
    this.name = "AnalysisInterruptedError";
    this.reason = reason;
  }
}

// An error's class name, such as `GitHubUnavailableError` or `TypeError`. Never
// its message.
function errorType(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Error";
}
