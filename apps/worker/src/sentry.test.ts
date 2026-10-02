import type { ErrorEvent } from "@sentry/node";
import { describe, expect, it } from "vitest";

import { reduceEvent } from "./sentry";

const SECRET = "repository-content-or-prompt";

describe("reduceEvent", () => {
  it("keeps the error, the analysis ID, and the step, and nothing else", () => {
    const event: ErrorEvent = {
      type: undefined,
      event_id: "abc",
      timestamp: 1,
      level: "error",
      environment: "production",
      tags: { analysis_id: "repo-1", step: "download", user: SECRET },
      extra: { content: SECRET },
      user: { email: SECRET },
      request: { data: SECRET, url: `https://api.example.com/${SECRET}` },
      breadcrumbs: [{ message: SECRET }],
      contexts: { custom: { value: SECRET } },
      exception: {
        values: [
          {
            type: "AnalysisError",
            value: 'The analysis failed at step "download" with Error.',
            stacktrace: {
              frames: [{ filename: "handlers.ts", function: "run", lineno: 10, context_line: "await run();", vars: { content: SECRET } }],
            },
          },
        ],
      },
    };

    const reduced = reduceEvent(event);

    expect(JSON.stringify(reduced)).not.toContain(SECRET);
    expect(reduced.tags).toEqual({ analysis_id: "repo-1", step: "download" });
    expect(reduced.exception?.values?.[0]).toMatchObject({
      type: "AnalysisError",
      stacktrace: { frames: [{ filename: "handlers.ts", function: "run", lineno: 10, context_line: "await run();" }] },
    });
  });
});
