import {
  DecisionAuthenticationError,
  DecisionConfigurationError,
  DecisionError,
  DecisionProviderError,
  DecisionRateLimitError,
  DecisionTimeoutError,
  type DecisionClient,
} from "@startup/decision";

import {
  ROLE_CONFIDENCE_THRESHOLD,
  SCORING_CONCURRENCY,
  SCORING_CONTENT_BYTES,
  SCORING_DEADLINE_MS,
  SCORING_FAILURES_IN_A_ROW,
  SCORING_RATE_LIMIT_WAIT_MS,
} from "../limits";
import type { FileRole } from "../walkthrough-document";
import { pathRole } from "./signals";

// Importance and role for each chosen file, from TypeSafe through
// @startup/decision. Every file TypeSafe cannot answer for falls back to its
// local score and path-rule role, and the analysis continues.

export interface ScoringFile {
  readonly path: string;
  readonly size: number;
  readonly localScore: number;
  readonly content: string;
}

export interface RankedFile {
  readonly path: string;
  readonly size: number;
  readonly role: FileRole;
  /** From 0 to 4, TypeSafe's or the local one. */
  readonly score: number;
  readonly localScore: number;
  readonly scoredBy: "decision" | "local";
}

export interface ScoringOptions {
  /** `null` ranks every file by local signals. */
  readonly decision: Pick<DecisionClient, "evaluate"> | null;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

// Product policy for the two questions. The roles match FILE_ROLES.
export const SCORING_QUESTIONS = {
  importance: {
    type: "score",
    instructions:
      "How important is this file for a new engineer who wants to understand the project? Judge from the path and the start of the file.",
    criteria: [
      "A new engineer never needs to open this file.",
      "Rarely useful: open it only for a specific task.",
      "Useful background once the main parts are understood.",
      "Important: worth reading in the first week.",
      "Essential to understanding the project: read it first.",
    ],
  },
  role: {
    type: "choice",
    instructions: "Which role does this file play in the project?",
    criteria: {
      entry_point:
        "Where the program, service, or library starts: a main function, a server or CLI start-up, or the module that exports the public API.",
      configuration: "Configuration, including build, packaging, CI, deployment, and tooling files.",
      domain_logic: "Application source that is none of the other roles.",
      test: "Tests, test helpers, and test fixtures.",
      documentation: "Documentation, guides, and examples.",
    },
  },
} as const;

/**
 * Scores `files`, at most `SCORING_CONCURRENCY` at a time, and returns them
 * ranked: by score, then local score, then path. The analysis `signal` aborts
 * scoring; TypeSafe failures never do.
 */
export async function scoreFiles(files: readonly ScoringFile[], options: ScoringOptions): Promise<RankedFile[]> {
  const { decision, signal, now, sleep } = options;
  const deadline = now() + SCORING_DEADLINE_MS;
  const results: RankedFile[] = new Array(files.length);
  let next = 0;
  let stopped = decision === null;
  let failuresInRow = 0;

  const local = (file: ScoringFile): RankedFile => ({
    path: file.path,
    size: file.size,
    role: pathRole(file.path),
    score: file.localScore,
    localScore: file.localScore,
    scoredBy: "local",
  });

  const ask = (file: ScoringFile) =>
    decision!.evaluate({
      state: { path: file.path, content: truncate(file.content, SCORING_CONTENT_BYTES) },
      questions: SCORING_QUESTIONS,
      signal,
    });

  // A rate limit that asks for a short wait is waited out once per file.
  async function answer(file: ScoringFile) {
    try {
      return await ask(file);
    } catch (error) {
      const wait = error instanceof DecisionRateLimitError ? (error.retryAfterSeconds ?? Infinity) * 1000 : Infinity;
      if (wait > SCORING_RATE_LIMIT_WAIT_MS || now() + wait >= deadline) throw error;
      await sleep(wait, signal);
      return ask(file);
    }
  }

  async function score(file: ScoringFile): Promise<RankedFile> {
    if (stopped || now() >= deadline) return local(file);

    try {
      const { answers } = await answer(file);
      failuresInRow = 0;

      const role = answers.role.confidence >= ROLE_CONFIDENCE_THRESHOLD ? answers.role.choice : pathRole(file.path);
      return { ...local(file), role, score: clamp(answers.importance.score), scoredBy: "decision" };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (!(error instanceof DecisionError)) throw error;

      if (error instanceof DecisionAuthenticationError || error instanceof DecisionConfigurationError) {
        stopped = true;
      } else if (error instanceof DecisionTimeoutError || error instanceof DecisionProviderError) {
        failuresInRow += 1;
        if (failuresInRow >= SCORING_FAILURES_IN_A_ROW) stopped = true;
      }
      return local(file);
    }
  }

  async function work() {
    while (next < files.length) {
      const index = next++;
      results[index] = await score(files[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(SCORING_CONCURRENCY, files.length) }, work));
  return results.sort(byRank);
}

/** Rank order: score, then local score, then path. */
export function byRank(a: RankedFile, b: RankedFile): number {
  return b.score - a.score || b.localScore - a.localScore || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function clamp(score: number): number {
  return Math.min(4, Math.max(0, score));
}

/** The first `bytes` bytes of `text`, cut at a character boundary. */
export function truncate(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= bytes) return text;
  return new TextDecoder().decode(encoded.subarray(0, bytes)).replace(/�$/, "");
}
