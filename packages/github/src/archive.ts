import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";

import { extract, type Extract } from "tar-stream";

import { GitHubError, GitHubRepositoryTooLargeError, GitHubUnavailableError } from "./errors";

type Entry = Extract extends AsyncIterable<infer T> ? T : never;

export interface ArchiveLimits {
  /** Compressed bytes read from the response before giving up. */
  readonly maxDownloadBytes: number;
  /** Files larger than this are skipped. */
  readonly maxFileBytes: number;
}

/**
 * Reads the requested files from a gzipped GitHub tarball as it streams. The
 * archive's top-level directory (`<owner>-<repo>-<sha>/`) is removed from each
 * path. Only regular files are returned: requested paths that are missing,
 * larger than `maxFileBytes`, or not regular files are left out. Reading stops
 * once every requested file is found.
 */
export async function readArchive(
  body: ReadableStream<Uint8Array>,
  wanted: ReadonlySet<string>,
  { maxDownloadBytes, maxFileBytes }: ArchiveLimits,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  if (wanted.size === 0) {
    await body.cancel().catch(() => undefined);
    return files;
  }

  let downloaded = 0;
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        downloaded += chunk.byteLength;
        if (downloaded > maxDownloadBytes) {
          controller.error(new GitHubRepositoryTooLargeError("download_limit"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  const source = Readable.fromWeb(counted as unknown as NodeReadableStream<Uint8Array>);
  const gunzip = createGunzip();
  const entries = extract();
  const fail = (error: Error) => entries.destroy(error);
  source.on("error", fail);
  gunzip.on("error", fail);
  source.pipe(gunzip).pipe(entries);

  try {
    for await (const entry of entries) {
      const path = withoutTopDirectory(entry.header.name);
      const size = entry.header.size ?? 0;

      if (entry.header.type === "file" && path !== null && wanted.has(path) && size <= maxFileBytes) {
        files.set(path, await collect(entry));
      } else {
        entry.resume();
      }

      if (files.size === wanted.size) break;
    }
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    // A dropped connection surfaces as a TypeError from fetch. Anything else
    // is an archive that is not valid gzip or tar.
    throw new GitHubUnavailableError(error instanceof TypeError ? "network" : "invalid_response");
  } finally {
    source.destroy();
    gunzip.destroy();
    entries.destroy();
  }

  return files;
}

function withoutTopDirectory(name: string): string | null {
  const slash = name.indexOf("/");
  const path = slash === -1 ? "" : name.slice(slash + 1);
  return path === "" ? null : path;
}

async function collect(entry: Entry): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of entry) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}
