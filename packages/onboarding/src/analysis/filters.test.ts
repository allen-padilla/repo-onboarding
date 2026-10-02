import { describe, expect, it } from "vitest";

import type { TreeEntry } from "@startup/github";

import { MAX_FILE_BYTES } from "../limits";
import { contentDropReason, dropReason, filterListing } from "./filters";
import { compilePattern, parseGitAttributes } from "./gitattributes";

const file = (path: string, size = 1_000): TreeEntry => ({ path, type: "file", size });

describe("dropReason", () => {
  it.each([
    ["pnpm-lock.yaml", "lockfile"],
    ["package-lock.json", "lockfile"],
    ["yarn.lock", "lockfile"],
    ["Cargo.lock", "lockfile"],
    ["poetry.lock", "lockfile"],
    ["Gemfile.lock", "lockfile"],
    ["composer.lock", "lockfile"],
    ["go.sum", "lockfile"],
    ["services/api/bun.lockb", "lockfile"],
    ["dist/index.js", "generated"],
    ["packages/ui/build/main.css", "generated"],
    ["apps/web/.next/server/page.js", "generated"],
    ["public/vendor.min.js", "generated"],
    ["static/site.min.css", "generated"],
    ["src/index.js.map", "generated"],
    ["api/user.pb.go", "generated"],
    ["proto/user_pb2.py", "generated"],
    ["proto/user_pb2_grpc.py", "generated"],
    ["web/gen/user_pb.js", "generated"],
    ["web/gen/user_grpc_pb.d.ts", "generated"],
    ["assets/logo.png", "binary"],
    ["assets/icon.SVG", "binary"],
    ["fonts/Inter.woff2", "binary"],
    ["media/intro.mp4", "binary"],
    ["release/app.zip", "binary"],
    ["lib/native.so", "binary"],
    ["bin/tool.exe", "binary"],
    ["vendor/github.com/pkg/errors/errors.go", "vendored"],
    ["src/third_party/zlib/inflate.c", "vendored"],
    ["frontend/node_modules/react/index.js", "vendored"],
  ])("drops %s as %s", (path, reason) => {
    expect(dropReason(file(path))).toBe(reason);
  });

  it("drops files over the size limit", () => {
    expect(dropReason(file("src/big.ts", MAX_FILE_BYTES + 1))).toBe("too_large");
    expect(dropReason(file("src/fits.ts", MAX_FILE_BYTES))).toBeNull();
  });

  it("drops paths too long to link", () => {
    expect(dropReason(file(`src/${"a".repeat(1_100)}.ts`))).toBe("long_path");
  });

  it("drops symbolic links and submodules", () => {
    expect(dropReason({ path: "docs/link", type: "symlink", size: undefined })).toBe("symlink");
    expect(dropReason({ path: "external/lib", type: "submodule", size: undefined })).toBe("submodule");
  });

  it.each([
    "src/index.ts",
    "README.md",
    "package.json",
    ".github/workflows/ci.yml",
    "src/build.ts",
    "src/distance.ts",
    "docs/vendoring.md",
    "src/map.ts",
  ])("keeps %s", (path) => {
    expect(dropReason(file(path))).toBeNull();
  });

  it("drops paths marked linguist-generated or linguist-vendored", () => {
    const linguist = parseGitAttributes(
      ["gen/** linguist-generated", "*.snap linguist-generated=true", "external/** linguist-vendored"].join("\n"),
    );

    expect(dropReason(file("gen/api/client.ts"), linguist)).toBe("generated");
    expect(dropReason(file("src/__snapshots__/app.test.ts.snap"), linguist)).toBe("generated");
    expect(dropReason(file("external/lib/a.c"), linguist)).toBe("vendored");
    expect(dropReason(file("src/gen/client.ts"), linguist)).toBeNull();
  });
});

describe("filterListing", () => {
  it("counts files, symbolic links, and submodules, but not directories", () => {
    const listing = filterListing(
      [
        { path: "src", type: "directory", size: undefined },
        file("src/index.ts"),
        file("pnpm-lock.yaml"),
        { path: "link", type: "symlink", size: undefined },
        { path: "lib", type: "submodule", size: undefined },
      ],
      null,
    );

    expect(listing.listed).toBe(4);
    expect(listing.kept).toEqual([{ path: "src/index.ts", size: 1_000 }]);
  });

  it("applies the root .gitattributes", () => {
    const listing = filterListing([file("src/index.ts"), file("src/schema.graphql.ts")], "*.graphql.ts linguist-generated\n");

    expect(listing.kept.map((kept) => kept.path)).toEqual(["src/index.ts"]);
  });
});

describe("parseGitAttributes", () => {
  it("lets the last matching line decide, including unset and unspecified", () => {
    const linguist = parseGitAttributes(
      [
        "# comment",
        "",
        "gen/** linguist-generated",
        "gen/keep/** -linguist-generated",
        "gen/maybe/** !linguist-generated",
        "gen/off/** linguist-generated=false",
        "docs/** linguist-documentation",
      ].join("\r\n"),
    );

    expect(linguist("gen/a.ts")).toEqual({ generated: true, vendored: false });
    expect(linguist("gen/keep/a.ts").generated).toBe(false);
    expect(linguist("gen/maybe/a.ts").generated).toBe(false);
    expect(linguist("gen/off/a.ts").generated).toBe(false);
    expect(linguist("docs/a.md")).toEqual({ generated: false, vendored: false });
  });

  it("ignores negative patterns, macros, quoted patterns, and other values", () => {
    const linguist = parseGitAttributes(
      ["!*.ts linguist-generated", "[attr]gen linguist-generated", '"a b.ts" linguist-generated', "*.js linguist-generated=maybe"].join("\n"),
    );

    expect(linguist("a.ts").generated).toBe(false);
    expect(linguist("a b.ts").generated).toBe(false);
    expect(linguist("a.js").generated).toBe(false);
  });
});

describe("compilePattern", () => {
  const matches = (pattern: string, path: string) => compilePattern(pattern)?.test(path) ?? false;

  it("matches a pattern without a slash against the file name at any depth", () => {
    expect(matches("*.js", "a.js")).toBe(true);
    expect(matches("*.js", "src/deep/a.js")).toBe(true);
    expect(matches("*.js", "src/.eslintrc.js")).toBe(true);
    expect(matches("*.js", "a.jsx")).toBe(false);
    expect(matches("schema.ts", "src/schema.ts")).toBe(true);
  });

  it("anchors a pattern with a slash to the repository root", () => {
    expect(matches("src/*.ts", "src/a.ts")).toBe(true);
    expect(matches("src/*.ts", "src/deep/a.ts")).toBe(false);
    expect(matches("src/*.ts", "lib/src/a.ts")).toBe(false);
    expect(matches("/a.ts", "a.ts")).toBe(true);
    expect(matches("/a.ts", "src/a.ts")).toBe(false);
  });

  it("handles **", () => {
    expect(matches("gen/**", "gen/a/b.ts")).toBe(true);
    expect(matches("gen/**", "src/gen/a.ts")).toBe(false);
    expect(matches("**/gen/*.ts", "gen/a.ts")).toBe(true);
    expect(matches("**/gen/*.ts", "x/y/gen/a.ts")).toBe(true);
    expect(matches("a/**/b.ts", "a/b.ts")).toBe(true);
    expect(matches("a/**/b.ts", "a/x/y/b.ts")).toBe(true);
    expect(matches("a/**/b.ts", "ab.ts")).toBe(false);
  });

  it("handles ?, character classes, and escapes", () => {
    expect(matches("file?.ts", "file1.ts")).toBe(true);
    expect(matches("src?a.ts", "src/a.ts")).toBe(false);
    expect(matches("[ab].ts", "a.ts")).toBe(true);
    expect(matches("[!ab].ts", "c.ts")).toBe(true);
    expect(matches("[!ab].ts", "a.ts")).toBe(false);
    expect(matches("[a-c]x.ts", "bx.ts")).toBe(true);
    expect(matches("\\#notes.md", "#notes.md")).toBe(true);
    expect(matches("a\\*.ts", "a*.ts")).toBe(true);
    expect(matches("a\\*.ts", "ab.ts")).toBe(false);
    expect(matches("a.ts", "aXts")).toBe(false);
  });

  it("never matches files with a directory-only pattern", () => {
    expect(compilePattern("vendor/")).toBeNull();
  });
});

describe("contentDropReason", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("drops files that are not text", () => {
    expect(contentDropReason(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe("binary");
  });

  it.each([
    "// Code generated by protoc-gen-go. DO NOT EDIT.\npackage api\n",
    "/* @generated */\nexport {};\n",
    "# This file is automatically generated by a tool.\n",
    "<?php\n// This file was generated by the build.\n",
    "#!/usr/bin/env node\n\n\n\n// auto-generated\n",
  ])("drops files whose first lines say they are generated", (text) => {
    expect(contentDropReason(bytes(text))).toBe("generated");
  });

  it("keeps ordinary text, and generated markers past the first lines", () => {
    expect(contentDropReason(bytes("export const a = 1;\n"))).toBeNull();
    expect(contentDropReason(bytes("1\n2\n3\n4\n5\n6\n// DO NOT EDIT\n"))).toBeNull();
  });
});
