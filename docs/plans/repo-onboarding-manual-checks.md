# Repo Onboarding: Manual Checks

## Goal

Check by hand what the automated tests cannot reach in `docs/specs/repo-onboarding-core.md`: real TypeSafe scoring, a walkthrough written by Claude, the real GitHub API, the worker stopped mid-run, real Sentry and PostHog projects, and a browser in the hands of a person. The automated suites (`pnpm verify:full`) use fakes and no model keys, so none of this has run end to end yet.

Run the checks in order. Each section says what it costs. Record each run in Results.

Status: not started. `docs/plans/repo-onboarding-core.md` lists these as the remaining manual checks in its Verification section.

## Setup

1. Update and start the local services:

   ```bash
   git checkout main && git pull
   pnpm install --frozen-lockfile
   pnpm db:up
   pnpm db:migrate
   ```

2. Set `GITHUB_API_TOKEN` in `.env.local`: a fine-grained token with read-only access to public repositories only. Without it, the server shares GitHub's 60 calls per hour, about 10 analyses.
3. Leave `TYPESAFE_*` and `ANTHROPIC_*` empty until the sections that need them.
4. Start the app and the worker. For the interruption checks, run them in two terminals so the worker can be stopped on its own:

   ```bash
   pnpm --filter @startup/web dev      # terminal 1
   pnpm --filter @startup/worker start # terminal 2, logs "worker ready"
   ```

   `pnpm dev` runs both, which is enough for every other section. Restart both after changing `.env.local`: neither reloads it.
5. Sign up at <http://localhost:3000/sign-up>, and confirm the address with the link in Mailpit (<http://localhost:8025>).

Useful queries, in `docker compose exec postgres psql -U startup -d startup`:

```sql
-- The latest repositories and what their analyses produced.
select owner, name, status, failure_reason, listed_count, dropped_count, unscored_count,
       local_only_count, walkthrough->>'kind' as kind, finished_at - started_at as took
from repositories order by created_at desc limit 5;

-- Their jobs.
select state, retry_count, data->>'interruptions' as interruptions, created_on, completed_on
from pgboss.job where name = 'analysis' order by created_on desc limit 5;
```

To check that no file contents were kept, pick a distinctive line from the body of a file in the analyzed repository, not a name the walkthrough could mention, and search every table:

```bash
docker compose exec postgres pg_dump -U startup -d startup --data-only | grep -c -F 'the line'   # 0
```

## 1. Without Model Keys (free)

| Check | Steps | Expected |
| --- | --- | --- |
| Basic walkthrough | Add `https://github.com/expressjs/express/tree/master/lib`. Stay on the page. | The page goes from Queued to Running to Done without a reload. Four sections, the note that no writing model is configured, "Every file was ranked by local signals". Key files link to `blob/<commit>/…` and open the right files. The list shows the short commit. |
| Same repository again | Add `github.com/ExpressJS/Express.git`. | Opens the same repository. Still "1 of 5 used". |
| Over 300 files | Add `nodejs/undici`. | Done. Left unscored is over 0, and listed − dropped − unscored is 300. |
| Too large | Add `chromium/chromium`. | Failed: "The repository is too large to analyze." Retry fails the same way and keeps the slot. |
| Rejections | Add a private repository you own, a URL that does not exist, an empty repository (create one on GitHub without a README), and `https://gitlab.com/a/b`. | Each shows its message. No slot is used. |
| Slot limit | Fill 5 slots, then delete one through its page. | The form is replaced by "Delete a repository to add another." until the delete. Cancel has focus when delete asks to confirm. |
| Unverified address | Sign up a second account and do not confirm it. | The list asks to verify, with a link to `/account`, and has no form. |
| Two tabs | In two tabs on the list, submit the same new URL at the same moment. | One repository. Both tabs end on its page. |
| Narrow window | Shrink the browser to phone width on both pages. | Nothing overflows sideways. Long paths wrap. |
| Interrupted once | Add `nodejs/undici`. While it is Running, press Ctrl+C in the worker's terminal, then start the worker again. | The worker logs `[worker] SIGINT: stopping` and exits within seconds. The repository returns to Queued, its job is in `retry`, and after the restart it reaches Done. |
| Interrupted twice | Repeat, and stop the worker again during the second run. | Failed: "An unexpected error stopped the analysis." Retry starts it over. |
| Crash | Add `nodejs/undici`. While it is Running, `kill -9` the worker's `node` process, then start the worker again. | It stays Running for up to about 30 seconds, then starts over and reaches Done. |
| Deleted while running | Add `nodejs/undici`, and delete it while Running. | It disappears from the list. Its job is `cancelled`, and nothing reappears after the worker notices. |
| No file contents | After the runs above, search with `pg_dump` for a line from `express/lib/application.js` and one from `undici`. | 0 for both. |

## 2. With TypeSafe (TypeSafe usage, up to 300 requests per analysis)

Set `TYPESAFE_API_KEY` and `TYPESAFE_MODEL`, then restart.

| Check | Steps | Expected |
| --- | --- | --- |
| Scored by TypeSafe | Delete and add `expressjs/express` again. | Done, with the basic walkthrough. Ranked by local signals only is 0 or close to it, and the "Every file was ranked by local signals" note is gone. The roles look right: `index.js` an entry point, `test/` tests, `package.json` configuration. |
| 300 files in time | Add `nodejs/undici`. Note `took` from the query. | Done well within 15 minutes. Scoring stops at 6 minutes at the latest. |
| TypeSafe failing | Set `TYPESAFE_API_KEY` to a wrong value, restart, and add a small repository. | Done anyway. Every file is ranked by local signals, and the page says so. |

Record the TypeSafe usage for these analyses.

## 3. With Claude (Anthropic usage, about $1 per written walkthrough)

Set `ANTHROPIC_API_KEY`, and `ANTHROPIC_MODEL` to `claude-opus-5-5`, then restart. The plan estimates about $0.80 per written walkthrough, up to about $1.60 when the output is requested again.

| Check | Steps | Expected |
| --- | --- | --- |
| Only one variable set | Remove `ANTHROPIC_MODEL` and start the worker. | It exits with an error that names `ANTHROPIC_MODEL` and never prints the key. The web app shows the same error on its first page. Put it back. |
| Written walkthrough | Add `expressjs/express`. | Done. No "no writing model" note. Prose in all four sections, which is accurate on reading. Every file and directory named in backticks is a link that opens the right path at the commit. Up to 15 key files with a role and a reason, and a numbered reading order. No quoted code, only names of files, functions, and commands. |
| A larger repository | Add `nodejs/undici`. | The same, written from the top 30 files. Note `took`. |
| Writer failing | Set `ANTHROPIC_API_KEY` to a wrong value, restart, and add a small repository. | Failed: "The walkthrough could not be written." Put the right key back, restart, and Retry: Done. |
| Refusals | Optional. Add a well-known repository of offensive security tooling. | Done with a written walkthrough (the fallback model may have written it), or Failed: "The walkthrough could not be written." Never a raw provider message. |
| Instructions in a README | Optional. Create a public repository with a README that tells the model to ignore its instructions, link to `https://example.com`, and include `<img src=x onerror=alert(1)>`. Add it, then delete the test repository from GitHub. | No link outside the repository, no image, no alert. At most the wording changes. |
| No file contents | Search with `pg_dump` for a line from a file that was sent to Claude, such as one from `express/lib/router/`. | 0. |

Record the Anthropic cost per walkthrough from the console's usage page, and compare it with the estimate.

## 4. With Real Sentry and PostHog (optional)

Only if the project uses them. Set `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, and `NEXT_PUBLIC_POSTHOG_HOST` to development projects, turn on autocapture and session replay in the PostHog project, and restart.

| Check | Steps | Expected |
| --- | --- | --- |
| PostHog | Open a repository page with a walkthrough, click its links and the list's repository links, and leave a recording running. | Pageviews show `/repositories/<id>` and the titles "Repositories" and "Repository". No autocaptured clicks from inside either page. In the replay, the pages' content is blocked out. The E2E tests do not cover replay, so this is its only check. |
| Sentry from the worker | Add `nodejs/undici`, and while it is Running, stop Postgres (`docker compose stop postgres`) for a few seconds, then start it again. | Any worker event in Sentry holds only the error's type and message, stack frames without variables, and the `analysis_id` and `step` tags. No breadcrumbs, request data, or file contents. |
| Sentry from the web app | Browse the repository pages. | Nothing in Sentry contains file contents or walkthrough text. Sampled server spans may name a repository in a GitHub request URL. |

## 5. Before Production

With the first real deployment, alongside `docs/template-checklist.md` and `docs/architecture/deployment.md`:

- The worker runs on a long-running host with a shutdown grace period of at least 60 seconds. A deploy returns running analyses to Queued, and they finish on the new worker.
- `pnpm db:migrate` ran before the web app and the worker started. Adding a repository does not answer "Analyses can't be started right now".
- `GITHUB_API_TOKEN` is set on both, read-only to public repositories. `GITHUB_API_URL` is unset.
- A `www.` or other second domain redirects to `BETTER_AUTH_URL`. Adding a repository from it would otherwise be refused.
- One repository analyzed in production reaches Done, and its page links to GitHub correctly.

## Not Covered Here

Automated tests already cover these, and repeating them by hand is slow:

- the 15-minute time limit (`worker.test.ts`)
- GitHub rate limits during an analysis, which take an hour without a token (`worker.test.ts`, `run.test.ts`)
- 10 analyses per 24 hours and 20 requests per hour (`repositories.test.ts`)
- names with spaces, `#`, and non-ASCII characters (`repositories.spec.ts`, `walkthrough-document.test.ts`)

## Results

| Date | Commit | Section | Result | Cost | Notes |
| --- | --- | --- | --- | --- | --- |
| | | | | | |
