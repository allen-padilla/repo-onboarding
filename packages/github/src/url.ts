// The rule for repository URLs that users submit. The result is only an owner
// and a name: the URL itself is never fetched.
//
// Browser-safe: this module has no imports.

export interface RepositoryName {
  readonly owner: string;
  readonly name: string;
}

const HOSTS = new Set(["github.com", "www.github.com"]);

// GitHub account names: letters, digits, and hyphens, not starting with a
// hyphen, at most 39 characters. Some older accounts end with a hyphen or have
// two in a row, so those are allowed.
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

// Repository names: letters, digits, `.`, `_`, and `-`, at most 100
// characters, and never `.` or `..`.
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Returns the owner and repository name from a GitHub repository URL, or
 * `null` when `input` is not one.
 *
 * Accepts `https://github.com/<owner>/<repo>` with or without the scheme or
 * `www.`, with a trailing slash, a `.git` suffix, or a path after the name,
 * such as `/tree/main/src`, which is ignored. The query and fragment are
 * ignored too.
 */
export function parseRepositoryUrl(input: string): RepositoryName | null {
  const text = input.trim();
  if (text === "" || /\s/.test(text)) return null;

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!HOSTS.has(url.hostname) || url.port !== "") return null;
  if (url.username !== "" || url.password !== "") return null;

  const [owner, repository] = url.pathname.split("/").filter((segment) => segment !== "");
  if (owner === undefined || repository === undefined) return null;

  const name = repository.toLowerCase().endsWith(".git") ? repository.slice(0, -4) : repository;

  if (!OWNER.test(owner)) return null;
  if (!NAME.test(name) || name === "." || name === "..") return null;

  return { owner, name };
}
