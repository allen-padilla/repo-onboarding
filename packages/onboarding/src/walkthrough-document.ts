import { z } from "zod";

// The stored walkthrough: text and references to paths in the analysis, never
// file contents or markup. Pages render text segments as text and path
// segments as links built with `githubUrl`. Imports only zod, so pages can use
// it.

export const FILE_ROLES = ["entry_point", "configuration", "domain_logic", "test", "documentation"] as const;

export type FileRole = (typeof FILE_ROLES)[number];

export type PathKind = "file" | "directory";

/** Longer paths are dropped from the analysis, so every kept path fits a document. */
export const MAX_PATH_LENGTH = 1_024;

/**
 * A path relative to the repository root, as GitHub lists it: segments
 * separated by `/`, none empty, `.`, or `..`. The root directory is `""`.
 */
export function isRepositoryPath(path: string, kind: PathKind): boolean {
  if (path === "") return kind === "directory";
  if (path.length > MAX_PATH_LENGTH) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const filePath = z.string().refine((path) => isRepositoryPath(path, "file"));
const directoryPath = z.string().refine((path) => isRepositoryPath(path, "directory"));

const textSegment = z.object({ type: z.literal("text"), text: z.string().min(1).max(4_000) });
// Inline code: a function, type, or command name. Never a file's contents.
const codeSegment = z.object({ type: z.literal("code"), text: z.string().min(1).max(80) });
const fileSegment = z.object({
  type: z.literal("path"),
  kind: z.literal("file"),
  path: filePath,
  text: z.string().min(1).max(MAX_PATH_LENGTH + 1),
});
const directorySegment = z.object({
  type: z.literal("path"),
  kind: z.literal("directory"),
  path: directoryPath,
  text: z.string().min(1).max(MAX_PATH_LENGTH + 1),
});

const segmentSchema = z.union([textSegment, codeSegment, fileSegment, directorySegment]);
// Prose from the writer is at most 1,200 characters, which splits into fewer
// than 1,000 segments however many backtick spans it holds.
const paragraphSchema = z.array(segmentSchema).max(1_000);

export const walkthroughDocumentSchema = z.object({
  version: z.literal(1),
  /** `written` by the writing model, or `basic` when none is configured. */
  kind: z.enum(["written", "basic"]),
  /** What the project is. */
  summary: z.array(paragraphSchema).max(8),
  /** How it is organized: the main directories and what lives in each. */
  directories: z
    .array(z.object({ heading: z.union([textSegment, directorySegment]), description: paragraphSchema }))
    .max(40),
  /** Key files, most important first. */
  keyFiles: z
    .array(z.object({ path: filePath, role: z.enum(FILE_ROLES), why: paragraphSchema }))
    .max(15),
  /** Suggested reading order. */
  readingOrder: z.array(z.object({ path: filePath, note: paragraphSchema })).max(40),
});

export type WalkthroughDocument = z.infer<typeof walkthroughDocumentSchema>;
export type WalkthroughSegment = z.infer<typeof segmentSchema>;
export type WalkthroughParagraph = z.infer<typeof paragraphSchema>;

/** The stored walkthrough, or `null` when it is missing or not a valid document. */
export function parseWalkthroughDocument(value: unknown): WalkthroughDocument | null {
  const parsed = walkthroughDocumentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The GitHub page for `path` at `commit`: `/blob/` for a file, `/tree/` for a
 * directory. Every segment is percent-encoded, so names with spaces, `#`, `?`,
 * or non-ASCII characters open the right file, and no segment can leave the
 * repository.
 */
export function githubUrl(owner: string, name: string, commit: string, path: string, kind: PathKind): string {
  if (![owner, name].every((part) => isRepositoryPath(part, "file") && !part.includes("/"))) {
    throw new Error("Invalid repository name.");
  }
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("Invalid commit.");
  if (!isRepositoryPath(path, kind)) throw new Error("Invalid repository path.");

  const base = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const encoded = path === "" ? "" : `/${path.split("/").map(encodeURIComponent).join("/")}`;
  return `${base}/${kind === "file" ? "blob" : "tree"}/${commit}${encoded}`;
}
