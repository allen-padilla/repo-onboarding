import { defineConfig, devices } from "@playwright/test";

// Better Auth checks that browser requests come from BETTER_AUTH_URL's origin,
// which must match the origin the tests use. CI already sets it; locally,
// .env.local usually says localhost. Neither next.config.ts nor the worker
// overrides variables that are already set, including empty ones.
const BETTER_AUTH_URL = "http://127.0.0.1:3000";

// The web app and the worker reach GitHub through the GitHub stub, and run
// with no model keys: analyses rank files by local signals and write the
// basic walkthrough. See docs/architecture/testing.md.
const analysisEnv = {
  GITHUB_API_URL: "http://127.0.0.1:9998",
  GITHUB_API_TOKEN: "",
  TYPESAFE_API_KEY: "",
  TYPESAFE_MODEL: "",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_MODEL: "",
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",

  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: [
    {
      // Stands in for Sentry and PostHog. `scripts/build-e2e.sh` points both here.
      command: "node tests/e2e/support/observability-stub.ts",
      url: "http://127.0.0.1:9999",
      reuseExistingServer: false,
    },
    {
      // Stands in for the GitHub API, for the web app and the worker.
      command: "node tests/e2e/support/github-stub.ts",
      url: "http://127.0.0.1:9998",
      reuseExistingServer: false,
    },
    {
      command: "./scripts/start-e2e-server.sh",
      url: "http://127.0.0.1:3000",
      env: { ...process.env, ...analysisEnv, BETTER_AUTH_URL },
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      // Runs the analyses the tests queue. It reports errors to the
      // observability stub, like the app.
      command: "./scripts/start-e2e-worker.sh",
      wait: { stdout: /worker ready/ },
      env: {
        ...process.env,
        ...analysisEnv,
        BETTER_AUTH_URL,
        NEXT_PUBLIC_SENTRY_DSN: "http://e2e@127.0.0.1:9999/1",
      },
      // SIGTERM lets the worker return any analysis it is running to the
      // queue before it exits.
      gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
      timeout: 120_000,
    },
  ],
});
