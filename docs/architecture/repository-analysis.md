# Repository Analysis

## Purpose

A user adds a public GitHub repository, and a background analysis ranks its files and writes a walkthrough. See `docs/specs/repo-onboarding-core.md` for the behavior and `docs/plans/repo-onboarding-core.md` for how it is being built.

This document covers repositories and limits, the pages and routes, the analysis, the worker that runs it, and GitHub access. The job queue the analysis runs on is described in `jobs.md`.

## Repositories and Limits

`@startup/onboarding` adds, lists, reads, retries, and deletes a user's repositories. Every query filters by the user's ID, and a repository that belongs to another user, or a malformed ID, raises the same `RepositoryNotFoundError` as one that does not exist.

### Limits

| Limit | Counted from |
| --- | --- |
| 5 repositories per user | `repositories`, in every status |
| 10 analyses started per rolling 24 hours | `analysis_requests` rows marked `started`, which outlive deleted repositories |
| 20 add or retry requests per rolling hour | every `analysis_requests` row, rejected requests included |

Windows are measured with the database's `now()`.

### Adding and Retrying

1. The request is recorded, or rejected over the hourly limit, in a short transaction that locks the user's row.
2. The URL is parsed (`parseRepositoryUrl`). The repository URL itself is never fetched.
3. When email is configured, the user's address must be verified.
4. Cheap reads: an existing repository with the same name is returned as it is (add only), and the slot limit (add only) and the daily cap are checked. A rejected request has made no GitHub call.
5. GitHub: the repository must be public, and its default branch's latest commit is recorded.
6. One transaction locks the user's row, repeats step 4 with GitHub's canonical name, saves the repository (or resets a failed one for a retry), marks the request started, and sends the `analysis` job with `inTransaction(tx)`. The repository, its request, and its job are committed together or not at all.

Locking the user's row makes one user's requests check and save one at a time, so two requests cannot both take the last slot, and two adds of the same repository create one. Retry accepts only a failed analysis and keeps its slot. It clears the old results, and records a new job ID and the latest commit.

Every rejection raises `RepositoryRequestError` with a `code`: `INVALID_URL`, `REPOSITORY_NOT_FOUND`, `REPOSITORY_EMPTY`, `REPOSITORY_LIMIT`, `DAILY_LIMIT`, `REQUEST_LIMIT`, `VERIFICATION_REQUIRED`, `GITHUB_UNAVAILABLE`, `QUEUE_UNAVAILABLE`, or `NOT_RETRYABLE`. Routes map the code to a status, and pages to their own message (see Pages and Routes).

### Deleting

Deleting removes the repository, its analysis, and its walkthrough, and cancels its job in the same transaction. A running analysis notices at its next heartbeat. When the job queue is unavailable, the repository is still deleted: a job whose repository is gone does nothing when it runs.

## Pages and Routes

`apps/web` authenticates, checks the request, calls `@startup/onboarding`, and maps the result to HTTP. The rules stay in the package.

| Route | What it does |
| --- | --- |
| `/repositories` | The user's repositories, newest first, with status, date added, and the analyzed commit once done; the slots used; and the add form, or why adding is unavailable, with a link to `/account` for verification. |
| `/repositories/[id]` | Status and failure reason, links to the repository and the analyzed commit on GitHub, dates, coverage counts, the walkthrough once done, retry when failed, and delete after a confirmation. |
| `POST /api/repositories` | `{ url }`. `201 { id }` for a new repository, `200 { id }` for one the user already has. |
| `POST /api/repositories/[id]/retry` | `200 { id }`. |
| `DELETE /api/repositories/[id]` | `204`. |

After sign-in and sign-up, users land on `/repositories` (`DEFAULT_REDIRECT` in `@startup/auth/redirect`). Each page checks the session itself and sends a signed-out visitor to `/sign-in` with the page as the redirect target: a layout does not know which page it wraps. A missing repository, another user's, and a malformed ID all call `notFound()`. The repository page has no `loading.tsx`, since `notFound()` answers `404` only for a response that has not started streaming. While a repository is queued or running, both pages call `router.refresh()` every 3 seconds, so statuses change without a reload.

The add form checks the URL with `@startup/github/url` before sending it, and the server checks it again. Pages show their own copy for each error code and for each failure reason (`apps/web/src/lib/repositories.ts`), never a message from the server, GitHub, or a model provider.

Every route answers `401 UNAUTHORIZED` without a session, and `403 FORBIDDEN_ORIGIN` when the `Origin` header is not `BETTER_AUTH_URL`'s origin (`apps/web/src/lib/same-origin.ts`): route handlers do not get the check that Server Actions get, and browsers send `Origin` with every `POST` and `DELETE`. Bodies are `{ error: <code> }`:

| Code | Status |
| --- | --- |
| `INVALID_URL` | 400 |
| `VERIFICATION_REQUIRED`, `FORBIDDEN_ORIGIN` | 403 |
| `NOT_FOUND` (missing, another user's, or a malformed ID) | 404 |
| `REPOSITORY_LIMIT`, `NOT_RETRYABLE` | 409 |
| `REPOSITORY_NOT_FOUND`, `REPOSITORY_EMPTY` | 422 |
| `DAILY_LIMIT`, `REQUEST_LIMIT` | 429 |
| `GITHUB_UNAVAILABLE`, `QUEUE_UNAVAILABLE` | 503 |

Other errors are thrown, so Next.js answers `500` and reports them. Node loads pg-boss at runtime in the web app (`serverExternalPackages` in `next.config.ts`), rather than the build bundling it.

The walkthrough is rendered from the parsed document as React text, `<code>`, and links built with `githubUrl` (`apps/web/src/app/repositories/[id]/walkthrough.tsx`). Nothing renders HTML from it, and a path that `githubUrl` refuses is shown as text, not a link. Both pages sit inside `ph-no-capture`, and their titles never name a repository (`observability.md`). A page that fails, during a refresh too, shows `error.tsx` inside the same layout, with a button that tries again.

## Analysis

`runAnalysis` (`packages/onboarding/src/analysis/run.ts`) analyzes one repository at its recorded commit. File contents exist only in its memory and are gone when it returns.

1. **Visibility.** `getRepository` again: a repository deleted or made private since it was added fails as not found.
2. **Listing.** `getTree` at the commit. A listing GitHub cannot return in full fails as too large.
3. **Dropping** (`filters.ts`): symbolic links, submodules, lockfiles, build output and other generated files, binaries by extension, vendored directories, files over 100 KB, paths over 1,024 characters (too long for a stored link), and paths marked `linguist-generated` or `linguist-vendored` in the root `.gitattributes`. `gitattributes.ts` reads that file with git's pattern rules: a pattern without a slash matches a file name at any depth, one with a slash is anchored to the root, a pattern ending in `/` never matches a file, and the last matching line wins. Nothing left fails as nothing to analyze.
4. **Candidates.** Every kept file gets a local score from 0 to 4 and a path-rule role (`signals.ts`), from its path and size alone. The 450 with the highest local scores are read from the archive (`readFiles`, at most 250 MB compressed). A file holding a NUL byte, or whose first five lines say it is generated, is dropped. The first 300 that pass are scored; the rest are left unscored.
5. **Scoring** (`scoring.ts`). With TypeSafe configured, each file's path and first 16 KB go to `@startup/decision`, 4 at a time, with two questions: `importance` (a `score` on a five-level rubric) and `role` (a `choice` of the five roles). A role answer below 0.6 confidence is replaced by the path rule. Ranking is by score, then local score, then path.
6. **Walkthrough.** With the writing model configured, `walkthrough.ts` writes it; otherwise `basic.ts` builds the basic one from the ranking.

TypeSafe never fails an analysis. Every file it cannot answer for keeps its local score and path-rule role:

| TypeSafe outcome | Effect |
| --- | --- |
| any `DecisionError` | that file falls back |
| `DecisionAuthenticationError`, `DecisionConfigurationError` (not configured) | every remaining file falls back |
| `DecisionRateLimitError` asking for 30 seconds or less | waited out once for that file |
| 5 timeouts or provider errors in a row, or 6 minutes of scoring | every remaining file falls back |

The repository page shows the coverage counts: files listed, dropped (including those dropped when read), left unscored by the 300 limit, and ranked by local signals only. Without TypeSafe, every scored file is ranked by local signals.

### The Written Walkthrough

The model is asked for four sections (summary, directories, key files, reading order), with `effort: "high"` and the bounded zod schema in `walkthrough.ts`. The user turn is one JSON document: the name, the description, an outline of up to 2,000 kept paths, and the top 30 ranked files with their roles and scores, at most 30 KB each and 300 KB in total. JSON keeps repository text inside its fields, and the system prompt says it is data, not instructions.

The output is resolved into the stored document:

- Prose fields may not contain line breaks or code fences; such output is invalid.
- Key files and reading-order entries whose path is not a kept file are removed, as are repeats. Their roles come from the ranking, or the path rule for an unscored file.
- A backtick span that exactly names a kept file, or a directory that holds one, becomes a link. Other spans are inline code, or plain text when longer than 80 characters. Nothing else in the output can become a link, markup, or an image.
- The result must parse as a stored document. The path fields follow the same one-line rule as prose.

Invalid output, output that names no kept file as a key file or in the reading order, or a result that does not parse, is requested once more when at least 3 minutes remain. The writer gets the time that remains minus 1 minute through its `AbortSignal`; running out of it fails the analysis as timed out. Every other writer failure, including a refusal after the fallback model, fails it as "the walkthrough could not be written". `runAnalysis` checks the document once more before it is saved, so a `done` repository always has a walkthrough that parses.

### The Stored Document

`@startup/onboarding/walkthrough` (`walkthrough-document.ts`, zod only) defines the document stored in `repositories.walkthrough`: `kind` (`written` or `basic`) and the four sections as text, inline code, and path segments. Pages parse it again on read (`parseWalkthroughDocument`) and build links with `githubUrl(owner, name, commit, path, kind)`, which percent-encodes every path segment and refuses `.`, `..`, and empty segments, so a link always points at `https://github.com/<owner>/<repo>/blob/<commit>/<path>` or `/tree/`.

## The Worker

`apps/worker` runs `startAnalysisWorker` from `@startup/onboarding/worker` on a `worker` job queue. `deployment.md` describes how to run it.

| Queue | Handler |
| --- | --- |
| `analysis` | Runs one analysis. Up to 4 per process (`localConcurrency`), one per user across processes (`groupConcurrency: 1`, the user is the job's group), heartbeat refreshed every 15 seconds. |
| `analysis-failed` | Dead letters: marks the repository failed ("unexpected") when its `job_id` is still the dead job's `sourceId` and it is queued or running. |
| `onboarding-maintenance` | Every hour (`0 * * * *`): deletes `analysis_requests` older than 24 hours, and fails repositories queued or running for over 20 minutes whose job is missing or finished. |

### One Run

1. **Claim.** In a transaction that locks the user's row, the handler does nothing when the repository is gone or has another job. It fails the analysis ("unexpected") when its interrupted runs, counted across re-queued jobs, exceed the one retry. It queues a fresh job 15 seconds later when another of the user's repositories is `running` (pg-boss's group limit is best effort), or at once when the worker is stopping, so a job claimed during shutdown does not use its retry. Otherwise it sets `running` and `job_attempt` to the job's `retryCount`.
2. **Run** under one signal combining the job's own (aborted at a heartbeat once the job is cancelled or retried elsewhere), the 15-minute time limit, and shutdown.
3. **Save.** Every write matches `job_id` and `job_attempt`, so a stale run never overwrites a retry, a re-queued job, or a deleted repository.

| Outcome | Repository | Job |
| --- | --- | --- |
| done | `done`, with the coverage counts and the walkthrough | completed |
| expected failure | `failed` with its reason, and the counts when known | completed |
| 15 minutes passed | `failed`, timed out | completed |
| GitHub rate limit | waited out in the run when it resets within a minute; otherwise a fresh job starts after the reset, at most 3 times, then `failed` | completed |
| job cancelled or retried elsewhere | nothing is written | the handler throws; pg-boss changes nothing |
| worker stopping | `queued`, or `failed` ("unexpected") on the last attempt | failed into its retry |
| unexpected error | `queued`, or `failed` ("unexpected") on the last attempt; reported | failed into its retry |

Failure reasons: `not_found` (missing or not public), `too_large` (listing truncated or archive over 250 MB), `nothing_to_analyze`, `github_rate_limit`, `writer_failed`, `timed_out`, `unexpected`.

### Interruptions

Every interruption counts, a deploy included, and the `analysis` queue allows one retry:

- **Shutdown.** On SIGTERM or SIGINT the worker stops claiming (`offWork`), aborts its handlers, waits for each to return its repository to `queued` and throw `AnalysisInterruptedError`, which pg-boss records as a failure into the retry, and then stops pg-boss. pg-boss's own `stop()` fails running jobs before it aborts their handlers, which would leave them writing, so the worker aborts them first.
- **Crash or lost heartbeat.** pg-boss's supervisor fails a job whose heartbeat is more than 30 seconds old into its retry. Until then the repository still shows `running`, and the user's other analyses wait.
- **Second interruption.** The job fails for good and is dead-lettered; the `analysis-failed` handler marks the repository failed.
- **Re-queued jobs** (another analysis running, a rate limit, a claim during shutdown) start pg-boss's retry count again, so the job data carries `interruptions`, the runs interrupted under earlier jobs. The handler adds it to the job's `retryCount`.

### Errors and Storage

Handlers throw only `AnalysisError` (the step and the error's class name) and `AnalysisInterruptedError`, because pg-boss stores thrown errors in `pgboss.job.output` and copies them into dead letters. Unexpected errors go to the configured reporter, Sentry in `apps/worker`, in the same reduced form.

After an analysis ends, successfully or not, the database holds paths, counts, roles, and the walkthrough, and no file contents, including in the job queue's tables.

### Testing the Analysis

`@startup/onboarding`'s tests run on in-memory PGlite with pg-boss (`@startup/jobs/testing`), drive time with pg-boss's `TestClock`, and use a fake GitHub client (`src/testing/github.ts`) whose fixture files carry a marker string. `worker.test.ts` runs jobs through pg-boss and checks every table, the `pgboss` schema included, for the marker after runs that succeed and fail. PGlite has one connection, so concurrent claims meet real Postgres only in the end-to-end tests (`testing.md`), where one worker takes up to 4 jobs at once.

### Time Budget

| Bound | Value |
| --- | --- |
| Analysis | 15 minutes, then timed out; pg-boss's 16-minute expiry is a backstop |
| Scoring | 6 minutes, or 5 TypeSafe timeouts or provider errors in a row |
| Writer | the time remaining minus 1 minute, then timed out; a second request only with 3 minutes left |
| GitHub rate limit inside a run | waited out when it resets within 1 minute |

The constants live in `packages/onboarding/src/limits.ts`.

## GitHub Access

`@startup/github` is the only code that calls GitHub. It reads public repositories through the REST API (`X-GitHub-Api-Version: 2022-11-28`) with the global `fetch`.

### Requests

| Method | Endpoint | Used |
| --- | --- | --- |
| `getRepository` | `GET /repos/{owner}/{repo}` | when a repository is added or retried, and when its analysis starts |
| `getBranchHead` | `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` | when a repository is added or retried |
| `getTree` | `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` | when an analysis starts |
| `readFile` | `GET /repos/{owner}/{repo}/contents/{path}?ref={sha}` | the root `.gitattributes` |
| `readFiles` | `GET /repos/{owner}/{repo}/tarball/{sha}` | the files to score, read from the archive |

An analysis therefore makes 6 API calls: 2 when the repository is added and 4 when it runs. The archive download itself is served by `codeload.github.com` and does not count against the API limit.

- **No user URLs are fetched.** `parseRepositoryUrl` (`@startup/github/url`) turns a submitted URL into an owner and a name, or rejects it. The client builds every request from those, encoding each part, and fetches only the API address.
- **Public only.** `getRepository` treats a repository that is private or internal as missing, with the same error as one that does not exist, even when the token could read it.
- **Redirects.** Every request follows redirects itself, at most 3, and only to the API origin or `https://codeload.github.com`. Anything else is refused before it is contacted. A renamed repository redirects on the API origin.
- **The token** goes in an `Authorization` header to the API origin only, never to the archive host.
- **Archives** are streamed and decompressed as they arrive. Only the requested files are kept, files over a size limit are skipped, the download stops at a byte limit, and reading stops once every requested file is found. Paths lose the archive's top-level directory (`<owner>-<repo>-<sha>/`).
- **Timeouts.** 10 seconds per request, and 2 minutes for an archive. A caller's `AbortSignal` cancels either.
- **No retries.** Whether and when to try again is the caller's decision.

### Configuration

| Variable | Purpose |
| --- | --- |
| `GITHUB_API_TOKEN` | Optional. Raises the rate limit from 60 to 5,000 API calls per hour. Secret. |
| `GITHUB_API_URL` | Optional. Defaults to `https://api.github.com`. Only tests change it. `http://` is accepted for a loopback address only. |

Use a fine-grained token with read-only access to public repositories only, so it can never read a private repository. Without a token, the whole server shares one limit of 60 calls per hour, about 10 analyses, so production needs one.

Neither variable is read at build time.

### Errors

Every error extends `GitHubError`. Messages never contain the token, request headers, response bodies, or GitHub's own messages, and errors have no `cause`, so they are safe to log, report, and store.

| Error | Cause |
| --- | --- |
| `GitHubNotFoundError` | `404`, `451`, a `403` that is not a rate limit (a blocked or disabled repository), or a repository that is not public |
| `GitHubEmptyRepositoryError` | `409`: the repository has no commits |
| `GitHubRepositoryTooLargeError` | `reason` is `listing_truncated` (GitHub could not list every file) or `download_limit` |
| `GitHubRateLimitError` | `403` or `429` for a rate limit, with `resetAt` from `retry-after` or `x-ratelimit-reset`, or a minute from now when GitHub gives neither |
| `GitHubUnavailableError` | `reason` is `network`, `timeout`, `status` (other statuses, including `5xx`), `authentication` (`401`: the token was rejected), `invalid_response`, or `redirect` |

### Testing

`@startup/github`'s tests inject a fake `fetch` and never open network connections (`src/testing/no-network.ts`). `src/testing/tarball.ts` builds archives shaped like GitHub's for the archive tests.
