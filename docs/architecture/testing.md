# Testing

## Fast Verification

The canonical local verification command is:

`pnpm verify`

It runs:

- agent harness check (`pnpm agent:check`, see `agent-workflows.md`)
- lint
- TypeScript type checking
- fast automated tests
- production build

Agents must run this before considering implementation complete.

## Full Verification

Also run `pnpm verify:full` for changes affecting significant application behavior or complete user workflows, including authentication, billing, routing, and other cross-system or user-facing behavior.

`pnpm verify:full` runs `pnpm verify` and then the Playwright end-to-end tests. Documentation-only changes do not require it.

## Unit and Integration Tests

Vitest is used for fast unit and integration-level tests.

Tests should generally live close to the implementation they exercise.

Unit and integration tests never open a network connection. Packages that talk to external services inject fakes. `@startup/email`, `@startup/auth`, and `@startup/jobs` also load a setup file (`src/testing/no-network.ts`) that fails any test that tries to connect. Databases run in memory with PGlite. Tests that need the job queue use `createTestJobQueue()` from `@startup/jobs/testing`, which runs pg-boss on the same PGlite database. Suites with many tests use `createTestJobQueueTemplate()`, which builds that database once and gives each test a copy.

`apps/web` unit-tests the component that renders untrusted content, the walkthrough (`src/app/repositories/[id]/walkthrough.test.tsx`), with `react-dom/server`: markup from the model stays text, and every link points into the repository at the analyzed commit. Its pages and routes are covered end to end.

Timestamp columns have no time zone. Code compares them with the database's `now()`, so tests that backdate rows use `now()` too, never a JavaScript `Date`: PGlite reads such columns in the machine's time zone.

Example:

`src/lib/utils.ts`

`src/lib/utils.test.ts`

## End-to-End Tests

Playwright tests live in:

`tests/e2e/`

The current E2E suite includes smoke coverage for:

- homepage loading
- authentication endpoint availability
- billing endpoint protection (unauthenticated checkout, unsigned webhooks)
- email (`tests/e2e/email.spec.ts`): password reset end to end, sign-up verification, identical responses for unknown addresses, and signed-in-only verification resend. The tests read delivered messages from Mailpit through `tests/e2e/support/mailpit.ts` (`MAILPIT_URL`, default `http://127.0.0.1:8025`).
- Sentry: the reset link's token never reaches Sentry (`tests/e2e/email.spec.ts`). The test follows the link with a sampled `sentry-trace` header, so the server records its spans whatever the sample rate.
- rate limits (`tests/e2e/rate-limits.spec.ts`): 10 sign-ups per hour per client.
- security headers (`tests/e2e/security-headers.spec.ts`): the headers on `/` and `/account`, and `Referrer-Policy: no-referrer` on `/reset-password`.
- authentication pages (`tests/e2e/auth-pages.spec.ts`): sign-up, sign-in and its redirect rule, sign-out, verification (same browser, signed out, resend, altered link), password reset through the pages, identical forgot-password messages, the "email unavailable" and rate-limit messages, and that the reset page's token never reaches PostHog or Sentry. Browser tests import `test` from `tests/e2e/support/fixtures.ts`, which gives every browser context its own client IP and provides `newVisitor()` for a second visitor.
- repositories (`tests/e2e/repositories.spec.ts`): the pages and routes signed out, from another origin, with malformed IDs, and as another user; an unverified user; adding a repository through the form and following it to `done` without a reload; the walkthrough's sections, links, and coverage counts, and markup in the repository's description shown as text; the same repository in another URL form; rejected URLs; simultaneous adds; the slot limit and deleting; a failed analysis and its retry; a repository made private before its analysis; and that no file contents, walkthrough text, or repository names reach PostHog or Sentry. Every test deletes the repositories it created, through the delete route, so no queued job outlives the run in the shared local database.

`pnpm test:e2e` builds the application with `scripts/build-e2e.sh`, which points Sentry and PostHog at an observability stub on `127.0.0.1:9999` (`tests/e2e/support/observability-stub.ts`). Playwright starts the stub with the application, and tests read what it received through `tests/e2e/support/observability.ts`. E2E runs therefore never report to real Sentry or PostHog projects, even when `.env.local` sets other values. These `NEXT_PUBLIC_*` values are inlined at build time, so a build made by `pnpm test:e2e` reports to the stub until the next build.

PostHog drops events from browsers it considers bots, which includes every automated browser. A test that needs PostHog's events must present as a regular browser with `regularBrowserPage()` from `tests/e2e/support/browser.ts`, as the reset page test in `auth-pages.spec.ts` does. Do not turn off PostHog's bot filter in the application to make tests pass. PostHog's autocapture starts only once the project's remote configuration allows it, so the stub serves a configuration with autocapture on, as in a project that uses it.

Analyses run against a GitHub stub on `127.0.0.1:9998` (`tests/e2e/support/github-stub.ts`), never GitHub. It serves the repository, branch head, tree, contents, and tarball requests that `@startup/github` makes, for the fixtures in `tests/e2e/support/github-fixtures.ts`: a public repository with an entry point, configuration, source, tests, and docs, including names with a space, `#`, and non-ASCII characters, and a lockfile, vendored code, an image, and build output that the analysis drops; a private one; an empty one; one whose listing is truncated; `turns-private-*`, public when added and private when its analysis starts; and `small-*` for the slot limit. They live under an owner that is unlikely to exist on GitHub, and every fixture file contains a marker that tests search for where file contents must never appear. Playwright starts the analysis worker with `scripts/start-e2e-worker.sh` and waits for its `worker ready` line. The web app and the worker get `GITHUB_API_URL` pointing at the stub and empty `TYPESAFE_*`, `ANTHROPIC_*`, and `GITHUB_API_TOKEN`, so every analysis ranks files by local signals and writes the basic walkthrough, and no test needs a model key. The worker reports errors to the observability stub. Playwright stops it with `SIGTERM`, so it can return a running analysis to the queue.

The E2E server runs in production mode, so rate limits apply. Tests give each test its own address and its own `x-forwarded-for` client IP, so tests never share a mailbox or a rate-limit bucket. Do not raise the limits to make tests pass.

Playwright runs the application with `BETTER_AUTH_URL=http://127.0.0.1:3000`, the origin the tests use. Better Auth rejects browser requests from any other origin, and `.env.local` usually says `http://localhost:3000`. CI sets the same value.

Playwright runs against a production-style Next.js server for more deterministic testing.

`pnpm test:e2e` builds `@startup/web` first, then Playwright starts `scripts/start-e2e-server.sh`, which `exec`s `next start` on `127.0.0.1:3000`. Playwright never reuses an existing server and stops the server when the run finishes. Playwright also starts the observability stub on `127.0.0.1:9999`, the GitHub stub on `127.0.0.1:9998`, and the worker. Because the ports are fixed, and the worker takes jobs from the shared database, only one worktree at a time may run E2E tests. See `parallel-development.md`.

### Prerequisites

`pnpm test:e2e` and `pnpm verify:full` need all of these locally:

- `.env.local` is configured. The build validates the required server environment (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`).
- The local database and Mailpit are running, with migrations applied: `pnpm db:up`, then `pnpm db:migrate`.
- `.env.local` sets `SMTP_URL` and `EMAIL_FROM` to the Mailpit values from `.env.example`.
- Ports `3000`, `9998`, and `9999` are free, and no other worker is running. Stop `pnpm dev` first: its worker would take the tests' analyses and send them to the real GitHub.
- The Playwright browser is installed, once per machine: `pnpm exec playwright install chromium`. On Linux, add `--with-deps` to also install the system libraries the browser needs.

The E2E worker also takes any analysis already queued in the local database, and fails it as not found, because the GitHub stub knows only its fixtures. Retry such an analysis after the run.

`./scripts/check-environment.sh` checks the toolchain and the required environment variables without printing their values.

CI provides the same prerequisites in the workflow, with disposable values instead of `.env.local`. See `continuous-integration.md`.

## Test Quality

Prefer tests that validate externally meaningful behavior.

Do not delete, skip, or weaken tests merely to make an implementation pass.
