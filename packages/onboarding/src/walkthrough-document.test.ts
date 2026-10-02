import { describe, expect, it } from "vitest";

import { githubUrl, isRepositoryPath, parseWalkthroughDocument, type WalkthroughDocument } from "./walkthrough-document";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("githubUrl", () => {
  it("links a file at the commit", () => {
    expect(githubUrl("Acme", "Widget", COMMIT, "src/index.ts", "file")).toBe(
      `https://github.com/Acme/Widget/blob/${COMMIT}/src/index.ts`,
    );
  });

  it("links a directory, and the root", () => {
    expect(githubUrl("acme", "widget", COMMIT, "src/server", "directory")).toBe(
      `https://github.com/acme/widget/tree/${COMMIT}/src/server`,
    );
    expect(githubUrl("acme", "widget", COMMIT, "", "directory")).toBe(`https://github.com/acme/widget/tree/${COMMIT}`);
  });

  it.each([
    ["docs/my notes.md", "docs/my%20notes.md"],
    ["src/#1.ts", "src/%231.ts"],
    ["src/why?.ts", "src/why%3F.ts"],
    ["src/naïve/日本.ts", "src/na%C3%AFve/%E6%97%A5%E6%9C%AC.ts"],
    ["src/100%.ts", "src/100%25.ts"],
  ])("encodes %s", (path, encoded) => {
    const url = githubUrl("acme", "widget", COMMIT, path, "file");

    expect(url).toBe(`https://github.com/acme/widget/blob/${COMMIT}/${encoded}`);
    // The browser opens the same path.
    expect(decodeURIComponent(new URL(url).pathname)).toBe(`/acme/widget/blob/${COMMIT}/${path}`);
  });

  it.each(["../../evil/repo", "src/../../x", "/etc/passwd", "src//a.ts", "./a.ts", ""])(
    "refuses the path %j for a file",
    (path) => {
      expect(() => githubUrl("acme", "widget", COMMIT, path, "file")).toThrow();
    },
  );

  it("refuses a malformed commit or repository name", () => {
    expect(() => githubUrl("acme", "widget", "main", "a.ts", "file")).toThrow();
    expect(() => githubUrl("..", "widget", COMMIT, "a.ts", "file")).toThrow();
    expect(() => githubUrl("acme", "a/b", COMMIT, "a.ts", "file")).toThrow();
  });
});

describe("isRepositoryPath", () => {
  it("accepts the root only as a directory", () => {
    expect(isRepositoryPath("", "directory")).toBe(true);
    expect(isRepositoryPath("", "file")).toBe(false);
  });
});

describe("parseWalkthroughDocument", () => {
  const document: WalkthroughDocument = {
    version: 1,
    kind: "basic",
    summary: [[{ type: "text", text: "A widget server." }]],
    directories: [
      { heading: { type: "path", kind: "directory", path: "src", text: "src/" }, description: [{ type: "text", text: "3 files" }] },
    ],
    keyFiles: [{ path: "src/index.ts", role: "entry_point", why: [] }],
    readingOrder: [{ path: "src/index.ts", note: [] }],
  };

  it("parses a stored document", () => {
    expect(parseWalkthroughDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
  });

  it.each([
    ["no document", null],
    ["another version", { ...document, version: 2 }],
    ["a path that leaves the repository", { ...document, keyFiles: [{ path: "../x", role: "test", why: [] }] }],
    ["an unknown segment", { ...document, summary: [[{ type: "html", text: "<b>x</b>" }]] }],
    ["a long code span", { ...document, summary: [[{ type: "code", text: "x".repeat(81) }]] }],
    ["an unknown role", { ...document, keyFiles: [{ path: "a.ts", role: "admin", why: [] }] }],
  ])("is null for %s", (_, value) => {
    expect(parseWalkthroughDocument(value)).toBeNull();
  });
});
