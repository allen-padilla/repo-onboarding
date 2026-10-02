# Jobs

## Purpose

Work that must outlive a request, such as analyzing a repository, runs as a job in PostgreSQL through pg-boss. `@startup/jobs` owns pg-boss: it is the only code that imports `pg-boss`.

Short work tied to a request, such as sending an authentication email, still uses Next.js `after()` (`runAfterResponse` in `@startup/auth`).

## Package

`@startup/jobs` is server-only and depends on `@startup/db` and `@startup/env`.

| Export | Purpose |
| --- | --- |
| `createJobQueue(role, options?)` | A pg-boss instance on `DATABASE_URL` for a `producer` or a `worker`. Never migrates. |
| `startJobQueue(queue)` | Starts it, or raises `JobQueueUnavailableError` and stops it. |
| `getJobQueue()` | The process's started producer, created on first use. A failed start is not kept, so the next call tries again. |
| `inTransaction(tx)` | The `db` option that makes a pg-boss call part of a Drizzle transaction. |
| `QUEUES`, `syncQueues(queue)` | The queue registry, and creating or updating its queues. |
| `setJobQueueErrorReporter(reporter)` | Where pg-boss's background errors go, such as Sentry. Without one, they are logged. |
| `JobQueueUnavailableError` | `reason` is `not_installed`, `migration_required`, or `unreachable`. It never carries the connection string or the underlying error. |

`@startup/jobs/testing` exports `createTestJobQueue()` and pg-boss's `TestClock` for tests.

## Roles

| Role | Used by | Options |
| --- | --- | --- |
| `producer` | web processes, which only send | a pool of at most 2 connections; no supervision or schedules |
| `worker` | the worker process | supervision and schedules on |

Every instance opens its own connection pool, separate from `@startup/db`'s. On a serverless host each instance adds connections, so use the provider's pooled connection string. LISTEN/NOTIFY stays off: it does not work through a pooler in transaction mode, and polling is enough.

## Queues

`packages/jobs/src/queues.ts` lists every queue and its options. `pnpm db:migrate` creates the missing ones and applies the options of existing ones, so a web process can send before any worker has started. pg-boss's `createQueue` does nothing for an existing queue, so `syncQueues` uses `updateQueue` for those. A queue's policy and partitioning cannot change after it is created: use a new queue name instead.

A dead-letter queue is listed before the queues that use it.

| Queue | Purpose |
| --- | --- |
| `analysis` | One repository analysis. One retry after an interruption, a 30-second heartbeat, a 16-minute expiry as a backstop, and dead letters to `analysis-failed`. |
| `analysis-failed` | Analyses that failed twice, so their repositories can be marked failed. |
| `onboarding-maintenance` | The hourly maintenance job. |

See `repository-analysis.md` once the analysis exists.

## Schema and Migrations

pg-boss keeps its tables in the `pgboss` schema. pg-boss owns that schema, not Drizzle: `packages/db/src/schema/` never describes it, and `drizzle-kit` ignores it.

`pnpm db:migrate` is the only thing that changes it:

1. The Drizzle migrations in `packages/db/drizzle/`.
2. `pnpm --filter @startup/jobs jobs:migrate` (`packages/jobs/src/migrate.ts`): the pinned pg-boss CLI installs or upgrades the schema, then `syncQueues` creates or updates the queues.

The pg-boss SQL cannot run as a Drizzle migration. It brings its own `BEGIN` and `COMMIT`, and its upgrades can use `CREATE INDEX CONCURRENTLY`, which cannot run inside the single transaction `drizzle-kit migrate` uses.

`jobs:migrate` reads `DATABASE_URL` the way `packages/db/drizzle.config.ts` does: the shell first, then the root `.env.local`. It passes the URL to the CLI through the CLI's environment, never its arguments, and never prints it. It does not load `@startup/env`, so a release environment needs only `DATABASE_URL`.

Applications never install or migrate pg-boss. They run with `migrate: false`, so starting compares the installed schema version with the one the code expects and fails on any difference, in either direction, with `JobQueueUnavailableError`.

To see the SQL a migration would run, without running it:

```bash
pnpm --filter @startup/jobs jobs:plans
```

## Upgrading pg-boss

`pg-boss` is pinned to an exact version. Dependabot opens a separate pull request for it, outside the grouped minor and patch updates (`.github/dependabot.yml`).

Treat every upgrade as a schema change. pg-boss minor releases change the schema version, and processes on the old version cannot start once the database is migrated, nor processes on the new version before it is.

1. Read the release notes. Run `jobs:plans` against a copy of production and review the SQL.
2. Stop the worker.
3. Run `pnpm db:migrate`.
4. Deploy the web application and the worker.

Between steps 3 and 4, web instances that are already running keep their started queue, but new instances cannot start one, and adding or retrying returns `503`. Queued jobs wait for the worker.

Locally, run `pnpm db:migrate` after pulling an upgrade.

## Sending in a Transaction

Send a job in the same transaction that saves the work it refers to, so the two are committed or rolled back together:

```ts
await db.transaction(async (tx) => {
  await tx.insert(repositories).values(row);
  await queue.send(QUEUES.analysis.name, { repositoryId: row.id }, { id: row.jobId, db: inTransaction(tx) });
});
```

`send` needs a started instance: it reads the queue cache that `start()` loads.

## Handlers

- Return nothing. pg-boss stores a handler's return value as the job's output.
- Throw only errors that are safe to store: a type and the step that failed, never content the job processed or a provider's message. pg-boss stores thrown errors with their properties in `pgboss.job`, keeps them for days, and copies them into dead letters.
- A job with heartbeats loses its claim when a heartbeat finds it no longer active, for example after `cancel`. pg-boss then aborts `job.signal`. Pass the signal to everything the handler awaits.
- `stop()` fails the jobs still running before it aborts their handlers. A worker that wants its handlers to stop first aborts them itself, then calls `stop()`.

## Testing

`createTestJobQueue()` gives a test in-memory PGlite with the repository migrations, the pg-boss schema, every queue, and a started instance on the same database. Tests never open network connections (`src/testing/no-network.ts`).

The helper installs pg-boss and the queues with one instance, then starts a fresh one so its queue cache already holds every queue. A `send` that misses the cache queries through pg-boss's own adapter, which waits forever behind a Drizzle transaction on PGlite's single connection.

`createTestJobQueueTemplate()` prepares that database once, in `beforeAll`, and gives each test a copy of it with its own started instance. A copy takes about a quarter of the time of building the database, which keeps suites with many tests within CI's time limits.

PGlite has one connection, so tests cannot show what happens when several workers claim jobs at once. That needs real Postgres.
