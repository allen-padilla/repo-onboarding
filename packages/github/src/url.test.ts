import { describe, expect, it } from "vitest";

import { parseRepositoryUrl } from "./url";

describe("parseRepositoryUrl", () => {
  it.each([
    ["https://github.com/acme/widget", "acme", "widget"],
    ["https://github.com/acme/widget/", "acme", "widget"],
    ["https://github.com/acme/widget.git", "acme", "widget"],
    ["https://github.com/acme/widget/tree/main/src", "acme", "widget"],
    ["https://github.com/acme/widget/blob/main/README.md#usage", "acme", "widget"],
    ["https://github.com/acme/widget?tab=readme-ov-file", "acme", "widget"],
    ["http://github.com/acme/widget", "acme", "widget"],
    ["https://www.github.com/acme/widget", "acme", "widget"],
    ["github.com/acme/widget", "acme", "widget"],
    ["www.github.com/acme/widget", "acme", "widget"],
    ["  https://GitHub.com/Acme/Widget  ", "Acme", "Widget"],
    ["https://github.com/acme-co/my_repo.js", "acme-co", "my_repo.js"],
    ["https://github.com/a/.github", "a", ".github"],
  ])("accepts %s", (input, owner, name) => {
    expect(parseRepositoryUrl(input)).toEqual({ owner, name });
  });

  it.each([
    ["an empty string", ""],
    ["no repository", "https://github.com/acme"],
    ["the site root", "https://github.com/"],
    ["another host", "https://gitlab.com/acme/widget"],
    ["a look-alike host", "https://github.com.example.com/acme/widget"],
    ["a subdomain", "https://gist.github.com/acme/widget"],
    ["a port", "https://github.com:8443/acme/widget"],
    ["credentials", "https://user:pass@github.com/acme/widget"],
    ["another scheme", "ftp://github.com/acme/widget"],
    ["a javascript URL", "javascript:alert(1)//github.com/acme/widget"],
    ["spaces inside", "https://github.com/acme/my widget"],
    ["an owner starting with a hyphen", "https://github.com/-acme/widget"],
    ["an owner over 39 characters", `https://github.com/${"a".repeat(40)}/widget`],
    ["an owner with an underscore", "https://github.com/ac_me/widget"],
    ["a name with other characters", "https://github.com/acme/wid%20get"],
    ["a name over 100 characters", `https://github.com/acme/${"w".repeat(101)}`],
    ["a dot name", "https://github.com/acme/."],
    ["a dot-dot name", "https://github.com/acme/.."],
    ["only .git", "https://github.com/acme/.git"],
    ["not a URL", "acme/widget"],
  ])("rejects %s", (_case, input) => {
    expect(parseRepositoryUrl(input)).toBeNull();
  });
});
