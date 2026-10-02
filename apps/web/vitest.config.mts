import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit tests for components that render untrusted content. Pages and routes
// are covered end to end in tests/e2e.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
