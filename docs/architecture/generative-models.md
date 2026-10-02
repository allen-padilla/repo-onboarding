# Generative Models

## Purpose

`@startup/generation` produces open-ended output with Claude: prose, explanations, and structured objects that need reasoning. Bounded decisions, such as classification and scoring, use `@startup/decision` instead (`decision-models.md`).

The package is the only code that calls the Anthropic API. Product prompts belong to the product code that uses them: the package takes a system prompt, the content, and a schema, and returns a validated object.

## Usage

```ts
import { createGenerationClient, isGenerationConfigured } from "@startup/generation";

const generation = createGenerationClient();

if (isGenerationConfigured()) {
  const { output, model, fellBack } = await generation.generateObject({
    system: "…instructions…",
    content: "…the material to work on…",
    schema: walkthroughSchema, // a zod schema
    maxTokens: 32_000,
    effort: "high",
    signal,
  });
}
```

## Requests

- **Structured output.** The zod schema is sent as a JSON schema in `output_config.format`, and the response is checked against the same schema again. The SDK's own parsing is not used, so a refusal or a cut-off response is reported as such rather than as a parse failure.
- **Streaming.** Requests stream and return the complete message (`finalMessage()`), so long inputs and outputs do not hit HTTP timeouts.
- **Effort.** Every request sets `output_config.effort`. Claude Opus 5.5 defaults to `medium` and always thinks adaptively, so the caller chooses the effort explicitly.
- **Refusal fallback.** By default a declined request is re-run on Anthropic's recommended fallback model, server-side (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). `fellBack` and `model` report when that happened. The configured model must support it. Pass `refusalFallback: false` for a model that does not.
- **No prompt caching.** Each prompt is sent once, so a cache write would only add cost.
- **Retries.** The SDK retries `408`, `409`, `429`, `5xx`, and connection errors twice by default. It also retries timeouts, so the total time can reach the timeout times three: pass a `signal` to bound it.
- **Nothing implicit.** The SDK client is created with an explicit key, a fixed base URL, `authToken: null`, and logging off. The SDK therefore never reads `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, a saved CLI profile, or `ANTHROPIC_LOG`, which at `debug` would log request bodies.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key. Secret. |
| `ANTHROPIC_MODEL` | Claude model name. `claude-opus-5-5` is recommended. |

Both are server-only, validated by `@startup/env`, and optional, but set together or both left empty: setting only one fails validation. `isGenerationConfigured()` says whether both are set. Calling the client without a value it needs raises `GenerationConfigurationError`, which names the variable but never its value.

The model is configuration: the code hard-codes no model name. Neither variable is read at build time.

The Anthropic SDK and Claude Code also read `ANTHROPIC_API_KEY`, so it is often exported in developers' shells. On its own it fails validation in any process that reads the shell directly, such as `next start` or `pnpm --filter <package> test`. Turbo's strict environment mode keeps it out of `pnpm dev`, `pnpm build`, and `pnpm test`. Every package's `vitest.config.ts` sets both variables to empty, and E2E runs set them explicitly. Elsewhere, set `ANTHROPIC_MODEL` too, or unset the key.

Set a spending limit for the key in the Claude Console.

## Failures

Every error extends `GenerationError`. Messages never contain the key, the prompt, the content, the output, or Anthropic's own messages, and errors have no `cause`.

| Error | Cause |
| --- | --- |
| `GenerationConfigurationError` | a required variable is not set |
| `GenerationRefusalError` | `stop_reason: "refusal"` after any fallback, with the reported `category` |
| `GenerationInvalidOutputError` | `reason` is `max_tokens`, `context_window`, `no_text`, or `schema` |
| `GenerationRateLimitError` | `429` after retries, with `retryAfterSeconds` when Anthropic sends `retry-after` |
| `GenerationTimeoutError` | no complete response within the timeout, retries included |
| `GenerationProviderError` | `reason` is `network`, `authentication` (`401`, `403`), `status` (other statuses, such as `404` for an unknown model, or `5xx`), or `invalid_response` |

A caller's `signal` rejects with the signal's reason.

## Testing

Automated tests never call Anthropic. They inject a fake `fetch` that returns streamed responses, replace the global `fetch` with one that fails the test (`src/testing/no-network.ts`), and run with both variables empty.
