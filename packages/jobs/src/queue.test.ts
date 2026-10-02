import { randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { fromPglite } from "pg-boss";
import { afterEach, describe, expect, it } from "vitest";

import { sql } from "@startup/db";

import { JobQueueUnavailableError } from "./errors";
import { createJobQueue, getJobQueue, startJobQueue, startShared } from "./queue";
import { QUEUES, syncQueues } from "./queues";
import { createTestJobQueue, createTestJobQueueTemplate } from "./testing/queue";
import { inTransaction } from "./transaction";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function testQueue() {
  const queue = await createTestJobQueue();
  cleanups.push(queue.close);
  return queue;
}

async function findJob(boss: Awaited<ReturnType<typeof testQueue>>["boss"], id: string) {
  const [job] = await boss.findJobs(QUEUES.analysis.name, { id });
  return job;
}

describe("sending inside a Drizzle transaction", () => {
  it("saves the job when the transaction commits", async () => {
    const { db, boss } = await testQueue();
    const id = randomUUID();

    await db.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      await boss.send(QUEUES.analysis.name, { repositoryId: "r1" }, { id, db: inTransaction(tx) });
    });

    const job = await findJob(boss, id);
    expect(job?.state).toBe("created");
    expect(job?.data).toEqual({ repositoryId: "r1" });
  });

  it("discards the job when the transaction rolls back", async () => {
    const { db, boss } = await testQueue();
    const id = randomUUID();

    await expect(
      db.transaction(async (tx) => {
        await boss.send(QUEUES.analysis.name, { repositoryId: "r1" }, { id, db: inTransaction(tx) });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect(await findJob(boss, id)).toBeUndefined();
  });
});

describe("starting an application queue", () => {
  it("refuses to start when pg-boss is not installed", async () => {
    const client = new PGlite();
    cleanups.push(() => client.close());

    const queue = createJobQueue("worker", { db: fromPglite(client), backend: "pglite" });

    await expect(startJobQueue(queue)).rejects.toMatchObject({
      name: "JobQueueUnavailableError",
      reason: "not_installed",
    });
    // Never installed by an application process.
    const { rows } = await client.query("select to_regclass('pgboss.version') as name");
    expect(rows).toEqual([{ name: null }]);
  });

  it("refuses to start when pg-boss is at another schema version", async () => {
    const { client } = await testQueue();
    await client.query("update pgboss.version set version = version - 1");

    const queue = createJobQueue("worker", { db: fromPglite(client), backend: "pglite" });

    await expect(startJobQueue(queue)).rejects.toMatchObject({
      name: "JobQueueUnavailableError",
      reason: "migration_required",
    });
  });

  it("reports an unreachable database without the underlying error", async () => {
    const queue = createJobQueue("producer", { db: unreachableDatabase(), backend: "pglite" });

    const error = await startJobQueue(queue).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JobQueueUnavailableError);
    expect(error).toMatchObject({ reason: "unreachable" });
    expect(String((error as Error).message)).not.toContain("127.0.0.1");
    expect(error).not.toHaveProperty("cause");
  });
});

describe("the shared producer", () => {
  it("keeps a started queue for later calls", async () => {
    const { client } = await testQueue();
    const queue = startShared(() => createJobQueue("producer", { db: fromPglite(client), backend: "pglite" }));
    cleanups.push(async () => {
      await (await queue).stop({ graceful: false });
      clearShared();
    });

    expect(startShared(() => unreachableQueue())).toBe(queue);
    await expect(queue).resolves.toBeDefined();
  });

  it("does not keep a queue that failed to start, so the next call tries again", async () => {
    const first = startShared(() => unreachableQueue());
    await expect(first).rejects.toBeInstanceOf(JobQueueUnavailableError);

    const second = startShared(() => unreachableQueue());
    expect(second).not.toBe(first);
    await expect(second).rejects.toBeInstanceOf(JobQueueUnavailableError);
  });

  it("is what getJobQueue returns", async () => {
    const { client } = await testQueue();
    const queue = startShared(() => createJobQueue("producer", { db: fromPglite(client), backend: "pglite" }));
    cleanups.push(async () => {
      await (await queue).stop({ graceful: false });
      clearShared();
    });

    expect(getJobQueue()).toBe(queue);
  });
});

// A database adapter whose every statement fails, as when the server is down.
function unreachableDatabase() {
  return {
    async executeSql(): Promise<{ rows: unknown[] }> {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    },
  };
}

function unreachableQueue() {
  return createJobQueue("producer", { db: unreachableDatabase(), backend: "pglite" });
}

function clearShared() {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("@startup/jobs/producer")];
}

describe("syncQueues", () => {
  it("creates every queue in the registry with its options", async () => {
    const { boss } = await testQueue();

    const analysis = await boss.getQueue(QUEUES.analysis.name);
    expect(analysis).toMatchObject({
      retryLimit: 1,
      retryDelay: 0,
      heartbeatSeconds: 30,
      expireInSeconds: 960,
      deadLetter: QUEUES.analysisFailed.name,
    });
    expect(await boss.getQueue(QUEUES.analysisFailed.name)).not.toBeNull();
    expect(await boss.getQueue(QUEUES.onboardingMaintenance.name)).not.toBeNull();
  });

  it("applies changed options to queues that already exist", async () => {
    const { boss } = await testQueue();

    const results = await syncQueues(boss, [
      { name: QUEUES.analysis.name, options: { ...QUEUES.analysis.options, retryLimit: 3 } },
      { name: "new-queue", options: { retryLimit: 0 } },
    ]);

    expect(results).toEqual([
      { name: QUEUES.analysis.name, action: "updated" },
      { name: "new-queue", action: "created" },
    ]);
    expect(await boss.getQueue(QUEUES.analysis.name)).toMatchObject({ retryLimit: 3 });
    expect(await boss.getQueue("new-queue")).toMatchObject({ retryLimit: 0 });
  });
});

describe("createTestJobQueueTemplate", () => {
  it("gives each test its own copy of the prepared database", async () => {
    const template = await createTestJobQueueTemplate();
    cleanups.push(template.close);

    const first = await template.create();
    cleanups.push(first.close);
    const second = await template.create();
    cleanups.push(second.close);

    const id = randomUUID();
    await first.boss.send(QUEUES.analysis.name, { repositoryId: "r1" }, { id });

    expect(await findJob(first.boss, id)).toBeDefined();
    expect(await findJob(second.boss, id)).toBeUndefined();
    expect(await second.boss.getQueue(QUEUES.analysis.name)).toMatchObject({ retryLimit: 1 });
  });
});
