# Repository Analysis

## Purpose

A user adds a public GitHub repository, and a background analysis ranks its files and writes a walkthrough. See `docs/specs/repo-onboarding-core.md` for the behavior and `docs/plans/repo-onboarding-core.md` for how it is being built.

This document grows with the implementation. It covers GitHub access so far. The job queue the analysis runs on is described in `jobs.md`.

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

Tests inject a fake `fetch` and never open network connections (`src/testing/no-network.ts`). `src/testing/tarball.ts` builds archives shaped like GitHub's for the archive tests.
