import { randomUUID } from "node:crypto";

import { schema, sql, type Database } from "@startup/db";
import { GitHubRateLimitError } from "@startup/github";
import { QUEUES, type Job, type JobQueue, type JobWithMetadata } from "@startup/jobs";

import {
  BUSY_REQUEUE_SECONDS,
  GITHUB_RATE_LIMIT_REQUEUES,
  STUCK_ANALYSIS_MINUTES,
} from "../limits";
import { sendAnalysis, type AnalysisJobData } from "../queue";
import { lockUser, type FailureReason, type Transaction } from "../repositories";
import { AnalysisError, AnalysisFailure, AnalysisInterruptedError, type AnalysisStep, type Coverage } from "./errors";
import { runAnalysis, type AnalysisDependencies, type AnalysisOutcome, type AnalysisTarget } from "./run";

const { analysisRequests, repositories } = schema;

export interface AnalysisWorkerDependencies extends AnalysisDependencies {
  readonly db: Database;
  /** An analysis still running after this fails as timed out. */
  readonly timeLimitMs: number;
  /** Receives unexpected errors, already reduced to a step and a type. */
  readonly report: (error: AnalysisError, context: { readonly repositoryId: string }) => void;
}

// A finished job stays in pg-boss for days; these states are final.
const FINISHED_JOB_STATES = new Set(["completed", "cancelled", "failed"]);

/**
 * The job handlers for `analysis`, `analysis-failed`, and
 * `onboarding-maintenance`. `shutdown` aborts every running analysis: each
 * returns its repository to `queued` and throws, so pg-boss retries it.
 */
export function createAnalysisHandlers(queue: JobQueue, deps: AnalysisWorkerDependencies, shutdown: AbortSignal) {
  const { db } = deps;
  type RepositoryUpdate = Parameters<ReturnType<typeof db.update<typeof repositories>>["set"]>[0];

  // Every write a run makes matches its job and attempt, so a stale run can
  // never overwrite a retry of the same job, a re-queued job, or a deleted
  // repository.
  const ownedBy = (job: Job<AnalysisJobData>) =>
    sql`${repositories.id} = ${job.data.repositoryId}
      and ${repositories.jobId} = ${job.id}
      and ${repositories.jobAttempt} = ${job.retryCount}`;

  // Every pg-boss retry of an analysis follows an interrupted run: a crash, a
  // lost heartbeat, a shutdown, or an unexpected error. A re-queued job starts
  // its retry count again, so runs interrupted under earlier jobs count too.
  const retryLimit = QUEUES.analysis.options.retryLimit;
  const attempt = (job: Job<AnalysisJobData>) => (job.data.interruptions ?? 0) + job.retryCount;
  const isLastAttempt = (job: Job<AnalysisJobData>) => attempt(job) >= retryLimit;

  async function save(job: Job<AnalysisJobData>, values: RepositoryUpdate) {
    await db
      .update(repositories)
      .set({ ...values, updatedAt: sql`now()` })
      .where(ownedBy(job));
  }

  const failed = (reason: FailureReason, coverage?: Coverage) => ({
    status: "failed" as const,
    failureReason: reason,
    finishedAt: sql`now()`,
    ...(coverage ? counts(coverage) : {}),
  });

  const done = ({ coverage, walkthrough }: AnalysisOutcome) => ({
    status: "done" as const,
    failureReason: null,
    finishedAt: sql`now()`,
    ...counts(coverage),
    walkthrough,
  });

  // The run is over without a result: the retry starts the analysis again, and
  // after the last attempt it fails.
  const abandoned = (job: Job<AnalysisJobData>) =>
    isLastAttempt(job) ? failed("unexpected") : { status: "queued" as const, startedAt: null };

  /**
   * Starts the run in a transaction that holds the user's lock. Returns `null`
   * when there is nothing to run: the repository is gone, has another job, or
   * was queued again because another of the user's analyses is running or the
   * worker is stopping.
   */
  async function claim(job: Job<AnalysisJobData>): Promise<AnalysisTarget | null> {
    const { repositoryId } = job.data;
    const current = sql`${repositories.id} = ${repositoryId} and ${repositories.jobId} = ${job.id}`;

    return db.transaction(async (tx) => {
      const [owner] = await tx.select({ userId: repositories.userId }).from(repositories).where(current);
      if (!owner) return null;
      await lockUser(tx, owner.userId);

      const [row] = await tx
        .select({
          owner: repositories.owner,
          name: repositories.name,
          commitSha: repositories.commitSha,
          status: repositories.status,
        })
        .from(repositories)
        .where(current)
        .for("update");
      if (!row || (row.status !== "queued" && row.status !== "running")) return null;

      // Interrupted more often than the retry allows, across re-queued jobs.
      if (attempt(job) > retryLimit) {
        await tx
          .update(repositories)
          .set({ ...failed("unexpected"), updatedAt: sql`now()` })
          .where(current);
        return null;
      }

      // A job claimed while the worker stops has not started: it goes back to
      // the queue without using its retry.
      const delay = shutdown.aborted ? 0 : (await otherRunning(tx, owner.userId, repositoryId)) ? BUSY_REQUEUE_SECONDS : null;
      if (delay !== null) {
        await requeue(tx, job, { userId: owner.userId, startAfter: delay });
        return null;
      }

      await tx
        .update(repositories)
        .set({ status: "running", jobAttempt: job.retryCount, startedAt: sql`now()`, updatedAt: sql`now()` })
        .where(current);
      return { owner: row.owner, name: row.name, commitSha: row.commitSha };
    });
  }

  async function otherRunning(tx: Transaction, userId: string, repositoryId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(sql`${repositories.userId} = ${userId} and ${repositories.status} = 'running' and ${repositories.id} <> ${repositoryId}`)
      .limit(1);
    return rows.length > 0;
  }

  // Replaces the repository's job with a new one that starts later. The current
  // job then completes without doing anything.
  async function requeue(
    tx: Transaction,
    job: Job<AnalysisJobData>,
    { userId, startAfter, rateLimitDeferrals = job.data.rateLimitDeferrals }: { userId: string; startAfter: Date | number; rateLimitDeferrals?: number },
  ) {
    const jobId = randomUUID();
    await tx
      .update(repositories)
      .set({ jobId, status: "queued", jobAttempt: null, startedAt: null, updatedAt: sql`now()` })
      .where(sql`${repositories.id} = ${job.data.repositoryId} and ${repositories.jobId} = ${job.id}`);
    await sendAnalysis(queue, tx, {
      repositoryId: job.data.repositoryId,
      userId,
      jobId,
      startAfter,
      ...(rateLimitDeferrals ? { rateLimitDeferrals } : {}),
      // The current run is not an interruption: it has not started, or it
      // stopped for a rate limit.
      ...(attempt(job) ? { interruptions: attempt(job) } : {}),
    });
  }

  // GitHub's limit resets later than the run could wait: try again after the
  // reset, a bounded number of times.
  async function rateLimited(job: Job<AnalysisJobData>, error: GitHubRateLimitError) {
    const deferrals = job.data.rateLimitDeferrals ?? 0;
    if (deferrals >= GITHUB_RATE_LIMIT_REQUEUES) {
      await save(job, failed("github_rate_limit"));
      return;
    }

    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ userId: repositories.userId })
        .from(repositories)
        .where(ownedBy(job))
        .for("update");
      if (row) await requeue(tx, job, { userId: row.userId, startAfter: error.resetAt, rateLimitDeferrals: deferrals + 1 });
    });
  }

  async function run(job: Job<AnalysisJobData>, progress: { step: AnalysisStep }): Promise<void> {
    const target = await claim(job);
    if (!target) return;

    const timeLimit = AbortSignal.timeout(deps.timeLimitMs);
    const signal = AbortSignal.any([job.signal, shutdown, timeLimit]);
    const deadline = deps.now() + deps.timeLimitMs;

    let outcome: AnalysisOutcome;
    try {
      outcome = await runAnalysis(target, deps, { signal, deadline, progress });
    } catch (error) {
      // Deleted, cancelled, or retried elsewhere: nothing this run saves is kept.
      if (job.signal.aborted) throw new AnalysisInterruptedError("claim_lost");
      if (shutdown.aborted) {
        await save(job, abandoned(job));
        throw new AnalysisInterruptedError("shutdown");
      }
      if (timeLimit.aborted) return save(job, failed("timed_out"));
      if (error instanceof AnalysisFailure) return save(job, failed(error.reason, error.coverage));
      if (error instanceof GitHubRateLimitError) return rateLimited(job, error);

      const sanitized = new AnalysisError(progress.step, error);
      deps.report(sanitized, { repositoryId: job.data.repositoryId });
      try {
        await save(job, abandoned(job));
      } catch {
        // Already reported. The retry, or the dead-letter handler after the
        // last attempt, settles the repository.
      }
      throw sanitized;
    }

    if (job.signal.aborted) throw new AnalysisInterruptedError("claim_lost");
    progress.step = "saving";
    await save(job, done(outcome));
  }

  return {
    /** Runs one analysis. Throws only errors that are safe for pg-boss to store. */
    async analysis(job: Job<AnalysisJobData>): Promise<void> {
      const progress: { step: AnalysisStep } = { step: "start" };
      try {
        await run(job, progress);
      } catch (error) {
        if (error instanceof AnalysisInterruptedError || error instanceof AnalysisError) throw error;
        const sanitized = new AnalysisError(progress.step, error);
        deps.report(sanitized, { repositoryId: job.data.repositoryId });
        throw sanitized;
      }
    },

    /** An analysis job failed for the last time: its repository fails, if the job is still its own. */
    async analysisFailed(job: JobWithMetadata<AnalysisJobData>): Promise<void> {
      if (!job.sourceId) return;

      try {
        await db
          .update(repositories)
          .set({ ...failed("unexpected"), updatedAt: sql`now()` })
          .where(sql`${repositories.id} = ${job.data.repositoryId}
            and ${repositories.jobId} = ${job.sourceId}
            and ${repositories.status} in ('queued', 'running')`);
      } catch (error) {
        throw new AnalysisError("saving", error);
      }
    },

    /**
     * Hourly: deletes requests the limits no longer count, and fails analyses
     * that have been queued or running too long without a job that could
     * still finish them.
     */
    async maintenance(): Promise<void> {
      try {
        await db.delete(analysisRequests).where(sql`${analysisRequests.createdAt} < now() - interval '24 hours'`);

        const stale = sql`${repositories.status} in ('queued', 'running')
          and ${repositories.updatedAt} < now() - make_interval(mins => ${STUCK_ANALYSIS_MINUTES})`;
        const candidates = await db
          .select({ id: repositories.id, jobId: repositories.jobId })
          .from(repositories)
          .where(stale);

        for (const { id, jobId } of candidates) {
          const [job] = await queue.findJobs(QUEUES.analysis.name, { id: jobId });
          if (job && !FINISHED_JOB_STATES.has(job.state)) continue;

          await db
            .update(repositories)
            .set({ ...failed("unexpected"), updatedAt: sql`now()` })
            .where(sql`${repositories.id} = ${id} and ${repositories.jobId} = ${jobId} and ${stale}`);
        }
      } catch (error) {
        throw new AnalysisError("saving", error);
      }
    },
  };
}

function counts(coverage: Coverage) {
  return {
    listedCount: coverage.listed,
    droppedCount: coverage.dropped,
    unscoredCount: coverage.unscored,
    localOnlyCount: coverage.localOnly,
  };
}
