// Errors never include the API key, the prompt, the content, the model's
// output, or Anthropic's own messages, so they are safe to log, report, and
// store. They deliberately have no `cause`, as in @startup/email.

/** Base class for every error raised by `@startup/generation`. */
export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationError";
  }
}

export type GenerationVariable = "ANTHROPIC_API_KEY" | "ANTHROPIC_MODEL";

/**
 * Thrown when generating without the configuration it needs. The writing model
 * is optional until used, so this is raised when called instead of at startup.
 */
export class GenerationConfigurationError extends GenerationError {
  readonly variable: GenerationVariable;

  constructor(variable: GenerationVariable) {
    super(`The writing model is not configured: ${variable} is not set.`);
    this.name = "GenerationConfigurationError";
    this.variable = variable;
  }
}

/** `429`. `retryAfterSeconds` when Anthropic sent `retry-after`. */
export class GenerationRateLimitError extends GenerationError {
  readonly retryAfterSeconds: number | undefined;

  constructor(retryAfterSeconds: number | undefined) {
    super("The writing model's rate limit is reached.");
    this.name = "GenerationRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** No complete response within the request timeout, retries included. */
export class GenerationTimeoutError extends GenerationError {
  constructor() {
    super("The writing model did not respond in time.");
    this.name = "GenerationTimeoutError";
  }
}

/**
 * The model declined (`stop_reason: "refusal"`), after any refusal fallback.
 * `category` is the refusal category Anthropic reported, such as `cyber`.
 */
export class GenerationRefusalError extends GenerationError {
  readonly category: string | null;

  constructor(category: string | null) {
    super(`The writing model declined the request${category ? ` (${category})` : ""}.`);
    this.name = "GenerationRefusalError";
    this.category = category;
  }
}

export type GenerationInvalidOutputReason = "max_tokens" | "context_window" | "no_text" | "schema";

/**
 * The response ended without a complete output (`max_tokens`,
 * `context_window`), had no text, or did not match the requested schema.
 */
export class GenerationInvalidOutputError extends GenerationError {
  readonly reason: GenerationInvalidOutputReason;

  constructor(reason: GenerationInvalidOutputReason) {
    super(`The writing model's output is not usable (${reason}).`);
    this.name = "GenerationInvalidOutputError";
    this.reason = reason;
  }
}

export type GenerationProviderReason = "network" | "authentication" | "status" | "invalid_response";

/**
 * The request failed: a network failure, a rejected key (`401`, `403`), any
 * other status, including `4xx` for an unknown model and `5xx`, or a response
 * the client could not read.
 */
export class GenerationProviderError extends GenerationError {
  readonly reason: GenerationProviderReason;
  readonly status: number | undefined;

  constructor(reason: GenerationProviderReason, status?: number) {
    super(
      status === undefined
        ? `The writing model request failed (${reason}).`
        : `The writing model request failed (${reason}, HTTP ${status}).`,
    );
    this.name = "GenerationProviderError";
    this.reason = reason;
    this.status = status;
  }
}
