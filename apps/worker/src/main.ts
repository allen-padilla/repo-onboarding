// The order of these imports matters: the environment is loaded before
// anything validates it, and Sentry starts before the code it reports on.
import "./load-env";
import { closeSentry, reportAnalysisError, reportError } from "./sentry";

import { setTimeout as delay } from "node:timers/promises";

import {
  createJobQueue,
  JobQueueUnavailableError,
  setJobQueueErrorReporter,
  startJobQueue,
  type JobQueue,
  type JobQueueUnavailableReason,
} from "@startup/jobs";
import { startAnalysisWorker, type AnalysisWorker } from "@startup/onboarding/worker";

// Runs repository analyses until it receives SIGTERM or SIGINT. See
// docs/architecture/repository-analysis.md and deployment.md.

const RETRY_DELAY_MS = 5_000;
// How long interrupted analyses get to save their state before pg-boss stops.
const HANDLER_STOP_TIMEOUT_MS = 15_000;
// pg-boss's own limit for settling the jobs still active when it stops.
const STOP_TIMEOUT_MS = 30_000;

const WAITING: Record<JobQueueUnavailableReason, string> = {
  unreachable: "the database is unreachable",
  not_installed: "pg-boss is not installed (run pnpm db:migrate)",
  migration_required: "the pg-boss schema is at another version (run pnpm db:migrate)",
};

const stopping = new AbortController();
let starting: Promise<void> = Promise.resolve();
let queue: JobQueue | undefined;
let worker: AnalysisWorker | undefined;

setJobQueueErrorReporter(reportError);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void stop(signal));
}

starting = start();
try {
  await starting;
} catch (error) {
  // A start-up cut short by a signal is not a failure: stop() exits.
  if (!stopping.signal.aborted) {
    reportError(error instanceof Error ? error : new Error("The worker failed to start."));
    console.error("[worker] failed to start");
    await closeSentry();
    process.exit(1);
  }
}

// Waits for the database and the pg-boss schema, so the worker can start
// before either is ready, as with `pnpm dev`.
async function start() {
  while (!stopping.signal.aborted) {
    try {
      queue = await startJobQueue(createJobQueue("worker"));
      break;
    } catch (error) {
      if (!(error instanceof JobQueueUnavailableError)) throw error;
      console.log(`[worker] waiting: ${WAITING[error.reason]}; trying again in 5 seconds`);
      await delay(RETRY_DELAY_MS, undefined, { signal: stopping.signal }).catch(() => undefined);
    }
  }
  if (!queue || stopping.signal.aborted) return;

  worker = await startAnalysisWorker(queue, { report: reportAnalysisError });
  console.log("worker ready");
}

// Stops claiming jobs and interrupts running analyses. Each returns its
// repository to `queued` and fails its job into the retry, so it starts over
// on the next worker. Then pg-boss stops.
async function stop(signal: NodeJS.Signals) {
  if (stopping.signal.aborted) return;
  stopping.abort();
  console.log(`[worker] ${signal}: stopping`);

  // A start-up in progress finishes first, so whatever it started is stopped.
  await starting.catch(() => undefined);

  let code = 0;
  try {
    // A handler that does not return in time is failed into its retry by
    // pg-boss's stop.
    await Promise.race([worker?.stop(), delay(HANDLER_STOP_TIMEOUT_MS)]);
    await queue?.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
  } catch (error) {
    code = 1;
    reportError(error instanceof Error ? error : new Error("The worker failed to stop."));
  }
  await closeSentry();
  process.exit(code);
}
