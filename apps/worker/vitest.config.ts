import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Sentry stays disabled in tests.
    env: { NEXT_PUBLIC_SENTRY_DSN: "" },
  },
});
