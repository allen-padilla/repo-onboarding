import {
  GitHubNotFoundError,
  GitHubRepositoryTooLargeError,
  type GitHubClient,
  type TreeEntry,
} from "@startup/github";

// A GitHub client for tests that serves fixture repositories from memory.

/** Every fixture file contains this, so tests can check it is never stored. */
export const FIXTURE_MARKER = "fixture-content-5d0c2a";

export const FIXTURE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

export interface FakeRepository {
  readonly owner: string;
  readonly name: string;
  readonly description?: string | null;
  readonly commit?: string;
  private?: boolean;
  /** Path to contents. Strings get the marker appended. */
  readonly files: Readonly<Record<string, string | Uint8Array>>;
  /** Extra listing entries, such as symbolic links and submodules. */
  readonly entries?: readonly TreeEntry[];
  /** GitHub cannot list every file. */
  readonly truncated?: boolean;
}

type Method = keyof GitHubClient;

/** A file with the fixture marker. */
export function fixtureText(text: string): string {
  return `${text}\n// ${FIXTURE_MARKER}\n`;
}

export function fakeGitHub(repositories: readonly FakeRepository[]) {
  const byName = new Map(repositories.map((repository) => [key(repository.owner, repository.name), repository]));
  const calls: string[] = [];
  const failures = new Map<Method, Error[]>();
  let gate: ((method: Method, signal: AbortSignal | undefined, repository: string) => Promise<void>) | undefined;

  function find(owner: string, name: string): FakeRepository {
    const repository = byName.get(key(owner, name));
    if (!repository || repository.private) throw new GitHubNotFoundError();
    return repository;
  }

  async function enter(method: Method, owner: string, name: string, signal: AbortSignal | undefined) {
    calls.push(`${method} ${owner}/${name}`);
    signal?.throwIfAborted();
    const failure = failures.get(method)?.shift();
    if (failure) throw failure;
    if (gate) await gate(method, signal, key(owner, name));
    signal?.throwIfAborted();
  }

  function contents(repository: FakeRepository, path: string): Uint8Array | undefined {
    const value = repository.files[path];
    if (value === undefined) return undefined;
    return typeof value === "string" ? new TextEncoder().encode(fixtureText(value)) : value;
  }

  const client: GitHubClient = {
    async getRepository(owner, name, { signal } = {}) {
      await enter("getRepository", owner, name, signal);
      const repository = find(owner, name);
      return {
        owner: repository.owner,
        name: repository.name,
        description: repository.description ?? null,
        defaultBranch: "main",
      };
    },

    async getBranchHead(owner, name, _branch, { signal } = {}) {
      await enter("getBranchHead", owner, name, signal);
      return find(owner, name).commit ?? FIXTURE_COMMIT;
    },

    async getTree(owner, name, _commit, { signal } = {}) {
      await enter("getTree", owner, name, signal);
      const repository = find(owner, name);
      if (repository.truncated) throw new GitHubRepositoryTooLargeError("listing_truncated");

      const directories = new Set<string>();
      const files: TreeEntry[] = Object.keys(repository.files).map((path) => {
        const segments = path.split("/");
        for (let length = 1; length < segments.length; length += 1) directories.add(segments.slice(0, length).join("/"));
        return { path, type: "file", size: contents(repository, path)!.byteLength };
      });
      const listed: TreeEntry[] = Array.from(directories, (path) => ({ path, type: "directory", size: undefined }));
      return [...listed, ...files, ...(repository.entries ?? [])];
    },

    async readFile(owner, name, _commit, path, { maxBytes, signal }) {
      await enter("readFile", owner, name, signal);
      const bytes = contents(find(owner, name), path);
      return bytes && bytes.byteLength <= maxBytes ? new TextDecoder().decode(bytes) : null;
    },

    async readFiles(owner, name, _commit, paths, { maxFileBytes, signal }) {
      await enter("readFiles", owner, name, signal);
      const repository = find(owner, name);
      const files = new Map<string, Uint8Array>();
      for (const path of Array.from(paths)) {
        const bytes = contents(repository, path);
        if (bytes && bytes.byteLength <= maxFileBytes) files.set(path, bytes);
      }
      return files;
    },
  };

  return {
    client,
    /** `method owner/name` for every call, in order. */
    calls,
    repositories: byName,
    /** The next calls to `method` raise these errors, one each. */
    fail(method: Method, ...errors: Error[]) {
      failures.set(method, [...(failures.get(method) ?? []), ...errors]);
    },
    /** Runs before every call, after its failures. Hold a call by returning a promise. */
    setGate(next: typeof gate) {
      gate = next;
    },
  };
}

function key(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}
