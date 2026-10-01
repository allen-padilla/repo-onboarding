import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createGitHubClient, type GitHubClientOptions } from "./client";
import {
  GitHubEmptyRepositoryError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubRepositoryTooLargeError,
  GitHubUnavailableError,
} from "./errors";
import { githubTarball } from "./testing/tarball";

const TOKEN = "github_pat_test_s3cret";
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface Call {
  readonly url: URL;
  readonly headers: Record<string, string>;
}

type Handler = (url: URL, signal: AbortSignal | undefined) => Response | Promise<Response>;

/** A client whose requests go to `handle`, recording every call. */
function client(handle: Handler, options: GitHubClientOptions = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return handle(url, init?.signal ?? undefined);
  }) as typeof globalThis.fetch;

  return { github: createGitHubClient({ fetch, ...options }), calls };
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const repository = {
  name: "Widget",
  owner: { login: "Acme" },
  description: "A widget.",
  default_branch: "main",
  private: false,
  visibility: "public",
};

async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error as Error,
  );
}

describe("requests", () => {
  it("call the GitHub API with the API version and no token by default", async () => {
    const { github, calls } = client(() => json(repository));

    await github.getRepository("acme", "widget");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.href).toBe("https://api.github.com/repos/acme/widget");
    expect(calls[0]?.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("send the token to the API origin", async () => {
    const { github, calls } = client(() => json(repository), { token: TOKEN });

    await github.getRepository("acme", "widget");

    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("use the configured API URL, including a path", async () => {
    const { github, calls } = client(() => json(repository), {
      apiUrl: "http://127.0.0.1:9998/api/v3/",
    });

    await github.getRepository("acme", "widget");

    expect(calls[0]?.url.href).toBe("http://127.0.0.1:9998/api/v3/repos/acme/widget");
  });

  it("encode owners, names, and paths, so no input can change the request path", async () => {
    const { github, calls } = client((url) =>
      url.pathname.includes("/contents/") ? new Response("x") : json(repository),
    );

    await github.getRepository("acme", "../../user");
    await github.readFile("acme", "widget", SHA, "docs/a b#?.md", { maxBytes: 100 });

    expect(calls[0]?.url.pathname).toBe("/repos/acme/..%2F..%2Fuser");
    expect(calls[1]?.url.pathname).toBe("/repos/acme/widget/contents/docs/a%20b%23%3F.md");
    expect(calls[1]?.url.searchParams.get("ref")).toBe(SHA);
  });

  it.each([
    ["404", 404, GitHubNotFoundError],
    ["451", 451, GitHubNotFoundError],
    ["403 without a rate limit", 403, GitHubNotFoundError],
    ["500", 500, GitHubUnavailableError],
  ])("map %s", async (_case, status, type) => {
    const { github } = client(() => json({ message: "nope" }, { status }));

    await expect(github.getRepository("acme", "widget")).rejects.toBeInstanceOf(type);
  });

  it("report a rejected token as unavailable, without the token", async () => {
    const { github } = client(() => json({ message: "Bad credentials" }, { status: 401 }), {
      token: TOKEN,
    });

    const error = await rejection(github.getRepository("acme", "widget"));

    expect(error).toBeInstanceOf(GitHubUnavailableError);
    expect(error).toMatchObject({ reason: "authentication", status: 401 });
    expect(error.message).not.toContain(TOKEN);
  });

  it("report a primary rate limit with its reset time", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const { github } = client(() =>
      json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        },
      ),
    );

    const error = await rejection(github.getRepository("acme", "widget"));

    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt.getTime()).toBe(reset * 1000);
  });

  it("report a secondary rate limit from retry-after, or wait a minute without it", async () => {
    const before = Date.now();
    const withHeader = client(() =>
      json({ message: "slow down" }, { status: 429, headers: { "retry-after": "30" } }),
    );
    const withMessage = client(() =>
      json({ message: "You have exceeded a secondary rate limit." }, { status: 403 }),
    );

    const fromHeader = (await rejection(withHeader.github.getRepository("acme", "widget"))) as GitHubRateLimitError;
    const fromMessage = (await rejection(withMessage.github.getRepository("acme", "widget"))) as GitHubRateLimitError;

    expect(fromHeader).toBeInstanceOf(GitHubRateLimitError);
    expect(fromHeader.resetAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(fromHeader.resetAt.getTime()).toBeLessThan(before + 31_000 + 1000);
    expect(fromMessage).toBeInstanceOf(GitHubRateLimitError);
    expect(fromMessage.resetAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(fromMessage.message).not.toContain("secondary");
  });

  it("report a network failure without the request", async () => {
    const { github } = client(() => {
      throw new TypeError(`fetch failed: Authorization Bearer ${TOKEN}`);
    }, { token: TOKEN });

    const error = await rejection(github.getRepository("acme", "widget"));

    expect(error).toMatchObject({ name: "GitHubUnavailableError", reason: "network" });
    expect(error.message).not.toContain(TOKEN);
    expect(error).not.toHaveProperty("cause");
  });

  it("time out", async () => {
    const { github } = client(
      (_url, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
      { timeoutMs: 20 },
    );

    await expect(github.getRepository("acme", "widget")).rejects.toMatchObject({ reason: "timeout" });
  });

  it("pass on the caller's cancellation", async () => {
    const controller = new AbortController();
    const { github } = client(
      (_url, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    const pending = github.getRepository("acme", "widget", { signal: controller.signal });
    controller.abort(new Error("stopped"));

    await expect(pending).rejects.toThrow("stopped");
  });

  it("reject a response that is not valid JSON or has another shape", async () => {
    const notJson = client(() => new Response("<html>"));
    const wrongShape = client(() => json({ name: "widget" }));

    await expect(notJson.github.getRepository("acme", "widget")).rejects.toMatchObject({
      reason: "invalid_response",
    });
    await expect(wrongShape.github.getRepository("acme", "widget")).rejects.toMatchObject({
      reason: "invalid_response",
    });
  });
});

describe("getRepository", () => {
  it("returns the canonical name, description, and default branch", async () => {
    const { github } = client(() => json(repository));

    await expect(github.getRepository("acme", "widget")).resolves.toEqual({
      owner: "Acme",
      name: "Widget",
      description: "A widget.",
      defaultBranch: "main",
    });
  });

  it("treats a private or internal repository as missing, even when the token can read it", async () => {
    const isPrivate = client(() => json({ ...repository, private: true, visibility: "private" }), {
      token: TOKEN,
    });
    const isInternal = client(() => json({ ...repository, visibility: "internal" }), { token: TOKEN });

    await expect(isPrivate.github.getRepository("acme", "widget")).rejects.toBeInstanceOf(GitHubNotFoundError);
    await expect(isInternal.github.getRepository("acme", "widget")).rejects.toBeInstanceOf(GitHubNotFoundError);
  });

  it("follows a redirect for a renamed repository on the API origin", async () => {
    const { github, calls } = client((url) =>
      url.pathname === "/repos/acme/old-name"
        ? new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/42" } })
        : json(repository),
    );

    await expect(github.getRepository("acme", "old-name")).resolves.toMatchObject({ name: "Widget" });
    expect(calls.map((call) => call.url.href)).toEqual([
      "https://api.github.com/repos/acme/old-name",
      "https://api.github.com/repositories/42",
    ]);
  });
});

describe("getBranchHead", () => {
  it("returns the branch's latest commit", async () => {
    const { github, calls } = client(() => json({ ref: "refs/heads/main", object: { sha: SHA } }));

    await expect(github.getBranchHead("acme", "widget", "release/v1#2")).resolves.toBe(SHA);
    expect(calls[0]?.url.pathname).toBe("/repos/acme/widget/git/ref/heads/release/v1%232");
  });

  it("reports an empty repository", async () => {
    const { github } = client(() => json({ message: "Git Repository is empty." }, { status: 409 }));

    await expect(github.getBranchHead("acme", "widget", "main")).rejects.toBeInstanceOf(
      GitHubEmptyRepositoryError,
    );
  });

  it("rejects a commit that is not a SHA", async () => {
    const { github } = client(() => json({ object: { sha: "../../x" } }));

    await expect(github.getBranchHead("acme", "widget", "main")).rejects.toMatchObject({
      reason: "invalid_response",
    });
  });
});

describe("getTree", () => {
  it("lists every entry, with sizes for files only", async () => {
    const { github, calls } = client(() =>
      json({
        sha: SHA,
        truncated: false,
        tree: [
          { path: "src", mode: "040000", type: "tree", sha: SHA },
          { path: "src/index.ts", mode: "100644", type: "blob", sha: SHA, size: 120 },
          { path: "bin/run", mode: "100755", type: "blob", sha: SHA, size: 30 },
          { path: "link", mode: "120000", type: "blob", sha: SHA, size: 9 },
          { path: "vendor/lib", mode: "160000", type: "commit", sha: SHA },
          { path: "odd", mode: "000000", type: "tag", sha: SHA },
        ],
      }),
    );

    await expect(github.getTree("acme", "widget", SHA)).resolves.toEqual([
      { path: "src", type: "directory", size: undefined },
      { path: "src/index.ts", type: "file", size: 120 },
      { path: "bin/run", type: "file", size: 30 },
      { path: "link", type: "symlink", size: undefined },
      { path: "vendor/lib", type: "submodule", size: undefined },
    ]);
    expect(calls[0]?.url.pathname).toBe(`/repos/acme/widget/git/trees/${SHA}`);
    expect(calls[0]?.url.searchParams.get("recursive")).toBe("1");
  });

  it("reports a listing GitHub could not complete as too large", async () => {
    const { github } = client(() => json({ sha: SHA, truncated: true, tree: [] }));

    await expect(github.getTree("acme", "widget", SHA)).rejects.toMatchObject({
      name: "GitHubRepositoryTooLargeError",
      reason: "listing_truncated",
    });
  });
});

describe("readFile", () => {
  it("returns a file's text", async () => {
    const { github, calls } = client(() => new Response("*.min.js linguist-generated\n"));

    await expect(
      github.readFile("acme", "widget", SHA, ".gitattributes", { maxBytes: 1000 }),
    ).resolves.toBe("*.min.js linguist-generated\n");
    expect(calls[0]?.headers.Accept).toBe("application/vnd.github.raw");
  });

  it("returns null for a missing file or one over the limit", async () => {
    const missing = client(() => json({ message: "Not Found" }, { status: 404 }));
    const large = client(() => new Response("x".repeat(101)));

    await expect(missing.github.readFile("acme", "widget", SHA, ".gitattributes", { maxBytes: 100 })).resolves.toBeNull();
    await expect(large.github.readFile("acme", "widget", SHA, ".gitattributes", { maxBytes: 100 })).resolves.toBeNull();
  });
});

describe("readFiles", () => {
  const limits = { maxDownloadBytes: 1_000_000, maxFileBytes: 1_000 };
  const longPath = `src/${"deeply/".repeat(20)}nested.ts`;

  async function archive() {
    return githubTarball([
      { path: "README.md", content: "# Widget" },
      { path: "src", type: "directory" },
      { path: "src/index.ts", content: "export {};" },
      { path: "src/large.ts", content: "x".repeat(1_001) },
      { path: longPath, content: "export const deep = true;" },
      { path: "docs/a b#ü.md", content: "unicode" },
      { path: "link", type: "symlink" },
      { path: "unrequested.ts", content: "skip" },
    ]);
  }

  it("follows the redirect to GitHub's archive host without the token and returns the requested files", async () => {
    const body = await archive();
    const { github, calls } = client(
      (url) =>
        url.hostname === "api.github.com"
          ? new Response(null, {
              status: 302,
              headers: { location: `https://codeload.github.com/acme/widget/legacy.tar.gz/${SHA}` },
            })
          : new Response(body),
      { token: TOKEN },
    );

    const files = await github.readFiles(
      "acme",
      "widget",
      SHA,
      ["README.md", "src/index.ts", "src/large.ts", longPath, "docs/a b#ü.md", "link", "missing.ts"],
      limits,
    );

    expect(Array.from(files.keys()).sort()).toEqual(["README.md", "docs/a b#ü.md", longPath, "src/index.ts"].sort());
    expect(new TextDecoder().decode(files.get(longPath))).toBe("export const deep = true;");
    expect(calls.map((call) => call.url.hostname)).toEqual(["api.github.com", "codeload.github.com"]);
    expect(calls[0]?.url.pathname).toBe(`/repos/acme/widget/tarball/${SHA}`);
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1]?.headers.Authorization).toBeUndefined();
  });

  it("refuses a redirect to any other host, without contacting it", async () => {
    const { github, calls } = client(() =>
      new Response(null, { status: 302, headers: { location: "https://evil.example.com/archive.tar.gz" } }),
    );

    await expect(github.readFiles("acme", "widget", SHA, ["README.md"], limits)).rejects.toMatchObject({
      name: "GitHubUnavailableError",
      reason: "redirect",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses an endless chain of redirects", async () => {
    const { github, calls } = client(() =>
      new Response(null, { status: 302, headers: { location: "https://api.github.com/again" } }),
    );

    await expect(github.readFiles("acme", "widget", SHA, ["README.md"], limits)).rejects.toMatchObject({
      reason: "redirect",
    });
    expect(calls).toHaveLength(4);
  });

  it("stops at the download limit", async () => {
    // Random bytes do not compress, so the archive stays over the limit.
    const body = await githubTarball([{ path: "big.bin", content: randomBytes(200_000) }]);
    const { github } = client(() => new Response(body));

    const error = await rejection(
      github.readFiles("acme", "widget", SHA, ["big.bin", "README.md"], { maxDownloadBytes: 10_000, maxFileBytes: 1_000_000 }),
    );

    expect(error).toBeInstanceOf(GitHubRepositoryTooLargeError);
    expect(error).toMatchObject({ reason: "download_limit" });
  });

  it("rejects an archive that is not gzip or not tar", async () => {
    const notGzip = client(() => new Response("not an archive"));
    const notTar = client(() => new Response(gzipSync(Buffer.from("not a tar file".repeat(100)))));

    await expect(notGzip.github.readFiles("acme", "widget", SHA, ["a"], limits)).rejects.toMatchObject({
      reason: "invalid_response",
    });
    await expect(notTar.github.readFiles("acme", "widget", SHA, ["a"], limits)).rejects.toMatchObject({
      reason: "invalid_response",
    });
  });

  it("returns nothing, without reading the archive, when no paths are requested", async () => {
    const { github } = client(async () => new Response(await archive()));

    await expect(github.readFiles("acme", "widget", SHA, [], limits)).resolves.toEqual(new Map());
  });

  it("maps errors before the download like any other request", async () => {
    const { github } = client(() => json({ message: "Not Found" }, { status: 404 }));

    await expect(github.readFiles("acme", "widget", SHA, ["README.md"], limits)).rejects.toBeInstanceOf(
      GitHubNotFoundError,
    );
  });
});
