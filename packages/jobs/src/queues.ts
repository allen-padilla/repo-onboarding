import type { PgBoss, Queue } from "pg-boss";

// Imports only pg-boss types, so the release script can use it without loading
// the validated environment.

/** A queue and the options it is created or updated with. */
export interface QueueDefinition {
  readonly name: string;
  readonly options: Omit<Queue, "name" | "policy" | "partition">;
}

const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;

/**
 * Every queue the application uses. `jobs:migrate` creates them and keeps their
 * options in step, so a web process can send before any worker has started.
 * A dead-letter queue comes before the queues that use it.
 */
export const QUEUES = {
  analysisFailed: {
    name: "analysis-failed",
    options: { retryLimit: 2, retentionSeconds: 30 * DAY },
  },
  analysis: {
    name: "analysis",
    options: {
      // One retry after an interruption: a crash, a lost heartbeat, or a
      // deploy. A second interruption sends the job to `analysis-failed`.
      retryLimit: 1,
      retryDelay: 0,
      heartbeatSeconds: 30,
      // A backstop. The handler stops itself after 15 minutes.
      expireInSeconds: 16 * MINUTE,
      // Jobs still waiting after this are deleted. The maintenance job fails
      // their repositories long before.
      retentionSeconds: 30 * DAY,
      deadLetter: "analysis-failed",
    },
  },
  onboardingMaintenance: {
    name: "onboarding-maintenance",
    options: { retryLimit: 1, expireInSeconds: 5 * MINUTE },
  },
} as const satisfies Record<string, QueueDefinition>;

export interface QueueSyncResult {
  readonly name: string;
  readonly action: "created" | "updated";
}

/**
 * Creates each missing queue and applies the options of each existing one.
 * `createQueue` does nothing for a queue that already exists, so changed
 * options only reach the database through `updateQueue`.
 */
export async function syncQueues(
  boss: PgBoss,
  definitions: readonly QueueDefinition[] = Object.values(QUEUES),
): Promise<QueueSyncResult[]> {
  const results: QueueSyncResult[] = [];

  for (const { name, options } of definitions) {
    if (await boss.getQueue(name)) {
      await boss.updateQueue(name, options);
      results.push({ name, action: "updated" });
    } else {
      await boss.createQueue(name, options);
      results.push({ name, action: "created" });
    }
  }

  return results;
}
