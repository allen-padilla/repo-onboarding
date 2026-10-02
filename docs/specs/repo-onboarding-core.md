# Repo Onboarding Core

## Problem

New engineers lose days working out which parts of a codebase matter. A good teammate would point them to the entry points, the core logic, and the files to read first, but that teammate is not always available, and their walkthrough is rarely written down.

## Goals

- A signed-in user pastes the URL of a public GitHub repository and later reads a walkthrough of it: what the project is, how it is organized, the key files and why each matters, and a suggested reading order.
- The analysis runs in the background. The user can leave, come back, and see its status: queued, running, done, or failed.
- Files that never matter are dropped. The rest are ranked by how important each is to a new engineer, using `@startup/decision`, and each is labeled with a role.
- A generative model, Claude, writes the walkthrough from the top-ranked files. Files are linked on GitHub, not copied.
- The cost of each user is bounded: 5 repositories, 300 scored files per repository, a daily cap on analyses, and an hourly cap on requests.
- The project runs for contributors without any model key. Without a TypeSafe key, ranking uses local signals only. Without an Anthropic key, the walkthrough is a ranked list without prose.

## Non-goals

- Private repositories, and hosts other than GitHub.
- GitHub sign-in. Users keep the existing email and password accounts.
- Chat or questions about a repository.
- Re-analysis when a repository changes. Retrying a failed analysis is not re-analysis (see Retry).
- Sharing, teams, and public walkthrough links.
- Walkthroughs tailored to a role, written in a language other than English, or built from a branch the user chooses.
- Billing: paid plans, and limits that differ by plan. The existing billing code is unchanged.
- A command-line version.
- Email or other notifications when an analysis finishes.
- Quoting code in a walkthrough, and storing file contents.
- Reusing one user's analysis for another user who adds the same repository.
- Editing, exporting, or rating a walkthrough.

## Decisions

These are already decided. Change them here before planning, not during implementation.

| Decision                         | Choice                                                                                                                                                       | Reason                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writer model                     | Claude, through the Anthropic API, isolated in its own package the way `@startup/decision` isolates TypeSafe. The model name is configuration.              | One provider, replaceable inside one package. `@startup/decision` does not generate prose.                                                              |
| Writer not configured            | The analysis still finishes, with a basic walkthrough: the key files with roles and links and a reading order from the ranking, but no prose. See Walkthrough. | Contributors without keys still see results.                                                                                                             |
| TypeSafe not configured          | Every file is ranked by local signals, and roles come from path rules.                                                                                       | Required by the brief, so the project runs without a key.                                                                                               |
| TypeSafe fails during a run      | The affected files fall back to local signals and path rules. The analysis continues.                                                                       | A partial outage should not waste a whole analysis.                                                                                                      |
| Writer fails during a run        | Tried again a bounded number of times, then the analysis fails with a reason. The user can retry it.                                                       | The server is set up to write prose, so a silent basic page would hide a fault that a retry can fix.                                                    |
| Repository limit                 | 5 per user, in every status. Deleting a repository frees its slot. Retrying a failed analysis keeps the same slot.                                          | A user can replace a repository they no longer need.                                                                                                     |
| Daily analysis cap               | 10 analyses started per user per rolling 24 hours, counting new repositories and retries                                                                    | Deleting frees a slot, so without a cap one user could add and delete in a loop and pay for model calls each time.                                      |
| Request limit                    | 20 add or retry requests per user per rolling hour, counting rejected ones                                                                                  | Every request can call GitHub, and the whole server shares one GitHub quota. Rejected requests start no analysis, so the daily cap does not count them. |
| Email verification               | Required before adding or retrying when email is configured. Not required when email is disabled.                                                           | Each analysis costs model calls, and throwaway accounts are cheap. When email is disabled nobody can verify.                                            |
| Background execution             | Analyses are stored in PostgreSQL and run by a worker, outside any web request. The worker survives restarts.                                               | An analysis outlives a request. Next.js `after()` ends with the request, and the template has no job queue yet.                                         |
| Commit                           | The default branch's latest commit at the time the repository is added. Every link points at that commit.                                                   | v1 never re-analyzes, so links to a branch would drift away from what the walkthrough describes.                                                        |
| File contents                    | Read during the analysis and discarded at its end. Only paths, file metadata, scores, roles, and the walkthrough are stored.                                | "Linked, not copied." The product does not republish anyone's code.                                                                                      |
| GitHub access                    | Works without a token. An optional server-only token raises GitHub's rate limits.                                                                           | Contributors without keys can run the project. Production needs the higher limits.                                                                      |
| Same repository added again      | Opens the existing one. No second entry is created.                                                                                                          | One user has one walkthrough per repository, and the limit is not spent twice.                                                                          |

## Behavior

### Configuration

- Four new server-only variables, all optional:
  - `ANTHROPIC_API_KEY`: the writer's API key. Secret.
  - `ANTHROPIC_MODEL`: the Claude model name sent with every request. The code hard-codes no model name.
  - `GITHUB_API_TOKEN`: a GitHub token used only to raise rate limits. Secret. It is not named `GITHUB_TOKEN`, so a token exported in a developer's shell or set by a CI job is never picked up by accident. It must not have access to private repositories.
  - `GITHUB_API_URL`: GitHub's API address, `https://api.github.com` when empty. Only tests change it, to point at a local stand-in for GitHub. Plain HTTP is accepted only for a loopback address.
- The writer is enabled when `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are both set. Setting only one fails environment validation. The error names the missing variable and never a value.
- Ranking uses `@startup/decision` when the existing `TYPESAFE_API_KEY` and `TYPESAFE_MODEL` are both set.
- None of the new variables is read at build time. `.env.example` lists them with empty values.
- `pnpm dev` runs the worker together with the web application, so the Quick Start can analyze a repository with no extra step.

### Adding a Repository

- The repository list page has a form with one field, the repository URL.
- Accepted forms are `https://github.com/<owner>/<repo>`, with or without the scheme or `www.`, a trailing slash, a `.git` suffix, or a path after the repository name, such as `/tree/main/src`. A path is ignored: the whole repository is analyzed, from its default branch.
- Before anything is saved, the server asks GitHub whether the repository exists and is public, and reads its canonical owner and name, default branch, latest commit on that branch, and description.
- The submission is rejected with a message, and nothing is saved, when:
  - the URL is not a GitHub repository URL
  - the repository does not exist or is private. Both get the same message.
  - the repository is empty
  - the user already has 5 repositories ("Delete a repository to add another.")
  - the user has started 10 analyses in the last 24 hours
  - the user has sent 20 add or retry requests in the last hour
  - email is configured and the user's address is not verified
  - GitHub is unavailable or rate-limited ("Try again in a few minutes.")
- When the user already has the same repository, compared by canonical owner and name without regard to case, they are taken to it.
- Otherwise the repository is saved with status `queued`, and the user is taken to its page.

### Limits

- 5 repositories per user, counting every status. The list page shows how many are used, such as "3 of 5".
- 10 analyses started per user per rolling 24 hours, counting new repositories and retries.
- 20 add or retry requests per user per rolling hour, counting rejected requests.
- 300 scored files per repository.
- A user's analyses run one at a time. The others wait as `queued`.
- The server enforces every limit, including when two requests arrive at the same time.
- The limits are the same for every user.

### Status

- An analysis moves from `queued` to `running`, then ends `done` or `failed`.
- The repository list and the repository page show the status. While it is `queued` or `running`, both pages update without a reload.
- A failed analysis shows one reason from a fixed set, in plain words: not found or private, too large, nothing to analyze, GitHub rate limit, the walkthrough could not be written, timed out, or an unexpected error. Raw error messages from GitHub or a model provider are never shown.
- An analysis still running after 15 minutes fails as timed out.
- An analysis interrupted because the worker stopped returns to `queued` and starts over. If it is interrupted a second time, it fails.

### Analysis

An analysis runs these steps in order:

1. Read the repository's file listing at the recorded commit.
2. Drop the files that never matter.
3. If more than 300 files remain, choose 300 by local signals.
4. Score each chosen file's importance and label its role.
5. Write the walkthrough from the top-ranked files.

#### Dropped Files

- Lockfiles, such as `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `poetry.lock`, `Gemfile.lock`, `composer.lock`, and `go.sum`.
- Generated code: build output directories such as `dist/`, `build/`, and `.next/`, minified files, source maps, generated protocol buffer and gRPC code, paths marked `linguist-generated` in the root `.gitattributes`, and files whose first lines say they are generated.
- Binaries: images, fonts, audio, video, archives, compiled objects and executables, and any file whose contents turn out not to be text when it is read.
- Vendored code: `vendor/`, `third_party/`, `node_modules/`, and paths marked `linguist-vendored` in the root `.gitattributes`.
- Files larger than 100 KB.
- Files whose path is longer than 1,024 characters.
- Symbolic links and submodules.

A file found to be generated or binary only when it is read is dropped at that point and does not count toward the 300. At most 450 candidates are read, so when many of them turn out to be generated or binary, fewer than 300 files are scored.

A repository whose file listing GitHub cannot return in full, or that exceeds the size limits set in the plan, fails as too large. A repository with no files left after dropping fails as nothing to analyze.

#### Local Signals

Local signals are computed from the file listing alone, without reading contents or calling a model: well-known names (such as `README`, package manifests, `Dockerfile`, and `main`, `index`, or `app` files), depth in the tree, directory conventions (such as `src/` and `lib/` against `test/`, `examples/`, and `fixtures/`), file type, and size.

They give every kept file a local score, which:

- chooses the 300 files to score when more remain
- ranks files that TypeSafe does not score
- breaks ties

#### Importance and Role

- With TypeSafe configured, each chosen file's path and contents are sent to `@startup/decision`. Long files are truncated to a fixed length. Two questions are asked:
  - importance: a `score` against an ordered rubric, from "a new engineer never needs to open this" to "essential to understanding the project"
  - role: a `choice` between the five roles
- The roles are:
  - entry point
  - configuration, including build, CI, deployment, and tooling files
  - domain logic: application source that is none of the other roles
  - test
  - documentation
- Every scored file gets exactly one role.
- A role answer with low confidence is replaced by the path rule. The threshold lives in the product code that owns the decision, as `decision-models.md` requires.
- A file whose TypeSafe request fails gets its local score and its path-rule role. The analysis does not fail because of TypeSafe.
- Files scored by TypeSafe and files scored by local signals are ranked together in one order.
- The repository page states how many files were listed, how many were dropped, how many were left unscored by the 300 limit, and how many were ranked by local signals only.

#### Walkthrough

With the writer configured, the model receives the repository's name and description, an outline of the kept paths, and the top-ranked files (up to 30, within a fixed content budget, with long files truncated), together with their roles and scores. It writes four sections:

1. **What the project is.**
2. **How it is organized:** the main directories and what lives in each.
3. **Key files:** up to 15 files, each with its role and why it matters.
4. **Suggested reading order:** a numbered list of files.

- Every file and directory named in the walkthrough links to it on GitHub at the analyzed commit.
- A path the model names that is not in the analyzed repository is never a link. It is removed from the key files and the reading order, and shown as plain text elsewhere.
- The walkthrough never quotes code. It may name files, functions, and commands.
- Output that does not have the four sections is rejected and requested again, within the writer's bounded attempts.

Without the writer, the analysis writes a basic walkthrough with the same four sections:

1. **What the project is:** the repository's GitHub description, or a note that it has none.
2. **How it is organized:** the top-level directories that contain kept files, with how many each contains.
3. **Key files:** the 15 top-ranked files, each with its role and a link, and no explanation.
4. **Suggested reading order:** the key files grouped as documentation, entry points, configuration, domain logic, then tests, in rank order within each group.

The basic walkthrough says that no writing model is configured on this server, so it has no written explanations.

### Pages

- `/repositories` lists the user's repositories, newest first, with each one's name (`owner/repo`), status, the date it was added, and, when done, the analyzed commit. It holds the add form, with the number of slots used. When the user cannot add, the form says why: the limit is reached, the daily cap is reached, or the address needs verifying, with a link to `/account`.
- `/repositories/<id>` shows the repository's status, a link to it on GitHub, the analyzed commit and date, the coverage counts, and the walkthrough when it is done. It offers retry when the analysis failed, and delete in every status.
- Both pages require a session. A signed-out visitor goes to `/sign-in`, with the page as the redirect target.
- A repository that does not exist, or that belongs to another user, shows the same "not found" page.
- After sign-in and sign-up, the default destination becomes `/repositories` instead of `/account`. `/account` links to `/repositories`. Verification links still land on `/account`.

### Retry

- The owner can retry a failed analysis. It starts over from the default branch's latest commit at the time of the retry, and records that commit.
- A retry keeps the repository's slot, counts toward the daily cap and the request limit, and requires a verified address when email is configured.
- A finished analysis cannot be retried. To analyze a repository again, the user deletes it and adds it again.

### Delete

- The owner can delete a repository in any status, after confirming.
- Deleting removes the repository, its analysis, and its walkthrough, and frees its slot at once.
- Deleting a queued or running analysis stops it. Nothing it would have saved is kept.
- Deleting does not give back an analysis counted toward the daily cap.

### Boundaries

- Only one package calls GitHub, and only one package calls the Anthropic API. Each is server-only. Only `@startup/decision` calls TypeSafe, as before.
- The analysis logic lives in a package. Pages and route handlers authenticate, validate, delegate, and map results to HTTP.
- New tables are added through the database migration workflow.

## Edge Cases

- **The repository is renamed or transferred after it is added.** The stored name is kept. GitHub redirects the old links.
- **The repository is deleted or made private after the analysis is done.** The walkthrough stays. Its links may stop working. The page does not check.
- **The repository is deleted or made private while its analysis is queued.** The analysis fails as not found or private.
- **Two tabs add the same repository at the same time.** One repository is saved, and both tabs end on it.
- **Two tabs add different repositories when one slot is left.** One is saved, and the other is rejected as over the limit.
- **Fewer than 15 files remain after dropping.** The walkthrough is produced with the files there are.
- **File names with spaces, `#`, `?`, or non-ASCII characters.** Links are encoded so that they open the right file.
- **A text-looking extension holds binary contents.** The file is dropped when it is read.
- **GitHub rate-limits a running analysis.** The worker waits and tries again a bounded number of times, then the analysis fails as GitHub rate limit.
- **TypeSafe rate-limits a running analysis.** The affected files fall back to local signals.
- **Email becomes configured after unverified users have added repositories.** Their repositories stay. New additions and retries require verification.
- **Repository content contains instructions to a model,** such as a README that says "ignore previous instructions". It can influence the walkthrough's wording at most. It cannot add links outside the repository, add raw HTML or images, change the analysis of another repository, or reach any other user's data.

## Security and Privacy

- **Ownership.** Every page, route, and query is filtered by the signed-in owner, read with `getSession()`. Another user's repository is indistinguishable from one that does not exist.
- **No user-supplied URLs are fetched.** The server parses the owner and name out of the submitted URL, checks them against GitHub's naming rules, and builds every request itself. The application only contacts GitHub, TypeSafe, and Anthropic.
- **Public repositories only.** The server checks visibility through GitHub when a repository is added or retried, and again when each analysis starts. It rejects private repositories even when the configured token could read them.
- **Untrusted content.** File contents, paths, names, and the description are untrusted input to both models and to the page. The walkthrough is rendered as escaped text with headings, paragraphs, lists, inline code, and links. It never renders raw HTML, scripts, or images. Every link is checked to point at `https://github.com/<owner>/<repo>/blob/<commit>/<path>` or `.../tree/<commit>/<path>`, for a path that is in the analysis.
- **Secrets.** `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`, and `GITHUB_API_TOKEN` are server-only, never use the `NEXT_PUBLIC_` prefix, and never appear in the browser bundle, logs, or error messages.
- **Observability.** Errors sent to Sentry carry the analysis ID, the step, and the error type, and never file contents, prompts, model output, or keys. The same holds for everything else Sentry can collect, such as request bodies and performance data. PostHog receives no repository content: the repository pages are excluded from autocapture and session replay.
- **Storage.** File contents are held only while an analysis runs. After it ends, the database holds paths, metadata, scores, roles, and the walkthrough, and no file contents. This includes the job queue's own records, such as stored errors.
- **Providers.** File contents of public repositories are sent to TypeSafe and Anthropic. Nothing about the user, such as their name or address, is sent to either.
- **Cost.** Every analysis is bounded: at most 300 TypeSafe-scored files, a fixed content budget for the writer, a bounded number of attempts, and a 15-minute limit. Every user is bounded by 5 repositories, 10 analyses per 24 hours, and 20 add or retry requests per hour.

## Acceptance Criteria

- [ ] A verified user adds a public repository by URL, leaves, comes back, and finds it done, with a walkthrough that has all four sections and links every named file to GitHub at the analyzed commit.
- [ ] The repository list and the repository page show `queued`, `running`, `done`, and `failed`, and update without a reload.
- [ ] A URL that is not a GitHub repository, a private repository, a repository that does not exist, and an empty repository are each rejected, and use no slot.
- [ ] Adding a repository the user already has, in another URL form, opens the existing one.
- [ ] A sixth repository is rejected. Deleting one lets the user add another. Retrying a failed analysis does not use a second slot.
- [ ] An eleventh analysis started within 24 hours is rejected.
- [ ] A twenty-first add or retry request within an hour is rejected, including when the earlier requests were rejected.
- [ ] A repository made private while its analysis is queued fails as not found or private.
- [ ] With email configured, an unverified user cannot add or retry, through the page or the server. With email disabled, they can.
- [ ] Another user's repository returns "not found" from every page and route.
- [ ] Unit tests cover: each category of dropped file, choosing 300 files from a larger listing, path-rule roles, the fallback when TypeSafe is unset or fails, URL parsing including every rejection, removing paths that are not in the analysis, and links outside the repository, and that model output is never rendered as raw HTML.
- [ ] With `TYPESAFE_API_KEY` unset, an analysis completes with local-signal ranking, and the page says so.
- [ ] With `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` unset, an analysis completes with the basic walkthrough and its note.
- [ ] Setting only one of `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` fails environment validation without printing a value.
- [ ] When the writer keeps failing, the analysis fails with a reason, and a retry can then succeed.
- [ ] An analysis interrupted by stopping the worker starts over and completes.
- [ ] An analysis that runs past 15 minutes fails as timed out.
- [ ] Deleting a running analysis stops it, and nothing is saved for it afterwards.
- [ ] After an analysis ends, successfully or not, the database holds no file contents, including in the job queue's records.
- [ ] During an end-to-end run, neither Sentry nor PostHog receives file contents, walkthrough text, prompts, or model output.
- [ ] No unit or end-to-end test reaches GitHub, TypeSafe, or Anthropic. End-to-end tests use local fakes. CI needs no new secrets.
- [ ] An end-to-end test signs up, verifies the address, adds a repository, reads the finished walkthrough, and deletes the repository.
- [ ] `pnpm verify` passes with every new variable empty.
- [ ] Searching the built browser output for `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`, and `GITHUB_API_TOKEN` returns nothing.
- [ ] `docs/architecture/` describes the analysis, the worker, the GitHub and writer packages, and how to run the worker in production. `deployment.md`, `environment.md`, `dependencies.md`, `.env.example`, `AGENTS.md`, and `README.md` are updated.
- [ ] `pnpm agent:check` passes.
