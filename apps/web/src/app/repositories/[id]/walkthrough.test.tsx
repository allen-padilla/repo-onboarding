import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WalkthroughDocument } from "@startup/onboarding/walkthrough";

import { Walkthrough } from "./walkthrough";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const target = { owner: "acme", name: "widget", commit: COMMIT };

const render = (document: WalkthroughDocument) => renderToStaticMarkup(<Walkthrough document={document} target={target} />);

const empty: WalkthroughDocument = {
  version: 1,
  kind: "written",
  summary: [],
  directories: [],
  keyFiles: [],
  readingOrder: [],
};

/** Every `href` in the markup. */
const hrefs = (html: string) => Array.from(html.matchAll(/href="([^"]*)"/g), (match) => match[1]);

describe("Walkthrough", () => {
  it("renders markup from the model as text, never as HTML", () => {
    const html = render({
      ...empty,
      summary: [
        [
          { type: "text", text: '<img src=x onerror="alert(1)"><script>alert(2)</script>' },
          { type: "code", text: "<b>bold</b>" },
        ],
      ],
      directories: [{ heading: { type: "text", text: "<a href=https://evil.example>here</a>" }, description: [] }],
    });

    expect(html).not.toMatch(/<(img|script|b)\b/);
    expect(html).not.toContain("<a href=https://evil.example");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;");
    expect(html).toContain("<code");
    expect(hrefs(html)).toEqual([]);
  });

  it("links files and directories at the analyzed commit, with each segment encoded", () => {
    const html = render({
      ...empty,
      summary: [[{ type: "path", kind: "file", path: "docs/faq #1?/café.md", text: "the FAQ" }]],
      directories: [
        { heading: { type: "path", kind: "directory", path: "src", text: "src/" }, description: [] },
      ],
      keyFiles: [{ path: "src/index.ts", role: "entry_point", why: [{ type: "text", text: "Starts the server." }] }],
      readingOrder: [{ path: "src/index.ts", note: [] }],
    });

    expect(hrefs(html)).toEqual([
      `https://github.com/acme/widget/blob/${COMMIT}/docs/faq%20%231%3F/caf%C3%A9.md`,
      `https://github.com/acme/widget/tree/${COMMIT}/src`,
      `https://github.com/acme/widget/blob/${COMMIT}/src/index.ts`,
      `https://github.com/acme/widget/blob/${COMMIT}/src/index.ts`,
    ]);
    expect(html).toContain("Entry point");
    expect(html).toContain("Starts the server.");
  });

  it("shows a path that could leave the repository as text, not a link", () => {
    // The stored document's schema refuses these paths. The page does not
    // rely on that.
    const html = render({
      ...empty,
      summary: [
        [
          { type: "path", kind: "file", path: "../../other/repo/blob/main/x", text: "escape" },
          { type: "path", kind: "file", path: "https://evil.example/x", text: "absolute" },
        ],
      ],
    } as WalkthroughDocument);

    expect(hrefs(html)).toEqual([]);
    expect(html).toContain("escape");
    expect(html).toContain("absolute");
  });

  it("says when no writing model wrote the walkthrough", () => {
    expect(render({ ...empty, kind: "basic" })).toContain("No writing model is configured on this server");
    expect(render(empty)).not.toContain("No writing model");
  });
});
