import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * `GITHUB_API_TOKEN`: printable characters with no spaces, so it cannot break
 * the `Authorization` header it is sent in.
 */
export const githubApiToken = z
  .string()
  .regex(/^[\x21-\x7e]+$/, { message: "must contain no spaces or control characters" });

/**
 * `GITHUB_API_URL`: an `https://` URL, or an `http://` URL on a loopback host
 * for tests. No credentials, query, or fragment.
 */
export const githubApiUrl = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      const secure =
        url.protocol === "https:" ||
        (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));

      return (
        secure &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  },
  { message: "must be an https:// URL, or an http:// URL on a loopback host" },
);
