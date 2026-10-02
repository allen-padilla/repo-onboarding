import { KEY_FILE_LIMIT } from "../limits";
import type { FileRole, WalkthroughDocument } from "../walkthrough-document";
import type { KeptFile } from "./filters";
import type { RankedFile } from "./scoring";

// The walkthrough when no writing model is configured: the same four sections,
// built from the ranking alone, with no prose. The page says why.

const READING_GROUPS: readonly FileRole[] = ["documentation", "entry_point", "configuration", "domain_logic", "test"];

const DIRECTORY_LIMIT = 40;
const DESCRIPTION_LIMIT = 4_000;

export interface BasicInput {
  readonly description: string | null;
  readonly kept: readonly KeptFile[];
  /** The scored files, in rank order. */
  readonly ranked: readonly RankedFile[];
}

export function basicWalkthrough({ description, kept, ranked }: BasicInput): WalkthroughDocument {
  const text = description?.trim()
    ? description.trim().slice(0, DESCRIPTION_LIMIT)
    : "The repository has no description on GitHub.";

  // Top-level directories that hold kept files, with how many each holds.
  const counts = new Map<string, number>();
  for (const { path } of kept) {
    const slash = path.indexOf("/");
    if (slash !== -1) counts.set(path.slice(0, slash), (counts.get(path.slice(0, slash)) ?? 0) + 1);
  }
  const directories = Array.from(counts)
    .sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : 1))
    .slice(0, DIRECTORY_LIMIT)
    .map(([path, count]) => ({
      heading: { type: "path" as const, kind: "directory" as const, path, text: `${path}/` },
      description: [{ type: "text" as const, text: count === 1 ? "1 file" : `${count} files` }],
    }));

  const keyFiles = ranked.slice(0, KEY_FILE_LIMIT);

  return {
    version: 1,
    kind: "basic",
    summary: [[{ type: "text", text }]],
    directories,
    keyFiles: keyFiles.map((file) => ({ path: file.path, role: file.role, why: [] })),
    readingOrder: READING_GROUPS.flatMap((role) =>
      keyFiles.filter((file) => file.role === role).map((file) => ({ path: file.path, note: [] })),
    ),
  };
}
