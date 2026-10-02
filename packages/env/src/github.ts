import { z } from "zod";

import { printableToken } from "./printable";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `GITHUB_API_TOKEN`: sent in the `Authorization` header. */
export const githubApiToken = printableToken;

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
