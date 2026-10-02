import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Imported first by main.ts, before anything reads the environment. Loads the
// root .env.local for local development, as apps/web/next.config.ts does. It
// never replaces a variable that is already set, so a deployment's own
// variables win, and production needs no file.
const localEnvFile = resolve(import.meta.dirname, "../../../.env.local");

if (existsSync(localEnvFile)) {
  process.loadEnvFile(localEnvFile);
}
