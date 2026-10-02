import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Deterministic environment: @startup/env validates on import. Tests run on
    // in-memory PGlite with pg-boss, inject a fake GitHub client, and cannot
    // open connections.
    env: {
      DATABASE_URL: "postgresql://unused@127.0.0.1:5432/unused",
      BETTER_AUTH_SECRET: "test-only-secret-that-is-at-least-32-chars",
      BETTER_AUTH_URL: "http://localhost:3000",
      SMTP_URL: "",
      EMAIL_FROM: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "",
      GITHUB_API_TOKEN: "",
      GITHUB_API_URL: "",
    },
    setupFiles: ["./src/testing/no-network.ts"],
    // Each test copies a prepared PGlite database and starts pg-boss on it.
    // That takes well under a second locally but several seconds on CI
    // runners, where other packages' PGlite suites run at the same time.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
