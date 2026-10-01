import { gzipSync } from "node:zlib";

import { pack } from "tar-stream";

export interface ArchiveEntry {
  readonly path: string;
  readonly content?: string | Uint8Array;
  readonly type?: "file" | "directory" | "symlink";
}

/**
 * A gzipped tarball shaped like the ones GitHub serves: every path under one
 * top-level directory named after the repository and commit.
 */
export async function githubTarball(
  entries: readonly ArchiveEntry[],
  top = "acme-widget-0123abc",
): Promise<Uint8Array<ArrayBuffer>> {
  const archive = pack();
  archive.entry({ name: `${top}/`, type: "directory" });

  for (const entry of entries) {
    const name = `${top}/${entry.path}`;
    if (entry.type === "directory") archive.entry({ name: `${name}/`, type: "directory" });
    else if (entry.type === "symlink") archive.entry({ name, type: "symlink", linkname: "README.md" });
    else archive.entry({ name }, entry.content ?? "");
  }
  archive.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(chunk as Buffer);
  return new Uint8Array(gzipSync(Buffer.concat(chunks)));
}
