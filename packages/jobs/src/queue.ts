import { PgBoss, type ConstructorOptions } from "pg-boss";

import { serverEnv } from "@startup/env";

import { JobQueueUnavailableError, type JobQueueUnavailableReason } from "./errors";

export type JobQueue = PgBoss;

/**
 * `producer`: web processes, which only send. `worker`: the worker process,
 * which also runs pg-boss's supervision and schedules.
 */
export type JobQueueRole = "producer" | "worker";

export type JobQueueErrorReporter = (error: Error) => void;

const ROLE_OPTIONS = {
  // Every serverless instance opens its own pool, so keep it small.
  producer: { max: 2, supervise: false, schedule: false },
  worker: { supervise: true, schedule: true },
} as const satisfies Record<JobQueueRole, ConstructorOptions>;

// Next.js bundles instrumentation separately from route handlers, so module
// state is not shared between them. The producer and the reporter live on
// globalThis instead, as in @startup/auth's email failure reporter.
const PRODUCER = Symbol.for("@startup/jobs/producer");
const REPORTER = Symbol.for("@startup/jobs/error-reporter");

type Registry = typeof globalThis & {
  [PRODUCER]?: Promise<JobQueue>;
  [REPORTER]?: JobQueueErrorReporter;
};

/**
 * Sets where background errors from pg-boss are reported, such as Sentry.
 * Without a reporter, they are logged.
 */
export function setJobQueueErrorReporter(reporter: JobQueueErrorReporter) {
  (globalThis as Registry)[REPORTER] = reporter;
}

function reportError(error: Error) {
  const reporter = (globalThis as Registry)[REPORTER];

  try {
    if (reporter) reporter(error);
    else console.error(`[jobs] ${error.name}: ${error.message}`);
  } catch {
    // Reporting must never turn a background error into a crash.
  }
}

/**
 * Creates a pg-boss instance for `role` on `DATABASE_URL`. It never installs
 * or migrates pg-boss: `pnpm db:migrate` does that as a release step, and
 * `start()` fails when the schema is missing or at another version.
 */
export function createJobQueue(
  role: JobQueueRole,
  options: Omit<ConstructorOptions, "migrate"> = {},
): JobQueue {
  const queue = new PgBoss({
    connectionString: serverEnv.DATABASE_URL,
    application_name: `jobs-${role}`,
    ...ROLE_OPTIONS[role],
    ...options,
    migrate: false,
  });

  queue.on("error", reportError);
  return queue;
}

/**
 * Starts `queue`, raising `JobQueueUnavailableError` when it cannot start. A
 * queue that failed to start is stopped, so it holds no connections.
 */
export async function startJobQueue(queue: JobQueue): Promise<JobQueue> {
  try {
    return await queue.start();
  } catch (error) {
    await queue.stop({ graceful: false }).catch(() => undefined);
    throw new JobQueueUnavailableError(unavailableReason(error));
  }
}

// pg-boss 12 raises these from its schema check when `migrate` is false.
function unavailableReason(error: unknown): JobQueueUnavailableReason {
  const message = error instanceof Error ? error.message : "";

  if (message === "pg-boss is not installed") return "not_installed";
  if (message === "pg-boss database requires migrations") return "migration_required";
  return "unreachable";
}

/**
 * The started producer for this process, created on first use. When it cannot
 * start, the call raises `JobQueueUnavailableError` and the next call tries
 * again.
 */
export function getJobQueue(): Promise<JobQueue> {
  return startShared(() => createJobQueue("producer"));
}

/**
 * Starts the process's shared queue from `create` once, keeping the started
 * queue for later calls. A failed start is not kept. Exported for tests.
 */
export function startShared(create: () => JobQueue): Promise<JobQueue> {
  const registry = globalThis as Registry;
  const existing = registry[PRODUCER];
  if (existing) return existing;

  const started = startJobQueue(create()).catch((error: unknown) => {
    if (registry[PRODUCER] === started) delete registry[PRODUCER];
    throw error;
  });

  registry[PRODUCER] = started;
  return started;
}
