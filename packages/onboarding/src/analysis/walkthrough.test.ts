import { describe, expect, it } from "vitest";

import {
  GenerationInvalidOutputError,
  GenerationProviderError,
  GenerationRefusalError,
  type GenerateObjectRequest,
  type GenerationClient,
} from "@startup/generation";

import { OUTLINE_PATH_LIMIT, WRITER_FILE_BYTES, WRITER_FILE_LIMIT, WRITER_TOTAL_BYTES } from "../limits";
import { walkthroughDocumentSchema } from "../walkthrough-document";
import { AnalysisFailure } from "./errors";
import type { RankedFile } from "./scoring";
import {
  paragraph,
  resolveWalkthrough,
  writerContent,
  writerOutputSchema,
  writeWalkthrough,
  WRITER_SYSTEM_PROMPT,
  type WriterInput,
  type WriterOutput,
} from "./walkthrough";

const MINUTE = 60_000;

const kept = [
  "README.md",
  "package.json",
  "src/index.ts",
  "src/server/routes.ts",
  "src/my file #1.ts",
  "test/routes.test.ts",
].map((path) => ({ path, size: 1_000 }));

const ranked: RankedFile[] = kept.map((file, index) => ({
  ...file,
  role: index === 2 ? "entry_point" : "domain_logic",
  score: 4 - index * 0.5,
  localScore: 2,
  scoredBy: "decision",
}));

const paths = {
  files: new Set(kept.map((file) => file.path)),
  directories: new Set(["src", "src/server", "test"]),
};

const input: WriterInput = {
  repository: { owner: "acme", name: "widget", description: "A widget server." },
  kept,
  ranked,
  contents: new Map(kept.map((file) => [file.path, `contents of ${file.path}`])),
};

const output: WriterOutput = {
  summary: ["`acme/widget` serves widgets. Start with `src/index.ts`."],
  directories: [
    { path: "src", description: "Application code." },
    { path: "src/server/", description: "Routes, in `src/server/routes.ts`." },
    { path: "lib", description: "Not in the analysis." },
  ],
  keyFiles: [
    { path: "src/index.ts", why: "Starts the server with `createServer()`." },
    { path: "src/missing.ts", why: "Not in the analysis." },
    { path: "src/index.ts", why: "Listed twice." },
  ],
  readingOrder: [
    { path: "README.md", reason: "Overview." },
    { path: "../etc/passwd", reason: "Not a path." },
  ],
};

describe("paragraph", () => {
  it("links backticked files and directories that are in the analysis", () => {
    expect(paragraph("See `src/index.ts`, `src/server/`, and `test`.", paths)).toEqual([
      { type: "text", text: "See " },
      { type: "path", kind: "file", path: "src/index.ts", text: "src/index.ts" },
      { type: "text", text: ", " },
      { type: "path", kind: "directory", path: "src/server", text: "src/server/" },
      { type: "text", text: ", and " },
      { type: "path", kind: "directory", path: "test", text: "test" },
      { type: "text", text: "." },
    ]);
  });

  it("links names with spaces and #", () => {
    expect(paragraph("`src/my file #1.ts`", paths)).toEqual([
      { type: "path", kind: "file", path: "src/my file #1.ts", text: "src/my file #1.ts" },
    ]);
  });

  it("keeps unknown names as inline code, never links", () => {
    expect(paragraph("Run `pnpm dev` or open `src/missing.ts` or `./src/index.ts`.", paths)).toEqual([
      { type: "text", text: "Run " },
      { type: "code", text: "pnpm dev" },
      { type: "text", text: " or open " },
      { type: "code", text: "src/missing.ts" },
      { type: "text", text: " or " },
      { type: "code", text: "./src/index.ts" },
      { type: "text", text: "." },
    ]);
  });

  it("shows long backtick spans as plain text", () => {
    const long = "x".repeat(81);
    expect(paragraph(`Before \`${long}\` after`, paths)).toEqual([{ type: "text", text: `Before ${long} after` }]);
  });

  it("keeps an unmatched backtick as text", () => {
    expect(paragraph("a `b` c `d", paths)).toEqual([
      { type: "text", text: "a " },
      { type: "code", text: "b" },
      { type: "text", text: " c `d" },
    ]);
  });

  it("passes markup through only as text", () => {
    const segments = paragraph('<img src=x onerror="alert(1)"> [link](https://evil.example) `<script>`', paths);

    expect(segments).toEqual([
      { type: "text", text: '<img src=x onerror="alert(1)"> [link](https://evil.example) ' },
      { type: "code", text: "<script>" },
    ]);
  });
});

describe("resolveWalkthrough", () => {
  it("drops unknown and repeated paths from key files and the reading order", () => {
    const document = resolveWalkthrough(output, paths, ranked)!;

    expect(document.keyFiles).toEqual([
      {
        path: "src/index.ts",
        role: "entry_point",
        why: [
          { type: "text", text: "Starts the server with " },
          { type: "code", text: "createServer()" },
          { type: "text", text: "." },
        ],
      },
    ]);
    expect(document.readingOrder).toEqual([{ path: "README.md", note: [{ type: "text", text: "Overview." }] }]);
    expect(walkthroughDocumentSchema.parse(document)).toEqual(document);
  });

  it("links directory headings in the analysis and shows others as text", () => {
    const document = resolveWalkthrough(output, paths, ranked)!;

    expect(document.directories.map((entry) => entry.heading)).toEqual([
      { type: "path", kind: "directory", path: "src", text: "src/" },
      { type: "path", kind: "directory", path: "src/server", text: "src/server/" },
      { type: "text", text: "lib" },
    ]);
  });

  it("gives an unscored key file its path-rule role", () => {
    const document = resolveWalkthrough(
      { ...output, keyFiles: [{ path: "test/routes.test.ts", why: "Tests." }] },
      paths,
      ranked.slice(0, 2),
    )!;

    expect(document.keyFiles[0]!.role).toBe("test");
  });

  it("stays a valid document when prose is full of backtick spans", () => {
    const dense = "`a`".repeat(400);
    expect(writerOutputSchema.safeParse({ ...output, summary: [dense] }).success).toBe(true);

    const document = resolveWalkthrough({ ...output, summary: [dense, "`src/index.ts`".repeat(85)] }, paths, ranked);

    expect(document).not.toBeNull();
    expect(walkthroughDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("is null when no key file or reading-order entry is in the analysis", () => {
    expect(resolveWalkthrough({ ...output, keyFiles: [{ path: "nope.ts", why: "x" }] }, paths, ranked)).toBeNull();
    expect(resolveWalkthrough({ ...output, readingOrder: [{ path: "nope.ts", reason: "x" }] }, paths, ranked)).toBeNull();
  });
});

describe("writerOutputSchema", () => {
  it.each([
    ["a line break", "First line.\nSecond line."],
    ["a carriage return", "First line.\rSecond line."],
    ["a code fence", "Like this: ```const a = 1```"],
  ])("rejects prose with %s", (_, text) => {
    expect(writerOutputSchema.safeParse({ ...output, summary: [text] }).success).toBe(false);
  });

  it("rejects a path field over several lines", () => {
    const directories = [{ path: "x\nconst a = 1;\nconst b = 2;", description: "Code." }];
    expect(writerOutputSchema.safeParse({ ...output, directories }).success).toBe(false);
  });

  it("requires all four sections", () => {
    expect(writerOutputSchema.safeParse({ ...output, keyFiles: [] }).success).toBe(false);
    expect(writerOutputSchema.safeParse({ ...output, readingOrder: undefined }).success).toBe(false);
    expect(writerOutputSchema.safeParse(output).success).toBe(true);
  });

  it("bounds the number of key files", () => {
    const keyFiles = Array.from({ length: 16 }, () => ({ path: "src/index.ts", why: "x" }));
    expect(writerOutputSchema.safeParse({ ...output, keyFiles }).success).toBe(false);
  });
});

describe("writerContent", () => {
  it("sends repository text as JSON data", () => {
    const content = JSON.parse(writerContent(input));

    expect(content).toMatchObject({
      repository: "acme/widget",
      description: "A widget server.",
      outline: { shown: 6, total: 6 },
    });
    expect(content.files[0]).toEqual({
      path: "README.md",
      role: "domain_logic",
      importance: 4,
      truncated: false,
      content: "contents of README.md",
    });
  });

  it("sends at most 30 files, 30 KB each and 300 KB in total, and 2,000 outline paths", () => {
    const many = Array.from({ length: 2_500 }, (_, index) => ({ path: `src/f${index}.ts`, size: 1 }));
    const content = JSON.parse(
      writerContent({
        repository: input.repository,
        kept: many,
        ranked: many.slice(0, 40).map((file) => ({ ...file, role: "domain_logic", score: 2, localScore: 2, scoredBy: "local" })),
        contents: new Map(many.slice(0, 40).map((file) => [file.path, "a".repeat(40 * 1024)])),
      }),
    );

    expect(content.outline.files).toHaveLength(OUTLINE_PATH_LIMIT);
    expect(content.outline.total).toBe(2_500);
    expect(content.files.length).toBeLessThanOrEqual(WRITER_FILE_LIMIT);
    const sizes = content.files.map((file: { content: string }) => file.content.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(WRITER_FILE_BYTES);
    expect(sizes.reduce((a: number, b: number) => a + b, 0)).toBeLessThanOrEqual(WRITER_TOTAL_BYTES);
    expect(content.files[0].truncated).toBe(true);
  });
});

describe("writeWalkthrough", () => {
  /** A generation client that answers each request from `replies` in turn. */
  function fakeGeneration(replies: (WriterOutput | Error | ((request: GenerateObjectRequest<unknown>) => Promise<never>))[]) {
    const requests: GenerateObjectRequest<unknown>[] = [];
    const client: Pick<GenerationClient, "generateObject"> = {
      async generateObject<T>(request: GenerateObjectRequest<T>) {
        requests.push(request as GenerateObjectRequest<unknown>);
        const reply = replies[requests.length - 1];
        if (!reply) throw new Error("no reply");
        if (typeof reply === "function") return reply(request as GenerateObjectRequest<unknown>);
        if (reply instanceof Error) throw reply;
        return { output: reply as T, model: "claude-test", fellBack: false, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    return { requests, client };
  }

  const options = (generation: Pick<GenerationClient, "generateObject">, remaining = 10 * MINUTE) => ({
    generation,
    signal: new AbortController().signal,
    deadline: remaining,
    now: () => 0,
  });

  it("writes the walkthrough with the product prompt and effort high", async () => {
    const generation = fakeGeneration([output]);

    const document = await writeWalkthrough(input, options(generation.client));

    expect(document.kind).toBe("written");
    expect(generation.requests[0]).toMatchObject({ system: WRITER_SYSTEM_PROMPT, effort: "high", schema: writerOutputSchema });
    expect(generation.requests[0]!.content).toBe(writerContent(input));
  });

  it("asks once more after invalid output", async () => {
    const generation = fakeGeneration([new GenerationInvalidOutputError("schema"), output]);

    await expect(writeWalkthrough(input, options(generation.client))).resolves.toMatchObject({ kind: "written" });
    expect(generation.requests).toHaveLength(2);
  });

  it("asks once more when no key file is in the analysis", async () => {
    const generation = fakeGeneration([{ ...output, keyFiles: [{ path: "nope.ts", why: "x" }] }, output]);

    await expect(writeWalkthrough(input, options(generation.client))).resolves.toMatchObject({ kind: "written" });
    expect(generation.requests).toHaveLength(2);
  });

  it("fails after a second invalid output", async () => {
    const generation = fakeGeneration([new GenerationInvalidOutputError("max_tokens"), new GenerationInvalidOutputError("schema")]);

    await expect(writeWalkthrough(input, options(generation.client))).rejects.toEqual(new AnalysisFailure("writer_failed"));
    expect(generation.requests).toHaveLength(2);
  });

  it("does not ask again with less than 3 minutes left", async () => {
    const generation = fakeGeneration([new GenerationInvalidOutputError("schema"), output]);

    await expect(writeWalkthrough(input, options(generation.client, 2.5 * MINUTE))).rejects.toMatchObject({ reason: "writer_failed" });
    expect(generation.requests).toHaveLength(1);
  });

  it.each([
    ["a refusal", new GenerationRefusalError("cyber")],
    ["a provider error", new GenerationProviderError("status", 500)],
  ])("fails without asking again after %s", async (_, error) => {
    const generation = fakeGeneration([error, output]);

    await expect(writeWalkthrough(input, options(generation.client))).rejects.toMatchObject({ reason: "writer_failed" });
    expect(generation.requests).toHaveLength(1);
  });

  it("fails as timed out when the writer's time runs out", async () => {
    const generation = fakeGeneration([
      (request) =>
        new Promise<never>((_, reject) => {
          request.signal!.addEventListener("abort", () => reject(request.signal!.reason));
        }),
    ]);

    const started = Date.now();
    await expect(writeWalkthrough(input, options(generation.client, MINUTE + 50))).rejects.toMatchObject({ reason: "timed_out" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("fails at once as timed out when no time is left for the writer", async () => {
    const generation = fakeGeneration([output]);

    await expect(writeWalkthrough(input, options(generation.client, MINUTE))).rejects.toMatchObject({ reason: "timed_out" });
    expect(generation.requests).toHaveLength(0);
  });

  it("rejects with the analysis signal's reason", async () => {
    const controller = new AbortController();
    const generation = fakeGeneration([
      () => {
        controller.abort(new Error("shutdown"));
        return Promise.reject(controller.signal.reason);
      },
    ]);

    await expect(
      writeWalkthrough(input, { ...options(generation.client), signal: controller.signal }),
    ).rejects.toThrow("shutdown");
  });
});
