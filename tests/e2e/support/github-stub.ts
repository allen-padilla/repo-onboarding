// Stands in for the GitHub API during E2E runs. Playwright starts it, and the
// web app and the worker get GITHUB_API_URL pointing here, so E2E runs never
// reach GitHub. It serves the requests @startup/github makes: the repository,
// the branch head, the recursive tree, one file's contents, and the tarball.
// The repositories are in `github-fixtures.ts`. See docs/architecture/testing.md.
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";

import { COMMIT, findFixture, OWNER, type Fixture } from "./github-fixtures.ts";

const PORT = 9998;
const BRANCH = "main";

// `turns-private-*` repositories already looked up once.
const lookedUp = new Set<string>();

function send(response: ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body ?? {}));
}

function bytes(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
}

function directories(fixture: Fixture): string[] {
  const found = new Set<string>();
  for (const path of Object.keys(fixture.files)) {
    const parts = path.split("/");
    for (let end = 1; end < parts.length; end += 1) found.add(parts.slice(0, end).join("/"));
  }
  return [...found].sort();
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://stub");

  // Playwright waits for this before it starts the tests.
  if (url.pathname === "/") return send(response, 200);

  const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if (request.method !== "GET" || !match) return send(response, 404, { message: "Not Found" });

  const [owner, name, rest = ""] = match.slice(1).map((part) => (part === undefined ? part : decodeURIComponent(part)));
  const fixture = owner?.toLowerCase() === OWNER ? findFixture(name ?? "") : undefined;
  if (!fixture) return send(response, 404, { message: "Not Found" });

  if (rest === "") {
    let isPrivate = fixture.private ?? false;
    if (fixture.turnsPrivate) {
      isPrivate = lookedUp.has(fixture.name);
      lookedUp.add(fixture.name);
    }
    return send(response, 200, {
      name: fixture.name,
      owner: { login: OWNER },
      description: fixture.description,
      default_branch: BRANCH,
      private: isPrivate,
      visibility: isPrivate ? "private" : "public",
    });
  }

  if (rest === `git/ref/heads/${BRANCH}`) {
    if (fixture.empty) return send(response, 409, { message: "Git Repository is empty." });
    return send(response, 200, { ref: `refs/heads/${BRANCH}`, object: { sha: COMMIT, type: "commit" } });
  }

  if (rest === `git/trees/${COMMIT}` && url.searchParams.get("recursive") === "1") {
    if (fixture.listingDelayMs) await delay(fixture.listingDelayMs);
    const tree = [
      ...directories(fixture).map((path) => ({ path, mode: "040000", type: "tree" })),
      ...Object.entries(fixture.files).map(([path, content]) => ({
        path,
        mode: "100644",
        type: "blob",
        size: bytes(content).length,
      })),
    ];
    return send(response, 200, { sha: COMMIT, truncated: fixture.truncated ?? false, tree });
  }

  if (rest.startsWith("contents/") && url.searchParams.get("ref") === COMMIT) {
    const content = fixture.files[rest.slice("contents/".length)];
    if (content === undefined) return send(response, 404, { message: "Not Found" });
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes(content));
    return;
  }

  if (rest === `tarball/${COMMIT}`) {
    const top = `${OWNER}-${fixture.name}-${COMMIT.slice(0, 7)}`;
    response.writeHead(200, { "content-type": "application/x-gzip" }).end(tarball(top, fixture));
    return;
  }

  send(response, 404, { message: "Not Found" });
}).listen(PORT, "127.0.0.1");

// A gzipped ustar archive shaped like GitHub's: every path under one
// top-level directory. Fixture paths are short, so every name fits the
// 100-byte name field.
function tarball(top: string, fixture: Fixture): Buffer {
  const blocks: Buffer[] = [header(`${top}/`, 0, "5")];

  for (const [path, content] of Object.entries(fixture.files)) {
    const data = bytes(content);
    blocks.push(header(`${top}/${path}`, data.length, "0"), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));

  return gzipSync(Buffer.concat(blocks));
}

function header(name: string, size: number, type: "0" | "5"): Buffer {
  const block = Buffer.alloc(512);
  const field = (offset: number, length: number, value: string) => block.write(value, offset, length, "utf8");
  const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, "0")}\0`;

  if (Buffer.byteLength(name) > 100) throw new Error("Fixture path too long for the stub's archive.");
  field(0, 100, name);
  field(100, 8, octal(type === "5" ? 0o755 : 0o644, 8));
  field(108, 8, octal(0, 8));
  field(116, 8, octal(0, 8));
  field(124, 12, octal(size, 12));
  field(136, 12, octal(0, 12));
  field(148, 8, " ".repeat(8));
  field(156, 1, type);
  field(257, 6, "ustar\0");
  field(263, 2, "00");

  let sum = 0;
  for (const byte of block) sum += byte;
  field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);

  return block;
}
