import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createGenerationClient, isGenerationConfigured, type GenerationClientOptions } from "./client";
import {
  GenerationConfigurationError,
  GenerationInvalidOutputError,
  GenerationProviderError,
  GenerationRateLimitError,
  GenerationRefusalError,
  GenerationTimeoutError,
} from "./errors";

const API_KEY = "sk-ant-test-s3cret-key";
const MODEL = "claude-test-model";
const PROMPT_SECRET = "PROMPT-CONTENT-7f3a";
const OUTPUT_SECRET = "MODEL-OUTPUT-91c2";

const schema = z.object({
  summary: z.string().max(200),
  files: z.array(z.string()).max(3),
});

interface Call {
  readonly url: URL;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

type Handler = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;

/** A client whose requests go to `handle`, recording every call. */
function client(handle: Handler, options: GenerationClientOptions = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    calls.push(call);
    return handle(call, init?.signal ?? undefined);
  }) as typeof globalThis.fetch;

  const generation = createGenerationClient({
    apiKey: API_KEY,
    model: MODEL,
    maxRetries: 0,
    fetch,
    ...options,
  });
  return { generation, calls };
}

function request(signal?: AbortSignal) {
  return {
    system: "Summarize the repository as JSON.",
    content: `Repository files: ${PROMPT_SECRET}`,
    schema,
    maxTokens: 4_000,
    effort: "high" as const,
    signal,
  };
}

interface StreamOptions {
  readonly text?: string;
  readonly stopReason?: string;
  readonly stopDetails?: Record<string, unknown> | null;
  readonly model?: string;
  readonly blocks?: readonly Record<string, unknown>[];
}

/** A streamed Messages API response, as server-sent events. */
function stream({ text, stopReason = "end_turn", stopDetails = null, model = MODEL, blocks = [] }: StreamOptions) {
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 0 },
        },
      },
    ],
  ];

  let index = 0;
  for (const block of blocks) {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: block }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
    index += 1;
  }
  if (text !== undefined) {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  }
  events.push([
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails },
      usage: { output_tokens: 42 },
    },
  ]);
  events.push(["message_stop", { type: "message_stop" }]);

  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function apiError(status: number, headers: Record<string, string> = {}) {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "api_error", message: `upstream says ${OUTPUT_SECRET}` } }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

const valid = JSON.stringify({ summary: `A widget ${OUTPUT_SECRET}`, files: ["src/index.ts"] });

async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error as Error,
  );
}

/** No error message may carry the key, the prompt, the output, or Anthropic's message. */
function expectNothingLeaked(error: Error) {
  for (const secret of [API_KEY, PROMPT_SECRET, OUTPUT_SECRET, "upstream says"]) {
    expect(error.message).not.toContain(secret);
  }
  expect(error).not.toHaveProperty("cause");
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("generateObject", () => {
  it("returns the parsed output, the model, and usage", async () => {
    const { generation } = client(() => stream({ text: valid }));

    await expect(generation.generateObject(request())).resolves.toEqual({
      output: { summary: `A widget ${OUTPUT_SECRET}`, files: ["src/index.ts"] },
      model: MODEL,
      fellBack: false,
      usage: { inputTokens: 120, outputTokens: 42 },
    });
  });

  it("sends the model, effort, a JSON schema, and the refusal fallback", async () => {
    const { generation, calls } = client(() => stream({ text: valid }));

    await generation.generateObject(request());

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url.href).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(call?.headers.get("x-api-key")).toBe(API_KEY);
    expect(call?.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(call?.body).toMatchObject({
      model: MODEL,
      max_tokens: 4_000,
      stream: true,
      system: "Summarize the repository as JSON.",
      messages: [{ role: "user", content: `Repository files: ${PROMPT_SECRET}` }],
      fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema" } },
    });
    const format = (call?.body.output_config as { format: { schema: Record<string, unknown> } }).format;
    expect(format.schema).toMatchObject({ type: "object", required: ["summary", "files"] });
    // No thinking setting, no prompt caching: each prompt is sent once.
    expect(call?.body).not.toHaveProperty("thinking");
    expect(JSON.stringify(call?.body)).not.toContain("cache_control");
  });

  it("leaves out the refusal fallback when it is turned off", async () => {
    const { generation, calls } = client(() => stream({ text: valid }), { refusalFallback: false });

    await generation.generateObject(request());

    expect(calls[0]?.body).not.toHaveProperty("fallbacks");
    expect(calls[0]?.headers.get("anthropic-beta")).toBeNull();
  });

  it("reports when a fallback model produced the output", async () => {
    const { generation } = client(() =>
      stream({
        text: valid,
        model: "claude-fallback-model",
        blocks: [{ type: "fallback", from: { model: MODEL }, to: { model: "claude-fallback-model" } }],
      }),
    );

    await expect(generation.generateObject(request())).resolves.toMatchObject({
      model: "claude-fallback-model",
      fellBack: true,
    });
  });

  it("reports a refusal with its category, before reading any output", async () => {
    const { generation } = client(() =>
      stream({ stopReason: "refusal", stopDetails: { type: "refusal", category: "cyber", explanation: null } }),
    );

    const error = await rejection(generation.generateObject(request()));

    expect(error).toBeInstanceOf(GenerationRefusalError);
    expect((error as GenerationRefusalError).category).toBe("cyber");
  });

  it.each([
    ["a response cut off at max_tokens", { text: `{"summary": "${OUTPUT_SECRET}`, stopReason: "max_tokens" }, "max_tokens"],
    ["a full context window", { text: "", stopReason: "model_context_window_exceeded" }, "context_window"],
    ["no text", { stopReason: "end_turn" }, "no_text"],
    ["text that is not JSON", { text: `Here is the summary: ${OUTPUT_SECRET}` }, "schema"],
    ["JSON in another shape", { text: JSON.stringify({ summary: 1, files: [OUTPUT_SECRET] }) }, "schema"],
    ["JSON over the schema's limits", { text: JSON.stringify({ summary: OUTPUT_SECRET, files: ["a", "b", "c", "d"] }) }, "schema"],
  ] satisfies [string, StreamOptions, string][])("rejects %s as invalid output", async (_case, response, reason) => {
    const { generation } = client(() => stream(response));

    const error = await rejection(generation.generateObject(request()));

    expect(error).toBeInstanceOf(GenerationInvalidOutputError);
    expect(error).toMatchObject({ reason });
    expectNothingLeaked(error);
  });

  it.each([
    [401, GenerationProviderError, "authentication"],
    [403, GenerationProviderError, "authentication"],
    [404, GenerationProviderError, "status"],
    [400, GenerationProviderError, "status"],
    [529, GenerationProviderError, "status"],
  ])("maps HTTP %s", async (status, type, reason) => {
    const { generation } = client(() => apiError(status));

    const error = await rejection(generation.generateObject(request()));

    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({ reason, status });
    expectNothingLeaked(error);
  });

  it("reports a rate limit with retry-after", async () => {
    const { generation } = client(() => apiError(429, { "retry-after": "17" }));

    const error = await rejection(generation.generateObject(request()));

    expect(error).toBeInstanceOf(GenerationRateLimitError);
    expect((error as GenerationRateLimitError).retryAfterSeconds).toBe(17);
    expectNothingLeaked(error);
  });

  it("reports a network failure without the request", async () => {
    const { generation } = client(() => {
      throw new TypeError(`fetch failed for ${API_KEY} ${PROMPT_SECRET}`);
    });

    const error = await rejection(generation.generateObject(request()));

    expect(error).toMatchObject({ name: "GenerationProviderError", reason: "network" });
    expectNothingLeaked(error);
  });

  it("times out", async () => {
    const { generation } = client(
      (_call, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
      { timeoutMs: 20 },
    );

    await expect(generation.generateObject(request())).rejects.toBeInstanceOf(GenerationTimeoutError);
  });

  it("rejects with the caller's reason when the caller cancels", async () => {
    const controller = new AbortController();
    const { generation } = client(
      (_call, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    const pending = generation.generateObject(request(controller.signal));
    controller.abort(new Error("analysis deleted"));

    await expect(pending).rejects.toThrow("analysis deleted");
  });
});

describe("configuration", () => {
  it("is not needed to create a client, only to generate", async () => {
    const generation = createGenerationClient({ fetch: () => Promise.reject(new Error("unused")) });

    await expect(generation.generateObject(request())).rejects.toBeInstanceOf(GenerationConfigurationError);
  });

  it("names the missing variable", async () => {
    const withoutModel = createGenerationClient({ apiKey: API_KEY });
    const withoutKey = createGenerationClient({ model: MODEL });

    await expect(withoutModel.generateObject(request())).rejects.toMatchObject({ variable: "ANTHROPIC_MODEL" });
    await expect(withoutKey.generateObject(request())).rejects.toMatchObject({ variable: "ANTHROPIC_API_KEY" });
  });

  it("is reported by isGenerationConfigured", () => {
    // The test environment leaves both variables empty.
    expect(isGenerationConfigured()).toBe(false);
  });

  it("is never read from ANTHROPIC_* variables by the SDK itself", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://evil.example.com";
    process.env.ANTHROPIC_AUTH_TOKEN = "env-auth-token";
    process.env.ANTHROPIC_LOG = "debug";
    const { generation, calls } = client(() => stream({ text: valid }));

    await generation.generateObject(request());

    expect(calls[0]?.url.origin).toBe("https://api.anthropic.com");
    expect(calls[0]?.headers.get("x-api-key")).toBe(API_KEY);
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });
});
