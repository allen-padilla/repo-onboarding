import { describe, expect, it } from "vitest";

import {
  DecisionAuthenticationError,
  DecisionConfigurationError,
  DecisionProviderError,
  DecisionRateLimitError,
  DecisionTimeoutError,
  DecisionValidationError,
  type DecisionClient,
} from "@startup/decision";

import { SCORING_CONTENT_BYTES, SCORING_DEADLINE_MS } from "../limits";
import type { FileRole } from "../walkthrough-document";
import { scoreFiles, truncate, type ScoringFile } from "./scoring";

type Evaluate = DecisionClient["evaluate"];
type Reply = { score: number; role: FileRole; confidence?: number } | Error;

function files(count: number, prefix = "src/file"): ScoringFile[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `${prefix}${String(index).padStart(3, "0")}.ts`,
    size: 1_000,
    localScore: 2,
    content: `content ${index}`,
  }));
}

/** A decision client that answers with `reply(path, call)` and records calls. */
function fakeDecision(reply: (path: string, call: number) => Reply) {
  const calls: { path: string; content: string }[] = [];
  const evaluate = (async (request: { state: unknown }) => {
    const state = request.state as { path: string; content: string };
    calls.push(state);
    const answer = reply(state.path, calls.length);
    if (answer instanceof Error) throw answer;

    return {
      model: "jev-test",
      usage: { inputTokens: 1, outputTokens: 1 },
      answers: {
        importance: { type: "score", score: answer.score, confidence: 0.9, legend: {}, probabilities: {} },
        role: { type: "choice", choice: answer.role, confidence: answer.confidence ?? 0.9, probabilities: {} },
      },
    };
  }) as unknown as Evaluate;
  return { calls, client: { evaluate } };
}

function options(decision: { evaluate: Evaluate } | null, overrides: { now?: () => number } = {}) {
  const sleeps: number[] = [];
  return {
    decision,
    signal: new AbortController().signal,
    now: overrides.now ?? (() => 0),
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

describe("scoreFiles", () => {
  it("uses TypeSafe's importance and role, and ranks by score", async () => {
    const decision = fakeDecision((path) => ({ score: path.endsWith("001.ts") ? 3.6 : 1.2, role: "domain_logic" }));

    const ranked = await scoreFiles(files(3), options(decision.client));

    expect(ranked.map((file) => [file.path, file.score, file.scoredBy])).toEqual([
      ["src/file001.ts", 3.6, "decision"],
      ["src/file000.ts", 1.2, "decision"],
      ["src/file002.ts", 1.2, "decision"],
    ]);
  });

  it("sends the path and at most 16 KB of content", async () => {
    const decision = fakeDecision(() => ({ score: 2, role: "domain_logic" }));
    const long = { path: "src/long.ts", size: 50_000, localScore: 2, content: "é".repeat(20_000) };

    await scoreFiles([long], options(decision.client));

    expect(decision.calls[0]!.path).toBe("src/long.ts");
    expect(new TextEncoder().encode(decision.calls[0]!.content).byteLength).toBeLessThanOrEqual(SCORING_CONTENT_BYTES);
    expect(decision.calls[0]!.content).not.toContain("�");
  });

  it("replaces a low-confidence role with the path rule", async () => {
    const decision = fakeDecision((path) => ({ score: 2, role: "documentation", confidence: path.includes("000") ? 0.3 : 0.8 }));

    const ranked = await scoreFiles(files(2, "test/file"), options(decision.client));
    const roles = Object.fromEntries(ranked.map((file) => [file.path, file.role]));

    expect(roles).toEqual({ "test/file000.ts": "test", "test/file001.ts": "documentation" });
  });

  it("ranks every file by local signals without TypeSafe", async () => {
    const ranked = await scoreFiles(
      [
        { path: "test/a.test.ts", size: 1_000, localScore: 1, content: "" },
        { path: "src/index.ts", size: 1_000, localScore: 3.5, content: "" },
      ],
      options(null),
    );

    expect(ranked).toEqual([
      { path: "src/index.ts", size: 1_000, role: "entry_point", score: 3.5, localScore: 3.5, scoredBy: "local" },
      { path: "test/a.test.ts", size: 1_000, role: "test", score: 1, localScore: 1, scoredBy: "local" },
    ]);
  });

  it("falls back for a file whose request fails, and continues", async () => {
    const decision = fakeDecision((path) =>
      path.endsWith("001.ts") ? new DecisionValidationError(422, []) : { score: 4, role: "entry_point" },
    );

    const ranked = await scoreFiles(files(3), options(decision.client));

    expect(decision.calls).toHaveLength(3);
    expect(ranked.find((file) => file.path.endsWith("001.ts"))).toMatchObject({ scoredBy: "local", score: 2 });
    expect(ranked.filter((file) => file.scoredBy === "decision")).toHaveLength(2);
  });

  it.each([
    ["an authentication error", new DecisionAuthenticationError(401)],
    ["a configuration error", new DecisionConfigurationError("TYPESAFE_API_KEY")],
  ])("falls back for every remaining file after %s", async (_, error) => {
    const decision = fakeDecision(() => error);

    const ranked = await scoreFiles(files(20), options(decision.client));

    // The requests already in flight finish; no new ones start.
    expect(decision.calls.length).toBeLessThanOrEqual(4);
    expect(ranked.every((file) => file.scoredBy === "local")).toBe(true);
  });

  it("stops after 5 timeouts or provider errors in a row", async () => {
    let call = 0;
    const decision = fakeDecision(() => {
      call += 1;
      return call % 2 ? new DecisionTimeoutError(10_000) : new DecisionProviderError("status", "HTTP 502", 502);
    });

    const ranked = await scoreFiles(files(40), options(decision.client));

    expect(decision.calls.length).toBeLessThan(10);
    expect(ranked.every((file) => file.scoredBy === "local")).toBe(true);
  });

  it("does not stop when failures are not in a row", async () => {
    const decision = fakeDecision((_, call) => (call % 2 ? new DecisionTimeoutError(10_000) : { score: 3, role: "domain_logic" }));

    await scoreFiles(files(40), options(decision.client));

    expect(decision.calls).toHaveLength(40);
  });

  it("waits out a short rate limit once, then falls back", async () => {
    const decision = fakeDecision((path, call) =>
      path.endsWith("000.ts") ? new DecisionRateLimitError(5) : call < 3 ? new DecisionRateLimitError(10) : { score: 3, role: "test" },
    );
    const opts = options(decision.client);

    const ranked = await scoreFiles(files(2), opts);

    expect(opts.sleeps).toEqual(expect.arrayContaining([5_000, 10_000]));
    expect(ranked.find((file) => file.path.endsWith("000.ts"))!.scoredBy).toBe("local");
  });

  it("does not wait for a long or unknown rate limit", async () => {
    const decision = fakeDecision((path) => new DecisionRateLimitError(path.endsWith("000.ts") ? 120 : undefined));
    const opts = options(decision.client);

    await scoreFiles(files(2), opts);

    expect(opts.sleeps).toEqual([]);
    expect(decision.calls).toHaveLength(2);
  });

  it("stops at the scoring deadline", async () => {
    let time = 0;
    const decision = fakeDecision(() => {
      time += SCORING_DEADLINE_MS / 10;
      return { score: 3, role: "domain_logic" };
    });

    const ranked = await scoreFiles(files(50), options(decision.client, { now: () => time }));

    expect(decision.calls.length).toBeGreaterThanOrEqual(10);
    expect(decision.calls.length).toBeLessThan(15);
    expect(ranked.filter((file) => file.scoredBy === "local").length).toBe(50 - decision.calls.length);
  });

  it("stops with the analysis signal", async () => {
    const controller = new AbortController();
    const decision = fakeDecision(() => {
      controller.abort(new Error("stopped"));
      return new DecisionTimeoutError(10_000);
    });

    await expect(scoreFiles(files(5), { ...options(decision.client), signal: controller.signal })).rejects.toThrow("stopped");
  });

  it("ranks equal scores by local score, then path", async () => {
    const decision = fakeDecision(() => ({ score: 2, role: "domain_logic" }));
    const input: ScoringFile[] = [
      { path: "b.ts", size: 1, localScore: 1, content: "" },
      { path: "c.ts", size: 1, localScore: 3, content: "" },
      { path: "a.ts", size: 1, localScore: 1, content: "" },
    ];

    const ranked = await scoreFiles(input, options(decision.client));

    expect(ranked.map((file) => file.path)).toEqual(["c.ts", "a.ts", "b.ts"]);
  });
});

describe("truncate", () => {
  it("cuts at a character boundary", () => {
    expect(truncate("aé", 2)).toBe("a");
    expect(truncate("abc", 10)).toBe("abc");
  });
});
