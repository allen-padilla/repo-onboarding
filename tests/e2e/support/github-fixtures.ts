// The repositories the GitHub stub serves (`github-stub.ts`), shared with the
// tests that read what the pages show. No imports, so both Node and
// Playwright can load it. See docs/architecture/testing.md.

/** An owner that is unlikely to exist on GitHub, so a misconfigured run finds nothing there. */
export const OWNER = "e2e-fixtures-7c1d";

/** In every fixture file. Tests search for it where file contents must never appear. */
export const FILE_MARKER = "e2e-file-marker-4f9b2c";

/** In the main fixture's description, which becomes walkthrough text. */
export const DESCRIPTION_MARKER = "e2e-description-marker-8a1e";

export const COMMIT = "c0ffee5e0d1a2b3c4d5e6f708192a3b4c5d6e7f8";

export interface Fixture {
  /** Canonical case, as GitHub returns it. */
  readonly name: string;
  readonly description: string | null;
  readonly private?: boolean;
  /** Public on the first repository request, private on every later one. */
  readonly turnsPrivate?: boolean;
  /** No commits: the branch head answers 409. */
  readonly empty?: boolean;
  /** GitHub could not list every file. */
  readonly truncated?: boolean;
  /** How long the file listing takes, so a test can see the analysis running. */
  readonly listingDelayMs?: number;
  readonly files: Readonly<Record<string, string | Uint8Array>>;
}

const text = (path: string) => `// ${path}\n// ${FILE_MARKER}\nexport {};\n`;

/**
 * A public repository with an entry point, configuration, source, tests, and
 * docs, and a file of each kind the analysis drops by its path. Its listing
 * takes 3 seconds, so a test can see the analysis before it finishes.
 */
export const MAIN: Fixture = {
  name: "Walkthrough-Fixture",
  // Markup that would run if a page rendered repository text as HTML.
  description: `A repository for end-to-end tests. <img src=x onerror="window.e2eInjected = true"> ${DESCRIPTION_MARKER}`,
  listingDelayMs: 3_000,
  files: {
    "README.md": `# Walkthrough fixture\n\n${FILE_MARKER}\n`,
    "package.json": JSON.stringify({ name: "walkthrough-fixture", description: FILE_MARKER }),
    "src/index.ts": text("src/index.ts"),
    "src/lib/parse.ts": text("src/lib/parse.ts"),
    "tests/parse.test.ts": text("tests/parse.test.ts"),
    "docs/getting started.md": `# Getting started\n\n${FILE_MARKER}\n`,
    "docs/faq#1.md": `# FAQ\n\n${FILE_MARKER}\n`,
    "docs/café.md": `# Café\n\n${FILE_MARKER}\n`,
    "src/server/app.ts": text("src/server/app.ts"),
    // Dropped: a lockfile, vendored code, a binary, and build output.
    "pnpm-lock.yaml": `lockfileVersion: '9.0'\n# ${FILE_MARKER}\n`,
    "vendor/left-pad/index.js": text("vendor/left-pad/index.js"),
    "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, ...new TextEncoder().encode(FILE_MARKER)]),
    "dist/index.js": text("dist/index.js"),
  },
};

/** The main fixture's files that the analysis keeps. */
export const MAIN_KEPT = [
  "README.md",
  "package.json",
  "src/index.ts",
  "src/lib/parse.ts",
  "src/server/app.ts",
  "tests/parse.test.ts",
  "docs/getting started.md",
  "docs/faq#1.md",
  "docs/café.md",
];

export const PRIVATE: Fixture = {
  name: "Private-Fixture",
  description: null,
  private: true,
  files: { "README.md": `# Private\n\n${FILE_MARKER}\n` },
};

export const EMPTY: Fixture = { name: "Empty-Fixture", description: null, empty: true, files: {} };

export const TRUNCATED: Fixture = {
  name: "Truncated-Fixture",
  description: null,
  truncated: true,
  listingDelayMs: 3_000,
  files: { "README.md": `# Truncated\n\n${FILE_MARKER}\n` },
};

/** A repository with no fixture: GitHub answers 404. */
export const MISSING = "Missing-Fixture";

const FIXTURES = [MAIN, PRIVATE, EMPTY, TRUNCATED];

/**
 * The fixture for a requested name, ignoring case like GitHub. Two families
 * are served under any suffix, so each test can have its own:
 * `turns-private-*`, public when added and private when its analysis starts,
 * and `small-*`, small public repositories for the slot limit.
 */
export function findFixture(name: string): Fixture | undefined {
  const lower = name.toLowerCase();
  const fixture = FIXTURES.find((candidate) => candidate.name.toLowerCase() === lower);
  if (fixture) return fixture;

  if (/^turns-private-[a-z0-9-]+$/.test(lower)) {
    return { name: lower, description: null, turnsPrivate: true, files: { "README.md": `# Soon private\n\n${FILE_MARKER}\n` } };
  }
  if (/^small-[a-z0-9-]+$/.test(lower)) {
    return { name: lower, description: null, files: { "README.md": `# Small\n\n${FILE_MARKER}\n`, "src/index.ts": text("src/index.ts") } };
  }
  return undefined;
}
