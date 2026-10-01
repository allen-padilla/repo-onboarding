import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Deterministic environment: @startup/env validates on import. Tests run
    // pg-boss on in-memory PGlite and cannot open connections.
    env: {
      DATABASE_URL: "postgresql://unused@127.0.0.1:5432/unused",
      BETTER_AUTH_SECRET: "test-only-secret-that-is-at-least-32-chars",
      BETTER_AUTH_URL: "http://localhost:3000",
      SMTP_URL: "",
      EMAIL_FROM: "",
    },
    setupFiles: ["./src/testing/no-network.ts"],
  },
});
