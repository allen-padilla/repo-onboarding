import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

import { serverEnv } from "@startup/env";

import {
  GenerationConfigurationError,
  GenerationError,
  GenerationInvalidOutputError,
  GenerationProviderError,
  GenerationRateLimitError,
  GenerationRefusalError,
  GenerationTimeoutError,
  type GenerationVariable,
} from "./errors";

const API_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_RETRIES = 2;
const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type GenerationEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface GenerationClientOptions {
  /** Anthropic API key. Defaults to `ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** Claude model name. Defaults to `ANTHROPIC_MODEL`. */
  model?: string;
  /**
   * Per request attempt, including reading the response. Default 5 minutes.
   * The SDK retries timeouts, so pass a `signal` to bound the total.
   */
  timeoutMs?: number;
  /** Retries for `408`, `409`, `429`, `5xx`, and connection errors. Default 2. */
  maxRetries?: number;
  /**
   * Re-run a declined request on Anthropic's recommended fallback model,
   * server-side (`fallbacks: "default"`). Default true. The configured model
   * must support it.
   */
  refusalFallback?: boolean;
  /** HTTP transport. Defaults to the global `fetch`; tests inject a fake. */
  fetch?: typeof fetch;
}

export interface GenerateObjectRequest<T> {
  /** Instructions. Stable across requests. */
  system: string;
  /** The material to work on, sent as the user turn. Treated as data by the prompt. */
  content: string;
  /** The output's shape. Sent as a JSON schema and checked again on the response. */
  schema: z.ZodType<T>;
  maxTokens: number;
  effort: GenerationEffort;
  signal?: AbortSignal;
}

export interface GenerationResult<T> {
  readonly output: T;
  /** The model that produced the output. Differs from the requested one after a refusal fallback. */
  readonly model: string;
  readonly fellBack: boolean;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface GenerationClient {
  /**
   * Asks the model for one object matching `schema`. Raises a
   * `GenerationError` for every failure. A caller's `signal` rejects with its
   * reason.
   */
  generateObject<T>(request: GenerateObjectRequest<T>): Promise<GenerationResult<T>>;
}

/** Whether the writing model is configured: `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are both set. */
export function isGenerationConfigured(): boolean {
  return Boolean(serverEnv.ANTHROPIC_API_KEY && serverEnv.ANTHROPIC_MODEL);
}

/**
 * Creates a server-only client for open-ended generation with Claude.
 * Creating a client never requires configuration; calling it does. Product
 * prompts belong to the caller.
 */
export function createGenerationClient(options: GenerationClientOptions = {}): GenerationClient {
  const refusalFallback = options.refusalFallback ?? true;
  let sdk: Anthropic | undefined;

  // Every option is explicit, so the SDK reads nothing from the environment
  // itself: no ANTHROPIC_BASE_URL, no ANTHROPIC_AUTH_TOKEN or saved profile,
  // and no ANTHROPIC_LOG, which at `debug` would log request bodies.
  function client(): Anthropic {
    sdk ??= new Anthropic({
      apiKey: required("ANTHROPIC_API_KEY", options.apiKey || serverEnv.ANTHROPIC_API_KEY),
      authToken: null,
      baseURL: API_URL,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      logLevel: "off",
      fetch: options.fetch,
    });
    return sdk;
  }

  return {
    async generateObject<T>(request: GenerateObjectRequest<T>): Promise<GenerationResult<T>> {
      const model = required("ANTHROPIC_MODEL", options.model || serverEnv.ANTHROPIC_MODEL);
      const anthropic = client();

      // The schema only: without the helper's `parse`, the SDK leaves the
      // response unparsed, so a refusal or a cut-off response is reported as
      // such instead of as a parse failure.
      const { type, schema } = betaZodOutputFormat(request.schema);

      let message: Anthropic.Beta.BetaMessage;
      try {
        const stream = anthropic.beta.messages.stream(
          {
            model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: [{ role: "user", content: request.content }],
            output_config: { effort: request.effort, format: { type, schema } },
            ...(refusalFallback ? { fallbacks: "default" as const, betas: [REFUSAL_FALLBACK_BETA] } : {}),
          },
          { signal: request.signal },
        );
        message = await stream.finalMessage();
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason;
        throw generationError(error);
      }

      if (message.stop_reason === "refusal") {
        throw new GenerationRefusalError(message.stop_details?.category ?? null);
      }
      if (message.stop_reason === "max_tokens") throw new GenerationInvalidOutputError("max_tokens");
      if (message.stop_reason === "model_context_window_exceeded") {
        throw new GenerationInvalidOutputError("context_window");
      }

      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      if (text === "") throw new GenerationInvalidOutputError("no_text");

      let output: T;
      try {
        const parsed = request.schema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new GenerationInvalidOutputError("schema");
        output = parsed.data;
      } catch {
        throw new GenerationInvalidOutputError("schema");
      }

      return {
        output,
        model: message.model,
        fellBack: message.content.some((block) => block.type === "fallback"),
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      };
    },
  };
}

function required(variable: GenerationVariable, value: string | undefined): string {
  if (!value) throw new GenerationConfigurationError(variable);
  return value;
}

// Most specific first: in this SDK, APIConnectionTimeoutError extends
// APIConnectionError, which extends APIError.
function generationError(error: unknown): GenerationError {
  if (error instanceof GenerationError) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new GenerationTimeoutError();
  if (error instanceof Anthropic.APIUserAbortError) return new GenerationTimeoutError();
  if (error instanceof Anthropic.APIConnectionError) return new GenerationProviderError("network");
  if (error instanceof Anthropic.RateLimitError) {
    return new GenerationRateLimitError(retryAfterSeconds(error.headers?.get("retry-after")));
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new GenerationProviderError("authentication", error.status);
  }
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    return new GenerationProviderError("status", error.status);
  }
  return new GenerationProviderError("invalid_response");
}

function retryAfterSeconds(value: string | null | undefined): number | undefined {
  return value && /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;
}
