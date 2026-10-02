import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fromPglite, PgBoss, type ConstructorOptions } from "pg-boss";

import { schema, type Database } from "@startup/db";
import { migrationsFolder } from "@startup/db/migrations";

import { syncQueues } from "../queues";

export { TestClock } from "pg-boss";

type TestQueueOptions = Omit<ConstructorOptions, "db" | "backend" | "migrate" | "connectionString">;

export type TestJobQueue = Awaited<ReturnType<typeof createTestJobQueue>>;

const BASE = { backend: "pglite", supervise: false, schedule: false } as const satisfies ConstructorOptions;

/**
 * In-memory Postgres with the repository migrations, the pg-boss schema, and
 * every queue in QUEUES, plus a started pg-boss instance on the same database.
 *
 * Tests only. Applications never install or migrate pg-boss themselves.
 *
 * pg-boss is installed and the queues created by one instance, then a fresh
 * instance starts, so its queue cache already holds every queue. A `send` that
 * misses the cache queries through pg-boss's own adapter, which waits forever
 * behind a Drizzle transaction on PGlite's single connection.
 */
export async function createTestJobQueue(options: TestQueueOptions = {}) {
  const client = new PGlite();
  await migrate(drizzle({ client, schema }), { migrationsFolder });

  const installer = new PgBoss({ ...BASE, db: fromPglite(client), migrate: true });
  await installer.start();
  await syncQueues(installer);
  await installer.stop({ graceful: false });

  return startOn(client, options);
}

/**
 * Prepares the database of `createTestJobQueue` once, so each test can start
 * from a copy of it. A copy takes about a quarter of the time of building the
 * database again. Create the template in `beforeAll` and close it in
 * `afterAll`.
 */
export async function createTestJobQueueTemplate() {
  const template = await createTestJobQueue();
  await template.boss.stop({ graceful: false });

  return {
    /** A copy of the prepared database, with its own started pg-boss instance. */
    async create(options: TestQueueOptions = {}): Promise<TestJobQueue> {
      return startOn((await template.client.clone()) as PGlite, options);
    },
    close: () => template.client.close(),
  };
}

async function startOn(client: PGlite, options: TestQueueOptions) {
  const db = drizzle({ client, schema });
  const boss = new PgBoss({ ...BASE, ...options, db: fromPglite(client), migrate: false });
  const errors: Error[] = [];
  boss.on("error", (error: Error) => errors.push(error));
  await boss.start();

  return {
    // The PGlite driver stands in for node-postgres: callers use the shared
    // Drizzle Postgres API only, as in @startup/billing's test database.
    db: db as unknown as Database,
    client,
    boss,
    /** Errors pg-boss emitted in the background. */
    errors,
    async close() {
      await boss.stop({ graceful: false });
      await client.close();
    },
  };
}
