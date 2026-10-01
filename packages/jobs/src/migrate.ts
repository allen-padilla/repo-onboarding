// Release step, run by `pnpm db:migrate` after the Drizzle migrations: migrates
// the pg-boss schema with the pinned pg-boss CLI, then creates or updates every
// queue in QUEUES. Applications never do either when they start. With
// `--plans`, prints the pending pg-boss SQL for review and changes nothing.
// See docs/architecture/jobs.md.
//
// DATABASE_URL comes from the shell, then the root .env.local, as in
// packages/db/drizzle.config.ts. It reaches the CLI through its environment,
// never its arguments, and is never printed. This script does not load
// @startup/env, so a release environment needs only DATABASE_URL.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PgBoss } from "pg-boss";

import { syncQueues } from "./queues";

async function main(): Promise<number> {
  const envFile = fileURLToPath(new URL("../../../.env.local", import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required.");
    return 1;
  }

  const plansOnly = process.argv.includes("--plans");
  const cli = fileURLToPath(new URL("../node_modules/pg-boss/dist/cli.js", import.meta.url));

  const result = spawnSync(
    process.execPath,
    [cli, "migrate", ...(plansOnly ? ["--dry-run"] : [])],
    {
      stdio: "inherit",
      env: { ...process.env, PGBOSS_DATABASE_URL: databaseUrl },
    },
  );

  if (result.status !== 0 || plansOnly) {
    return result.status ?? 1;
  }

  const boss = new PgBoss({
    connectionString: databaseUrl,
    application_name: "jobs-migrate",
    migrate: false,
    supervise: false,
    schedule: false,
    max: 1,
  });
  boss.on("error", (error: Error) => console.error(`[jobs] ${error.name}: ${error.message}`));

  await boss.start();
  try {
    for (const { name, action } of await syncQueues(boss)) {
      console.log(`Queue "${name}" ${action}.`);
    }
  } finally {
    await boss.stop({ graceful: false });
  }

  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Never the connection string: only the error's name and message.
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Migration failed.");
    process.exitCode = 1;
  },
);
