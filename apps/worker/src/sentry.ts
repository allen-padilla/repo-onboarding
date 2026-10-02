import * as Sentry from "@sentry/node";

import { clientEnv } from "@startup/env/client";
import type { AnalysisError } from "@startup/onboarding/worker";

// Errors only. The worker holds repository contents, prompts, and model
// output, none of which may reach Sentry: no tracing, no breadcrumbs, no
// request or response bodies, no stack-frame variables, and every event cut
// down to the error, the analysis ID, and the step. See
// docs/architecture/observability.md.

const KEPT_TAGS = new Set(["analysis_id", "step"]);

Sentry.init({
  // Sentry is disabled when no DSN is configured, as in local development.
  dsn: clientEnv.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
  // The web app's settings (apps/web/sentry.server.config.ts), plus no local
  // variables, which would hold file contents and prompts.
  dataCollection: {
    userInfo: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    httpBodies: [],
    httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
    cookies: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
    urlQueryParams: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
    stackFrameVariables: false,
  },
  // Breadcrumbs would record GitHub and model requests.
  beforeBreadcrumb: () => null,
  beforeSend: reduceEvent,
});

/**
 * Keeps only the error (type, message, and stack frames without variables),
 * the analysis ID and step tags, and the event's own metadata.
 */
export function reduceEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const tags = Object.fromEntries(Object.entries(event.tags ?? {}).filter(([key]) => KEPT_TAGS.has(key)));

  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    environment: event.environment,
    sdk: event.sdk,
    tags,
    exception: {
      values: event.exception?.values?.map(({ type, value, mechanism, stacktrace }) => ({
        type,
        value,
        mechanism,
        stacktrace: stacktrace && {
          // The worker's own source lines are kept; local variables are not.
          frames: stacktrace.frames?.map(
            ({ filename, function: name, lineno, colno, in_app, module, pre_context, context_line, post_context }) => ({
              filename,
              function: name,
              lineno,
              colno,
              in_app,
              module,
              pre_context,
              context_line,
              post_context,
            }),
          ),
        },
      })),
    },
  };
}

/** An analysis failed unexpectedly. The error holds only a step and an error type. */
export function reportAnalysisError(error: AnalysisError, { repositoryId }: { repositoryId: string }) {
  Sentry.captureException(error, { tags: { analysis_id: repositoryId, step: error.step } });
}

/** A background error from the job queue. */
export function reportError(error: Error) {
  Sentry.captureException(error);
}

/** Sends what is queued, waiting at most `timeoutMs`. */
export function closeSentry(timeoutMs = 2_000): Promise<boolean> {
  return Sentry.close(timeoutMs);
}
