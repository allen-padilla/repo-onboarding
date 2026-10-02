// The repository pages and routes in a browser, with the worker and the
// GitHub stub that Playwright starts. No model keys are set, so every analysis
// ranks files by local signals and writes the basic walkthrough. See
// docs/specs/repo-onboarding-core.md.
import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { regularBrowserPage } from "./support/browser";
import { expect, test as base } from "./support/fixtures";
import {
  COMMIT,
  DESCRIPTION_MARKER,
  EMPTY,
  FILE_MARKER,
  MAIN,
  MAIN_KEPT,
  MISSING,
  OWNER,
  PRIVATE,
  TRUNCATED,
} from "./support/github-fixtures";
import { uniqueAddress } from "./support/identity";
import { linkPath, waitForMessage } from "./support/mailpit";
import { observabilityReceived } from "./support/observability";

const PASSWORD = "e2e-password-123";

/** The `Origin` header of the application's own pages: Playwright's baseURL. Routes refuse any other. */
function sameOrigin() {
  return { origin: new URL(base.info().project.use.baseURL!).origin };
}

// The worker polls every 2 seconds, and a user's second analysis waits 15
// seconds while the first runs.
const ANALYSIS_TIMEOUT = 60_000;

const NOT_FOUND = "That repository doesn't exist or isn't public.";

/**
 * Deletes every repository the page's user still has, through the delete
 * route, so no queued job outlives the test in the shared local database.
 */
async function deleteRepositories(user: Page) {
  const html = await (await user.request.get("/repositories")).text();

  for (const id of new Set(html.match(/(?<=\/repositories\/)[0-9a-f-]{36}/g) ?? [])) {
    const response = await user.request.delete(`/api/repositories/${id}`, { headers: sameOrigin() });

    expect(response.status(), `cleanup of ${id}`).toBe(204);
  }
}

const test = base.extend<{ cleanUp: (page: Page) => void }>({
  // Deletes the registered users' repositories after the test, passed or
  // failed. Depends on `page` and `newVisitor`, so their pages are still open
  // when it runs.
  cleanUp: async ({ page: _page, newVisitor: _newVisitor }, use) => {
    const users: Page[] = [];

    await use((user) => {
      users.push(user);
    });

    for (const user of users) await deleteRepositories(user);
  },
});

test.describe.configure({ timeout: 120_000 });

/** The page's path and query. */
function location(page: Page) {
  const url = new URL(page.url());

  return `${url.pathname}${url.search}`;
}

const repositoryUrl = (name: string) => `https://github.com/${OWNER}/${name}`;

/** Signs up a new user, who lands on the repository list, and verifies the address through Mailpit. */
async function signUp(page: Page, { verified = true } = {}) {
  const email = uniqueAddress();

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((url) => url.pathname === "/repositories");

  if (!verified) return;

  await page.goto(linkPath(await waitForMessage(email, { subject: /confirm/i })));
  await expect(page.getByText("Your email address has been verified.")).toBeVisible();
}

/** Adds a repository through the form, and returns the ID of the page it lands on. */
async function addThroughForm(page: Page, url: string): Promise<string> {
  await page.goto("/repositories");
  await page.getByLabel("Repository URL").fill(url);
  await page.getByRole("button", { name: "Add repository" }).click();
  await page.waitForURL(/\/repositories\/[0-9a-f-]{36}$/);

  return new URL(page.url()).pathname.split("/").pop()!;
}

/** Adds a repository through the route, as the page's user. */
function addThroughRoute(page: Page, url: string) {
  return page.request.post("/api/repositories", { headers: sameOrigin(), data: { url } });
}

/** The value next to `term` in a description list. */
function definition(page: Page, term: string) {
  return page.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}

async function deleteThroughPage(page: Page) {
  await page.getByRole("button", { name: "Delete repository" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/repositories");
}

test("signed out, the pages go to sign-in and the routes answer 401", async ({ page }) => {
  const id = randomUUID();

  await page.goto("/repositories");
  expect(location(page)).toBe("/sign-in?redirect=%2Frepositories");

  await page.goto(`/repositories/${id}`);
  expect(location(page)).toBe(`/sign-in?redirect=${encodeURIComponent(`/repositories/${id}`)}`);

  const responses = [
    await addThroughRoute(page, repositoryUrl(MAIN.name)),
    await page.request.post(`/api/repositories/${id}/retry`, { headers: sameOrigin() }),
    await page.request.delete(`/api/repositories/${id}`, { headers: sameOrigin() }),
  ];

  expect(responses.map((response) => response.status())).toEqual([401, 401, 401]);
});

test("the routes refuse other origins, and malformed or unknown IDs are not found", async ({ page }) => {
  await signUp(page, { verified: false });

  for (const origin of [undefined, "https://example.com", "http://localhost:3000"]) {
    const response = await page.request.post("/api/repositories", {
      headers: origin ? { origin } : {},
      data: { url: repositoryUrl(MAIN.name) },
    });

    expect(response.status(), `origin ${origin}`).toBe(403);
    expect(await response.json()).toEqual({ error: "FORBIDDEN_ORIGIN" });
  }

  for (const id of ["not-a-uuid", randomUUID()]) {
    expect((await page.goto(`/repositories/${id}`))?.status(), `page ${id}`).toBe(404);
    expect((await page.request.post(`/api/repositories/${id}/retry`, { headers: sameOrigin() })).status()).toBe(404);
    expect((await page.request.delete(`/api/repositories/${id}`, { headers: sameOrigin() })).status()).toBe(404);
  }
});

test("an unverified user is asked to verify and cannot add", async ({ page }) => {
  await signUp(page, { verified: false });

  const main = page.getByRole("main");

  await expect(main.getByText("Verify your email address to add or retry repositories.")).toBeVisible();
  await expect(main.getByRole("link", { name: "Go to your account" })).toHaveAttribute("href", "/account");
  await expect(page.getByLabel("Repository URL")).toHaveCount(0);

  const response = await addThroughRoute(page, repositoryUrl(MAIN.name));

  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({ error: "VERIFICATION_REQUIRED" });
});

test("a verified user adds a repository, sees it finish without a reload, reads the walkthrough, and deletes it", async ({
  page,
  cleanUp,
}) => {
  cleanUp(page);
  await signUp(page);
  await page.goto("/repositories");
  await expect(page.getByText("0 of 5 used")).toBeVisible();

  // The path after the name is ignored. GitHub gives the canonical case.
  const id = await addThroughForm(page, `https://github.com/${OWNER}/walkthrough-fixture/tree/main/src`);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${OWNER}/${MAIN.name}`);

  // Every step from here is a client navigation or a refresh. A full load
  // would lose this.
  await page.evaluate(() => Object.assign(window, { e2eNoReload: true }));

  await page.getByRole("link", { name: "Repositories", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/repositories");

  const item = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: `${OWNER}/${MAIN.name}` }) });

  // The fixture's listing takes 3 seconds, so the list first shows the
  // analysis waiting or running, then refreshes itself to done.
  await expect(item.getByText(/^(Queued|Running)$/)).toBeVisible();
  await expect(item.getByText("Done", { exact: true })).toBeVisible({ timeout: ANALYSIS_TIMEOUT });
  await expect(item.getByText(COMMIT.slice(0, 7))).toBeVisible();
  await expect(page.getByText("1 of 5 used")).toBeVisible();

  await item.getByRole("link").click();
  await page.waitForURL((url) => url.pathname === `/repositories/${id}`);
  expect(await page.evaluate(() => "e2eNoReload" in window)).toBe(true);

  await expect(definition(page, "Status")).toHaveText("Done");
  await expect(page.getByRole("link", { name: COMMIT.slice(0, 7) })).toHaveAttribute(
    "href",
    `https://github.com/${OWNER}/${MAIN.name}/tree/${COMMIT}`,
  );

  // The four sections, and the note that no writing model wrote them.
  for (const name of ["What the project is", "How it is organized", "Key files", "Suggested reading order"]) {
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  }
  await expect(page.getByText("No writing model is configured on this server")).toBeVisible();

  // Repository text is shown as text: the description's markup is neither an
  // element nor a script.
  await expect(page.getByText(MAIN.description!)).toBeVisible();
  await expect(page.getByRole("main").locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => "e2eInjected" in window)).toBe(false);

  // 13 files listed; the lockfile, the vendored file, the image, and the
  // build output are dropped.
  await expect(definition(page, "Files listed")).toHaveText("13");
  await expect(definition(page, "Dropped")).toHaveText("4");
  await expect(definition(page, "Left unscored by the file limit")).toHaveText("0");
  await expect(definition(page, "Ranked by local signals only")).toHaveText("9");
  await expect(page.getByText("Every file was ranked by local signals")).toBeVisible();

  // Every kept file is a key file and a reading-order step, linked at the
  // analyzed commit with each segment encoded.
  const blob = (path: string) => `https://github.com/${OWNER}/${MAIN.name}/blob/${COMMIT}/${path}`;

  for (const path of MAIN_KEPT) {
    const links = page.getByRole("link", { name: path, exact: true });

    await expect(links, path).toHaveCount(2);
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute("href", blob(path.split("/").map(encodeURIComponent).join("/")));
    }
  }
  for (const [path, href] of [
    ["docs/getting started.md", "docs/getting%20started.md"],
    ["docs/faq#1.md", "docs/faq%231.md"],
    ["docs/café.md", "docs/caf%C3%A9.md"],
  ] as const) {
    await expect(page.getByRole("link", { name: path, exact: true }).first()).toHaveAttribute("href", blob(href));
  }
  await expect(page.getByRole("link", { name: "src/", exact: true })).toHaveAttribute(
    "href",
    `https://github.com/${OWNER}/${MAIN.name}/tree/${COMMIT}/src`,
  );
  await expect(
    page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "src/index.ts", exact: true }) }).first(),
  ).toContainText("Entry point");

  for (const dropped of ["pnpm-lock.yaml", "vendor/left-pad/index.js", "assets/logo.png", "dist/index.js"]) {
    await expect(page.getByText(dropped), dropped).toHaveCount(0);
  }

  await deleteThroughPage(page);
  await expect(page.getByText("0 of 5 used")).toBeVisible();
  await expect(page.getByText("No repositories yet.")).toBeVisible();
  expect((await page.request.get(`/repositories/${id}`)).status()).toBe(404);
});

test("adding a repository the user already has, in another URL form, opens it", async ({ page, cleanUp }) => {
  cleanUp(page);
  await signUp(page);

  const id = await addThroughForm(page, `github.com/${OWNER}/walkthrough-fixture`);
  const again = await addThroughForm(page, `HTTPS://WWW.GITHUB.COM/${OWNER.toUpperCase()}/WALKTHROUGH-FIXTURE.git/`);

  expect(again).toBe(id);

  await page.goto("/repositories");
  await expect(page.getByText("1 of 5 used")).toBeVisible();
});

test("private, missing, empty, and non-GitHub URLs are rejected and use no slot", async ({ page, cleanUp }) => {
  cleanUp(page);
  await signUp(page);
  await page.goto("/repositories");

  const alert = page.getByRole("main").getByRole("alert");
  let sent = 0;

  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/repositories") sent += 1;
  });

  // Each message differs from the one before, so each is the new response's.
  for (const [url, message] of [
    [repositoryUrl(PRIVATE.name), NOT_FOUND],
    [repositoryUrl(EMPTY.name), "That repository is empty."],
    [repositoryUrl(MISSING), NOT_FOUND],
  ] as const) {
    const response = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/repositories");

    await page.getByLabel("Repository URL").fill(url);
    await page.getByRole("button", { name: "Add repository" }).click();
    expect((await response).status(), url).toBe(422);
    await expect(alert).toHaveText(message);
  }

  // The page catches a URL that is not GitHub's without sending it. The
  // server rejects it too.
  await page.getByLabel("Repository URL").fill("https://gitlab.com/owner/repo");
  await page.getByRole("button", { name: "Add repository" }).click();
  await expect(alert).toHaveText("Enter a GitHub repository URL, such as https://github.com/owner/repo.");
  expect(sent).toBe(3);

  const response = await addThroughRoute(page, "https://gitlab.com/owner/repo");

  expect(response.status()).toBe(400);
  expect(await response.json()).toEqual({ error: "INVALID_URL" });

  await page.reload();
  await expect(page.getByText("0 of 5 used")).toBeVisible();
  await expect(page.getByText("No repositories yet.")).toBeVisible();
});

test("simultaneous adds create one repository and never pass the limit", async ({ page, cleanUp }) => {
  cleanUp(page);
  await signUp(page);

  // Two tabs add the same repository: one is saved, and both get it.
  const same = await Promise.all([
    addThroughRoute(page, repositoryUrl("small-same")),
    addThroughRoute(page, repositoryUrl("small-same")),
  ]);

  expect(same.map((response) => response.status()).sort()).toEqual([200, 201]);

  const [first, second] = await Promise.all(same.map((response) => response.json()));

  expect(first.id).toBe(second.id);

  for (const name of ["small-a", "small-b", "small-c"]) {
    expect((await addThroughRoute(page, repositoryUrl(name))).status(), name).toBe(201);
  }

  // One slot is left. Two different repositories at once: one is saved.
  const different = await Promise.all([
    addThroughRoute(page, repositoryUrl("small-d")),
    addThroughRoute(page, repositoryUrl("small-e")),
  ]);

  expect(different.map((response) => response.status()).sort()).toEqual([201, 409]);
  expect(await different.find((response) => response.status() === 409)!.json()).toEqual({
    error: "REPOSITORY_LIMIT",
  });

  await page.goto("/repositories");
  await expect(page.getByText("5 of 5 used")).toBeVisible();
});

test("a sixth repository is rejected, and deleting one frees its slot", async ({ page, cleanUp }) => {
  cleanUp(page);
  await signUp(page);

  const ids: string[] = [];

  for (let n = 1; n <= 5; n += 1) {
    const response = await addThroughRoute(page, repositoryUrl(`small-${n}`));

    expect(response.status()).toBe(201);
    ids.push((await response.json()).id);
  }

  const sixth = await addThroughRoute(page, repositoryUrl("small-6"));

  expect(sixth.status()).toBe(409);
  expect(await sixth.json()).toEqual({ error: "REPOSITORY_LIMIT" });

  await page.goto("/repositories");
  await expect(page.getByText("5 of 5 used")).toBeVisible();
  await expect(page.getByRole("main").getByText("Delete a repository to add another.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Repository URL")).toHaveCount(0);

  await page.goto(`/repositories/${ids[0]}`);
  await deleteThroughPage(page);
  await expect(page.getByText("4 of 5 used")).toBeVisible();

  const id = await addThroughForm(page, repositoryUrl("small-6"));

  expect(ids).not.toContain(id);
});

test("another user's repository is not found from every page and route", async ({ page, newVisitor, cleanUp }) => {
  cleanUp(page);
  await signUp(page);

  const { id } = await (await addThroughRoute(page, repositoryUrl("small-owned"))).json();
  const other = await newVisitor();

  await signUp(other);

  expect((await other.goto(`/repositories/${id}`))?.status()).toBe(404);
  expect((await other.request.post(`/api/repositories/${id}/retry`, { headers: sameOrigin() })).status()).toBe(404);
  expect((await other.request.delete(`/api/repositories/${id}`, { headers: sameOrigin() })).status()).toBe(404);

  // The owner still has it.
  expect((await page.goto(`/repositories/${id}`))?.status()).toBe(200);
});

test("a repository GitHub cannot list in full fails as too large, and a retry keeps its slot", async ({
  page,
  cleanUp,
}) => {
  cleanUp(page);
  await signUp(page);
  await addThroughForm(page, repositoryUrl(TRUNCATED.name));

  await expect(page.getByText("The repository is too large to analyze.")).toBeVisible({ timeout: ANALYSIS_TIMEOUT });
  await expect(definition(page, "Status")).toContainText("Failed");

  const retry = page.waitForResponse((response) => response.url().endsWith("/retry"));

  await page.getByRole("button", { name: "Retry analysis" }).click();
  expect((await retry).status()).toBe(200);

  // It starts over. The fixture's listing takes 3 seconds, so the page shows
  // the new analysis before it fails the same way.
  await expect(definition(page, "Status")).toHaveText(/^(Queued|Running)$/);
  await expect(definition(page, "Status")).toContainText("Failed", { timeout: ANALYSIS_TIMEOUT });
  await expect(page.getByText("The repository is too large to analyze.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry analysis" })).toBeVisible();

  await page.goto("/repositories");
  await expect(page.getByText("1 of 5 used")).toBeVisible();
});

test("a repository made private before its analysis starts fails as not found", async ({ page, cleanUp }) => {
  cleanUp(page);
  await signUp(page);
  await addThroughForm(page, repositoryUrl(`turns-private-${randomUUID().slice(0, 8)}`));

  await expect(page.getByText("The repository was not found or is not public.")).toBeVisible({
    timeout: ANALYSIS_TIMEOUT,
  });
  await expect(page.getByRole("button", { name: "Retry analysis" })).toBeVisible();
});

test("PostHog and Sentry receive no file contents or walkthrough text, and PostHog no repository names", async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await regularBrowserPage(browser, baseURL);

  try {
    await signUp(page);

    const id = await addThroughForm(page, repositoryUrl(MAIN.name));

    await expect(definition(page, "Status")).toHaveText("Done", { timeout: ANALYSIS_TIMEOUT });

    // Clicks that autocapture records outside `ph-no-capture`, with the
    // link's text. Links to GitHub are clicked, but the browser stays here.
    await page.evaluate(() => {
      document.addEventListener(
        "click",
        (event) => {
          if (event.target instanceof Element && event.target.closest('a[href^="https://github.com/"]')) {
            event.preventDefault();
          }
        },
        true,
      );
    });
    await page.getByRole("link", { name: "docs/getting started.md", exact: true }).first().click();
    await page.getByRole("link", { name: "View on GitHub" }).click();
    await page.getByRole("link", { name: "Repositories", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/repositories");
    await page.getByRole("link", { name: `${OWNER}/${MAIN.name}` }).click();
    await page.waitForURL((url) => url.pathname === `/repositories/${id}`);
    await page.getByRole("link", { name: "Repositories", exact: true }).click();
    await page.getByRole("link", { name: "Account", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/account");

    // PostHog sends events in order, so once this visit to the account
    // page arrives, everything captured before it has too. The visit after
    // verification had a query.
    const accountPageview = `"$current_url":"${new URL("/account", baseURL).href}"`;

    await expect
      .poll(async () => (await observabilityReceived()).some((body) => body.includes(accountPageview)), {
        message: "PostHog receives the account page's pageview",
        timeout: 30_000,
      })
      .toBe(true);

    // Booleans, so a failure does not print what was received.
    const received = await observabilityReceived();
    const everything = received.join("\n");
    // Sentry's server spans may name the repository in a GitHub request URL.
    const posthog = received.filter((body) => !body.includes("/envelope/")).join("\n");

    expect(everything.includes(FILE_MARKER), "no file contents").toBe(false);
    expect(everything.includes(DESCRIPTION_MARKER), "no walkthrough text").toBe(false);
    expect(everything.includes("getting started.md"), "no file paths").toBe(false);
    expect(posthog.toLowerCase().includes(MAIN.name.toLowerCase()), "no repository names in PostHog").toBe(false);
  } finally {
    await deleteRepositories(page);
    await context.close();
  }
});
