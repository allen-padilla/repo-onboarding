// Browser contexts that present as a regular browser.
import type { Browser } from "@playwright/test";

import { uniqueIp } from "./identity";

/**
 * A page in a context that presents as a regular browser. PostHog drops
 * events from browsers it considers bots, which includes every automated
 * browser, so tests that check what PostHog receives use this page.
 */
export async function regularBrowserPage(browser: Browser, baseURL: string | undefined) {
  const probe = await browser.newPage();
  const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace("HeadlessChrome", "Chrome");

  await probe.close();

  const context = await browser.newContext({
    baseURL,
    userAgent,
    extraHTTPHeaders: { "x-forwarded-for": uniqueIp() },
  });

  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
  });

  return { context, page: await context.newPage() };
}
