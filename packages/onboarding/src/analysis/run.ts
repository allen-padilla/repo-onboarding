import type { DecisionClient } from "@startup/decision";
import type { GenerationClient } from "@startup/generation";
import {
  GitHubEmptyRepositoryError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubRepositoryTooLargeError,
  type GitHubClient,
} from "@startup/github";

import {
  CANDIDATE_LIMIT,
  GITHUB_RATE_LIMIT_WAIT_MS,
  MAX_ATTRIBUTES_BYTES,
  MAX_DOWNLOAD_BYTES,
  MAX_FILE_BYTES,
  SCORED_FILE_LIMIT,
} from "../limits";
import { walkthroughDocumentSchema, type WalkthroughDocument } from "../walkthrough-document";
import { basicWalkthrough } from "./basic";
import { AnalysisFailure, type AnalysisStep, type Coverage } from "./errors";
import { contentDropReason, filterListing } from "./filters";
import { scoreFiles, type ScoringFile } from "./scoring";
import { localScore } from "./signals";
import { writeWalkthrough } from "./walkthrough";

export interface AnalysisTarget {
  readonly owner: string;
  readonly name: string;
  readonly commitSha: string;
}

export interface AnalysisDependencies {
  readonly github: Pick<GitHubClient, "getRepository" | "getTree" | "readFile" | "readFiles">;
  /** `null` ranks by local signals only. */
  readonly decision: Pick<DecisionClient, "evaluate"> | null;
  /** `null` builds the basic walkthrough. */
  readonly generation: Pick<GenerationClient, "generateObject"> | null;
  readonly now: () => number;
  /** Waits `ms`, or rejects with the signal's reason. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface AnalysisRun {
  readonly signal: AbortSignal;
  /** When the analysis time limit ends, by `now`. */
  readonly deadline: number;
  /** The step in progress, for error reports. */
  readonly progress: { step: AnalysisStep };
}

export interface AnalysisOutcome {
  readonly coverage: Coverage;
  readonly walkthrough: WalkthroughDocument;
}

/**
 * Analyzes the repository at the recorded commit. File contents exist only in
 * memory here and are gone when it returns.
 *
 * Raises `AnalysisFailure` for an expected failure, and `GitHubRateLimitError`
 * when GitHub's limit resets later than this run can wait. The run's `signal`
 * rejects with its reason. Anything else is unexpected.
 */
export async function runAnalysis(
  target: AnalysisTarget,
  deps: AnalysisDependencies,
  run: AnalysisRun,
): Promise<AnalysisOutcome> {
  const { owner, name, commitSha } = target;
  const { signal, deadline, progress } = run;

  // GitHub's limit is waited out when it resets soon enough. Otherwise the
  // error reaches the worker, which queues the analysis again for later.
  const github = async <T>(step: AnalysisStep, call: () => Promise<T>): Promise<T> => {
    progress.step = step;
    try {
      try {
        return await call();
      } catch (error) {
        if (!(error instanceof GitHubRateLimitError)) throw error;
        const wait = Math.max(0, error.resetAt.getTime() - deps.now()) + 1_000;
        if (wait > GITHUB_RATE_LIMIT_WAIT_MS || deps.now() + wait >= deadline) throw error;
        await deps.sleep(wait, signal);
        return await call();
      }
    } catch (error) {
      if (error instanceof GitHubNotFoundError) throw new AnalysisFailure("not_found");
      if (error instanceof GitHubRepositoryTooLargeError) throw new AnalysisFailure("too_large");
      if (error instanceof GitHubEmptyRepositoryError) throw new AnalysisFailure("nothing_to_analyze");
      throw error;
    }
  };

  // Visibility is checked again: the repository may have been made private or
  // deleted since it was added.
  const repository = await github("repository", () => deps.github.getRepository(owner, name, { signal }));
  const tree = await github("listing", () => deps.github.getTree(owner, name, commitSha, { signal }));
  const attributes = await github("attributes", () =>
    deps.github.readFile(owner, name, commitSha, ".gitattributes", { maxBytes: MAX_ATTRIBUTES_BYTES, signal }),
  );

  const { listed, kept } = filterListing(tree, attributes);
  if (kept.length === 0) {
    throw new AnalysisFailure("nothing_to_analyze", { listed, dropped: listed, unscored: 0, localOnly: 0 });
  }

  // Candidates by local score. Each is read, and the first files that pass the
  // content checks are scored.
  const byLocalScore = kept
    .map((file) => ({ ...file, localScore: localScore(file) }))
    .sort((a, b) => b.localScore - a.localScore || (a.path < b.path ? -1 : 1));
  const candidates = byLocalScore.slice(0, CANDIDATE_LIMIT);

  const archive = await github("download", () =>
    deps.github.readFiles(
      owner,
      name,
      commitSha,
      candidates.map((file) => file.path),
      { maxDownloadBytes: MAX_DOWNLOAD_BYTES, maxFileBytes: MAX_FILE_BYTES, signal },
    ),
  );

  const chosen: ScoringFile[] = [];
  const droppedOnRead = new Set<string>();
  for (const file of candidates) {
    if (chosen.length === SCORED_FILE_LIMIT) break;

    const bytes = archive.get(file.path);
    if (!bytes || contentDropReason(bytes)) {
      droppedOnRead.add(file.path);
      continue;
    }
    chosen.push({ ...file, content: new TextDecoder().decode(bytes) });
  }
  archive.clear();

  // Files found to be binary or generated when read are dropped too.
  const remaining = kept.filter((file) => !droppedOnRead.has(file.path));
  const dropped = listed - remaining.length;
  if (chosen.length === 0) {
    throw new AnalysisFailure("nothing_to_analyze", { listed, dropped, unscored: listed - dropped, localOnly: 0 });
  }

  progress.step = "scoring";
  signal.throwIfAborted();
  const ranked = await scoreFiles(chosen, { decision: deps.decision, signal, now: deps.now, sleep: deps.sleep });

  const coverage: Coverage = {
    listed,
    dropped,
    unscored: listed - dropped - ranked.length,
    localOnly: ranked.filter((file) => file.scoredBy === "local").length,
  };

  progress.step = "writing";
  signal.throwIfAborted();
  const walkthrough = deps.generation
    ? await writeWalkthrough(
        {
          repository: { owner, name, description: repository.description },
          kept: remaining,
          ranked,
          contents: new Map(chosen.map((file) => [file.path, file.content])),
        },
        { generation: deps.generation, signal, deadline, now: deps.now },
      ).catch((error: unknown) => {
        if (error instanceof AnalysisFailure) throw new AnalysisFailure(error.reason, coverage);
        throw error;
      })
    : basicWalkthrough({ description: repository.description, kept: remaining, ranked });

  // A document that does not parse would leave the repository done but
  // unreadable, and a done analysis cannot be retried.
  if (!walkthroughDocumentSchema.safeParse(walkthrough).success) throw new Error("The walkthrough is not a valid document.");

  return { coverage, walkthrough };
}
