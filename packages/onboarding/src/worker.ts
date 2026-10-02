import { setTimeout as delay } from "node:timers/promises";

import { db } from "@startup/db";
import { createDecisionClient } from "@startup/decision";
import { createGenerationClient, isGenerationConfigured } from "@startup/generation";
import { createGitHubClient } from "@startup/github";
import { QUEUES, type Job, type JobQueue, type JobWithMetadata } from "@startup/jobs";

import type { AnalysisError } from "./analysis/errors";
import { createAnalysisHandlers, type AnalysisWorkerDependencies } from "./analysis/handlers";
import type { AnalysisJobData } from "./queue";
import { ANALYSIS_TIME_LIMIT_MS, HEARTBEAT_REFRESH_SECONDS } from "./limits";

export { AnalysisError, AnalysisInterruptedError, type AnalysisStep } from "./analysis/errors";
export type { AnalysisWorkerDependencies } from "./analysis/handlers";

/** Analyses one worker process runs at once. */
const LOCAL_CONCURRENCY = 4;

// Every hour, on the hour.
const MAINTENANCE_SCHEDULE = "0 * * * *";

const WORK_QUEUES = [QUEUES.analysis, QUEUES.analysisFailed, QUEUES.onboardingMaintenance];

export interface AnalysisWorker {
  /**
   * Stops claiming jobs, interrupts every running analysis, and waits for each
   * to return its repository to `queued` and fail its job into the retry.
   * Call `stop()` on the queue afterwards.
   */
  stop(): Promise<void>;
}

/**
 * Runs analyses on the started `queue`: the `analysis`, `analysis-failed`, and
 * `onboarding-maintenance` handlers, and the hourly maintenance schedule.
 * Dependencies default to the real database and clients. Ranking uses
 * TypeSafe when it is configured, and the walkthrough is written when the
 * writing model is.
 */
export async function startAnalysisWorker(
  queue: JobQueue,
  options: Partial<AnalysisWorkerDependencies> = {},
): Promise<AnalysisWorker> {
  const deps: AnalysisWorkerDependencies = {
    db: options.db ?? db,
    github: options.github ?? createGitHubClient(),
    // Without TYPESAFE_* the first request raises a configuration error, and
    // every file is ranked by local signals.
    decision: options.decision !== undefined ? options.decision : createDecisionClient(),
    generation: options.generation !== undefined ? options.generation : isGenerationConfigured() ? createGenerationClient() : null,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? sleep,
    timeLimitMs: options.timeLimitMs ?? ANALYSIS_TIME_LIMIT_MS,
    report: options.report ?? logError,
  };

  const shutdown = new AbortController();
  const handlers = createAnalysisHandlers(queue, deps, shutdown.signal);

  await queue.work(QUEUES.analysisFailed.name, { includeMetadata: true }, async ([job]: JobWithMetadata<AnalysisJobData>[]) => {
    if (job) await handlers.analysisFailed(job);
  });
  await queue.work(QUEUES.onboardingMaintenance.name, async () => {
    await handlers.maintenance();
  });
  await queue.schedule(QUEUES.onboardingMaintenance.name, MAINTENANCE_SCHEDULE);

  // pg-boss runs one job per user at a time across workers (the user is the
  // job's group), and the handler checks again under the user's lock.
  await queue.work(
    QUEUES.analysis.name,
    { localConcurrency: LOCAL_CONCURRENCY, groupConcurrency: 1, heartbeatRefreshSeconds: HEARTBEAT_REFRESH_SECONDS },
    async ([job]: Job<AnalysisJobData>[]) => {
      if (job) await handlers.analysis(job);
    },
  );

  return {
    async stop() {
      for (const { name } of WORK_QUEUES) await queue.offWork(name, { wait: false });
      shutdown.abort();
      // offWork with `wait` resolves once each handler has returned and pg-boss
      // has settled its job.
      await Promise.all(WORK_QUEUES.map(({ name }) => queue.offWork(name, { wait: true })));
    },
  };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  }
}

function logError(error: AnalysisError, { repositoryId }: { repositoryId: string }) {
  console.error(`[analysis] ${repositoryId}: ${error.message}`);
}
