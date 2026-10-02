import { serverEnv } from "@startup/env";

/**
 * Whether `request` comes from a page on the application's own origin.
 * Browsers send `Origin` with every `POST` and `DELETE`, and route handlers do
 * not get the check that Server Actions get, so state-changing routes call
 * this before they change anything.
 */
export function isSameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(serverEnv.BETTER_AUTH_URL).origin;
}
