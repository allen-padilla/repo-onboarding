import { z } from "zod";

import { serverEnv } from "@startup/env";

import { readArchive } from "./archive";
import {
  GitHubEmptyRepositoryError,
  GitHubError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubRepositoryTooLargeError,
  GitHubUnavailableError,
} from "./errors";

const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const API_VERSION = "2022-11-28";
const USER_AGENT = "startup-github";

// GitHub serves archives from here. Redirects to any other host are refused.
const CODELOAD_ORIGIN = "https://codeload.github.com";
const MAX_REDIRECTS = 3;

// Secondary rate limits may come without a reset time. GitHub asks clients to
// wait at least a minute.
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

export interface GitHubClientOptions {
  /** Raises rate limits. Defaults to `GITHUB_API_TOKEN`. Sent to the API origin only. */
  token?: string;
  /** Defaults to `GITHUB_API_URL`, then `https://api.github.com`. */
  apiUrl?: string;
  /** Per request for everything but archives. Default 10 seconds. */
  timeoutMs?: number;
  /** HTTP transport. Defaults to the global `fetch`; tests inject a fake. */
  fetch?: typeof fetch;
}

export interface Repository {
  /** Canonical case, as GitHub returns it. */
  readonly owner: string;
  readonly name: string;
  readonly description: string | null;
  readonly defaultBranch: string;
}

export type TreeEntryType = "file" | "directory" | "symlink" | "submodule";

export interface TreeEntry {
  readonly path: string;
  readonly type: TreeEntryType;
  /** Bytes. Files only. */
  readonly size: number | undefined;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ReadFilesOptions extends RequestOptions {
  /** Compressed bytes to download before giving up. */
  maxDownloadBytes: number;
  /** Files larger than this are left out. */
  maxFileBytes: number;
  /** For the whole download. Default 2 minutes. */
  timeoutMs?: number;
}

export interface GitHubClient {
  /** A public repository. Raises `GitHubNotFoundError` when it is missing or not public. */
  getRepository(owner: string, name: string, options?: RequestOptions): Promise<Repository>;
  /** The latest commit on `branch`. Raises `GitHubEmptyRepositoryError` for a repository with no commits. */
  getBranchHead(owner: string, name: string, branch: string, options?: RequestOptions): Promise<string>;
  /** Every entry at `commit`. Raises `GitHubRepositoryTooLargeError` when GitHub cannot list them all. */
  getTree(owner: string, name: string, commit: string, options?: RequestOptions): Promise<TreeEntry[]>;
  /** One file's text at `commit`, or `null` when it is missing or larger than `maxBytes`. */
  readFile(
    owner: string,
    name: string,
    commit: string,
    path: string,
    options: RequestOptions & { maxBytes: number },
  ): Promise<string | null>;
  /** The requested files at `commit`, read from the repository's archive. */
  readFiles(
    owner: string,
    name: string,
    commit: string,
    paths: Iterable<string>,
    options: ReadFilesOptions,
  ): Promise<Map<string, Uint8Array>>;
}

const repositorySchema = z.object({
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
  description: z.string().nullable(),
  default_branch: z.string().min(1),
  private: z.boolean(),
  visibility: z.string().optional(),
});

const refSchema = z.object({
  object: z.object({ sha: z.string().regex(/^[0-9a-f]{40,64}$/) }),
});

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string().min(1),
      mode: z.string(),
      type: z.string(),
      size: z.number().int().nonnegative().optional(),
    }),
  ),
});

/**
 * Creates a server-only client for public GitHub repositories. Repository
 * owners, names, and paths are always encoded into URLs the client builds;
 * no URL from a user is ever fetched. Failed requests are not retried.
 */
export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const apiUrl = new URL(options.apiUrl ?? serverEnv.GITHUB_API_URL ?? DEFAULT_API_URL);
  const apiBase = apiUrl.href.replace(/\/$/, "");
  const token = options.token ?? serverEnv.GITHUB_API_TOKEN;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = options.fetch ?? globalThis.fetch;

  function headersFor(target: URL, accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": API_VERSION,
    };
    if (token && target.origin === apiUrl.origin) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async function request(
    path: string,
    accept: string,
    { signal, timeout }: { signal: AbortSignal | undefined; timeout: number },
  ): Promise<{ response: Response; aborted: () => never | void }> {
    const timer = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([timer, signal]) : timer;
    const aborted = () => {
      if (timer.aborted) throw new GitHubUnavailableError("timeout");
      if (signal?.aborted) throw signal.reason;
    };

    let target = new URL(`${apiBase}${path}`);
    for (let hops = 0; ; hops += 1) {
      let response: Response;
      try {
        response = await transport(target, {
          headers: headersFor(target, accept),
          redirect: "manual",
          signal: combined,
        });
      } catch {
        aborted();
        throw new GitHubUnavailableError("network");
      }

      if (response.status < 300 || response.status >= 400 || response.status === 304) {
        return { response, aborted };
      }

      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location || hops >= MAX_REDIRECTS) {
        throw new GitHubUnavailableError("redirect", response.status);
      }

      target = new URL(location, target);
      if (target.origin !== apiUrl.origin && target.origin !== CODELOAD_ORIGIN) {
        throw new GitHubUnavailableError("redirect", response.status);
      }
    }
  }

  async function json<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const { response, aborted } = await request(path, "application/vnd.github+json", {
      signal,
      timeout: timeoutMs,
    });
    if (!response.ok) throw await errorForStatus(response);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      aborted();
      throw new GitHubUnavailableError("invalid_response");
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new GitHubUnavailableError("invalid_response");
    return parsed.data;
  }

  return {
    async getRepository(owner, name, { signal } = {}) {
      const repository = await json(repositoryPath(owner, name), repositorySchema, signal);

      // A token that can read private repositories still never gets one.
      if (repository.private || (repository.visibility ?? "public") !== "public") {
        throw new GitHubNotFoundError();
      }

      return {
        owner: repository.owner.login,
        name: repository.name,
        description: repository.description,
        defaultBranch: repository.default_branch,
      };
    },

    async getBranchHead(owner, name, branch, { signal } = {}) {
      const ref = await json(
        `${repositoryPath(owner, name)}/git/ref/heads/${encodePath(branch)}`,
        refSchema,
        signal,
      );
      return ref.object.sha;
    },

    async getTree(owner, name, commit, { signal } = {}) {
      const tree = await json(
        `${repositoryPath(owner, name)}/git/trees/${encodeURIComponent(commit)}?recursive=1`,
        treeSchema,
        signal,
      );
      if (tree.truncated) throw new GitHubRepositoryTooLargeError("listing_truncated");

      return tree.tree.flatMap((entry): TreeEntry[] => {
        const type = entryType(entry.type, entry.mode);
        return type ? [{ path: entry.path, type, size: type === "file" ? entry.size : undefined }] : [];
      });
    },

    async readFile(owner, name, commit, path, { maxBytes, signal }) {
      const { response, aborted } = await request(
        `${repositoryPath(owner, name)}/contents/${encodePath(path)}?ref=${encodeURIComponent(commit)}`,
        "application/vnd.github.raw",
        { signal, timeout: timeoutMs },
      );
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.ok) throw await errorForStatus(response);

      try {
        const bytes = await readLimited(response, maxBytes);
        return bytes === null ? null : new TextDecoder().decode(bytes);
      } catch {
        aborted();
        throw new GitHubUnavailableError("network");
      }
    },

    async readFiles(owner, name, commit, paths, options) {
      const { response, aborted } = await request(
        `${repositoryPath(owner, name)}/tarball/${encodeURIComponent(commit)}`,
        "application/vnd.github+json",
        { signal: options.signal, timeout: options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS },
      );
      if (!response.ok) throw await errorForStatus(response);
      if (!response.body) throw new GitHubUnavailableError("invalid_response");

      try {
        return await readArchive(response.body, new Set(paths), options);
      } catch (error) {
        aborted();
        throw error;
      }
    },
  };
}

function repositoryPath(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function entryType(type: string, mode: string): TreeEntryType | undefined {
  if (type === "blob") return mode === "120000" ? "symlink" : "file";
  if (type === "tree") return "directory";
  if (type === "commit") return "submodule";
  return undefined;
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  return new Uint8Array(Buffer.concat(chunks));
}

async function errorForStatus(response: Response): Promise<GitHubError> {
  const { status } = response;
  const resetAt = await rateLimitReset(response);
  await response.body?.cancel().catch(() => undefined);

  if (resetAt) return new GitHubRateLimitError(resetAt);
  if (status === 401) return new GitHubUnavailableError("authentication", status);
  // 403 without a rate limit is a repository GitHub has blocked or disabled.
  if (status === 403 || status === 404 || status === 451) return new GitHubNotFoundError();
  if (status === 409) return new GitHubEmptyRepositoryError();
  return new GitHubUnavailableError("status", status);
}

// GitHub signals rate limits with 403 or 429. Primary limits set
// `x-ratelimit-remaining: 0` and a reset time; secondary limits may set
// `retry-after`, or only say so in the message, which is read and never kept.
async function rateLimitReset(response: Response): Promise<Date | undefined> {
  if (response.status !== 403 && response.status !== 429) return undefined;

  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
    return new Date(Date.now() + Number(retryAfter.trim()) * 1000);
  }

  const reset = response.headers.get("x-ratelimit-reset");
  if (response.headers.get("x-ratelimit-remaining") === "0" && reset && /^\d+$/.test(reset)) {
    return new Date(Number(reset) * 1000);
  }

  if (response.status === 429) return new Date(Date.now() + DEFAULT_RATE_LIMIT_WAIT_MS);

  const text = await response.text().catch(() => "");
  return /rate limit/i.test(text) ? new Date(Date.now() + DEFAULT_RATE_LIMIT_WAIT_MS) : undefined;
}
